/**
 * 审计上报（pocket-access-design §6.7）：访问事件 write-through 本地 backlog
 * 后批量上报 web-console，成功一批从 backlog 清除一批，失败缓冲等重放——审计不丢。
 *
 * 上报目标与登录态逐次读取（volatile 基地址 + 员工 JWT）：无登录态时事件只进
 * backlog，等登录后由设置页轮询或下一事件触发重放。backlog 上限 1000 条，
 * 溢出丢最旧并告警；文件为 `$DSH_HOME/pocket-access/audit-backlog.jsonl`。
 */
import { readFile } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { IdentityCheckFailureReason } from './identity.ts'
import { POCKET_ACCESS_DIR_NAME, writeFileAtomic } from './state.ts'

/** 审计 backlog 文件名（相对 $DSH_HOME/pocket-access）。 */
export const AUDIT_BACKLOG_FILE_NAME = 'audit-backlog.jsonl'

/** 单批上报事件数上限（web-console 请求体校验同值）。 */
export const AUDIT_BATCH_SIZE = 100

/** backlog 事件数上限；溢出丢最旧并告警。 */
export const AUDIT_BACKLOG_MAX = 1000

/** 上报失败后的重试间隔（毫秒）。 */
export const AUDIT_RETRY_DELAY_MS = 30_000

/** 审计事件类型全集（web-console 端 PocketAccessController 按此校验）。 */
export const POCKET_AUDIT_EVENT_TYPES = [
  'POCKET_ENABLED',
  'POCKET_DISABLED',
  'POCKET_DEVICE_PAIRED',
  'POCKET_DEVICE_REVOKED',
  'POCKET_IDENTITY_REJECTED',
  'POCKET_TUNNEL_STARTED',
  'POCKET_TUNNEL_STOPPED',
  'POCKET_LAN_DISABLED_HIT',
] as const

/** 审计事件类型。 */
export type PocketAuditEventType = (typeof POCKET_AUDIT_EVENT_TYPES)[number]

/** 待上报的访问审计事件（上报契约 §7.3：eventType / targetUserId? / details / occurredAt）。 */
export interface PocketAuditEvent {
  /** 事件类型（§6.7 枚举）。 */
  eventType: PocketAuditEventType
  /** 事件主体用户 id；缺省表示员工本人（operator 即本人）。 */
  targetUserId?: string
  /** 事件细节（ip、deviceId、reason 等要点，由触发方给定）。 */
  details: Record<string, unknown>
  /** 事件发生时刻（epoch 毫秒，进程本地生成）。 */
  occurredAt: number
}

/**
 * audit-backlog.jsonl 落盘路径。
 *
 * @returns backlog JSONL 文件路径（DSH home 目录下）。
 */
export function auditBacklogFilePath(): string {
  return dshHomePath(POCKET_ACCESS_DIR_NAME, AUDIT_BACKLOG_FILE_NAME)
}

/**
 * 解析 web-console 基地址：配置值 trim 后为空回退 `WEB_CONSOLE_URL` 环境变量，
 * 再为空回退默认本机地址；统一去尾斜杠。
 *
 * @param raw - Config `webConsoleBaseUrl` 当前值（'' 表示未配置）。
 * @returns 可直接拼路径的基地址（无尾斜杠）。
 */
export function resolveWebConsoleBaseUrl(raw: string): string {
  const configured = raw.trim() !== '' ? raw.trim() : process.env.WEB_CONSOLE_URL ?? ''
  const base = configured.trim() !== '' ? configured.trim() : 'http://127.0.0.1:8080'
  return base.replace(/\/+$/, '')
}

/**
 * 校验并解析一行 JSONL 为审计事件；结构不合法返回 null（调用方跳过该行）。
 *
 * @param line - 文件单行原文。
 * @returns 校验通过的事件对象；JSON 非法、eventType 不在枚举、details 非对象或 occurredAt 非数字时 null。
 */
export function parseAuditEvent(line: string): PocketAuditEvent | null {
  if (line.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.eventType !== 'string') return null
  if (!(POCKET_AUDIT_EVENT_TYPES as readonly string[]).includes(record.eventType)) return null
  if (typeof record.details !== 'object' || record.details === null || Array.isArray(record.details)) return null
  if (typeof record.occurredAt !== 'number' || !Number.isFinite(record.occurredAt)) return null
  if (record.targetUserId !== undefined && typeof record.targetUserId !== 'string') return null
  return {
    // includes 检查后 TS 无法窄化 string 到字面量联合，此处断言的是上面刚校验过的事实
    eventType: record.eventType as PocketAuditEventType,
    details: record.details as Record<string, unknown>,
    occurredAt: record.occurredAt,
    ...(record.targetUserId === undefined ? {} : { targetUserId: record.targetUserId }),
  }
}

/** 上报依赖面：基地址与登录态逐次读取（volatile 生效、登录后自动可报）。 */
export interface AuditReporterDeps {
  /** 当前 web-console 基地址（Config 原值，内部做 resolve）。 */
  getWebConsoleBaseUrl(): string
  /** 当前登录员工 JWT；未登录为 undefined（事件滞留 backlog 等重放）。 */
  getToken(): string | undefined
}

/**
 * 代理管线触发的审计事件回调面（proxy → PocketAccessService → AuditBacklog）。
 * 回调内 fire-and-forget：审计失败只告警，绝不影响代理请求处理。
 */
export interface PocketAuditSink {
  /**
   * 配对成功（HTTP 与 WS 两通道共用）。
   * @param deviceId - 新签发或复用的设备 id。
   * @param source - 本次配对的网络入口。
   * @param ip - 提交方客户端 IP。
   * @param ua - 提交方 User-Agent 原文（实现方负责截断摘要）。
   */
  devicePaired(deviceId: string, source: 'lan' | 'wan', ip: string, ua: string): void
  /**
   * 闸门二身份校验拒绝（同账号校验失败或桌面未登录）。
   * @param reason - 拒绝原因（identity-mismatch / desktop-login-required）。
   * @param ip - 提交方客户端 IP。
   * @param presentedUserId - 提交 token 解析出的用户 id；解析失败缺省（只进审计，不进响应）。
   */
  identityRejected(reason: IdentityCheckFailureReason, ip: string, presentedUserId?: string): void
  /**
   * 局域网开关关闭期间 LAN 来源请求被拒。
   * @param ip - 被拒方客户端 IP。
   */
  lanDisabledHit(ip: string): void
}

/** 上报失败语义：HTTP 非 2xx、网络失败或信封 success 非 true。 */
export class AuditReportError extends Error {}

/**
 * 上报一批事件到 web-console `POST /api/pocket/access-events`。
 *
 * @param baseUrl - web-console 基地址（无尾斜杠）。
 * @param token - 员工 Supabase JWT。
 * @param events - 本批事件（调用方保证 ≤100 条）。
 * @throws AuditReportError 网络失败、HTTP 非 2xx 或响应信封非成功时。
 */
export async function postAccessEvents(
  baseUrl: string,
  token: string,
  events: readonly PocketAuditEvent[],
): Promise<void> {
  let resp: Response
  try {
    resp = await fetch(new URL('/api/pocket/access-events', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
    })
  } catch (error) {
    throw new AuditReportError(`web-console 不可达(${baseUrl}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!resp.ok) {
    throw new AuditReportError(`web-console 审计上报失败: HTTP ${String(resp.status)}`)
  }
  let payload: unknown
  try {
    payload = await resp.json()
  } catch {
    throw new AuditReportError('web-console 审计上报响应不是合法 JSON')
  }
  if (!isSuccessEnvelope(payload)) {
    throw new AuditReportError('web-console 审计上报响应信封非成功')
  }
}

function isSuccessEnvelope(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const success = (payload as Record<string, unknown>).success
  return success === true
}

/** backlog 持久化与上报依赖的日志面（结构兼容 cordis Logger）。 */
export interface AuditBacklogLogger {
  warn(message?: unknown, ...args: unknown[]): void
}

/** 审计 backlog 依赖面。 */
export interface AuditBacklogDeps extends AuditReporterDeps {
  logger: AuditBacklogLogger
}

/**
 * 审计事件缓冲：内存清单为权威，record 时全量重写 JSONL（write-through），
 * flush 单飞逐批上报，成功一批重写剩余；失败停批并 30s 后重试。崩溃恢复靠
 * 启动时读文件回填内存。
 */
export class AuditBacklog {
  private events: PocketAuditEvent[] = []
  private loadPromise: Promise<void> | null = null
  private flushing = false
  private inFlight: Promise<void> = Promise.resolve()
  private retryTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly deps: AuditBacklogDeps,
    private readonly filePath: string = auditBacklogFilePath(),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * backlog 当前事件数。
   *
   * @returns 等待启动加载完成后的内存清单长度。
   */
  async backlogCount(): Promise<number> {
    await this.ensureLoaded()
    return this.events.length
  }

  /**
   * 记录一条事件：入内存清单（溢出丢最旧并告警）→ 全量重写 backlog 文件 →
   * 尝试上报。文件写失败不阻断事件入列（内存仍是权威，下次成功 flush 会重写修复）。
   *
   * @param eventType - 事件类型（§6.7 枚举）。
   * @param details - 事件细节要点。
   * @param targetUserId - 事件主体用户 id；缺省表示员工本人。
   */
  async record(eventType: PocketAuditEventType, details: Record<string, unknown>, targetUserId?: string): Promise<void> {
    await this.ensureLoaded()
    const event: PocketAuditEvent = {
      eventType,
      details,
      occurredAt: this.now(),
      ...(targetUserId === undefined ? {} : { targetUserId }),
    }
    this.events.push(event)
    if (this.events.length > AUDIT_BACKLOG_MAX) {
      const dropped = this.events.shift()
      this.deps.logger.warn(`pocket-access: 审计 backlog 超过 ${String(AUDIT_BACKLOG_MAX)} 条，丢弃最旧事件`, dropped?.eventType)
    }
    try {
      await this.persist()
    } catch (error) {
      this.deps.logger.warn('pocket-access: 审计 backlog 落盘失败', error)
    }
    void this.flush()
  }

  /** 触发一次重放（单飞；无基地址或未登录时静默返回）。设置页轮询与登录后重放入口。 */
  maybeFlush(): void {
    void this.flush()
  }

  /** 生命周期收尾：取消延迟重试并等待在途上报完成。 */
  async dispose(): Promise<void> {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    await this.inFlight
  }

  /** 启动加载：读 JSONL 回填内存（坏行跳过告警），文件缺失即空清单。单飞。 */
  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    return this.loadPromise
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      // 文件缺失（首次启动属正常路径）：空清单起底
      return
    }
    const events: PocketAuditEvent[] = []
    for (const line of raw.split('\n')) {
      const event = parseAuditEvent(line)
      if (event === null) {
        if (line.trim() !== '') this.deps.logger.warn(`pocket-access: 审计 backlog 存在无法解析的行，已跳过：${this.filePath}`)
        continue
      }
      events.push(event)
    }
    this.events = events
  }

  /** 内存清单全量重写 backlog 文件（JSONL，每事件一行）。 */
  private async persist(): Promise<void> {
    const body = this.events.map(event => JSON.stringify(event)).join('\n')
    const content = this.events.length === 0 ? '' : `${body}\n`
    await writeFileAtomic(this.filePath, content)
  }

  /**
   * 上报循环（单飞）：逐批 POST，成功一批从内存清除一批并重写文件；无基地址或
   * 未登录时返回（等登录后的下一次触发）；上报失败记录告警并安排 30s 重试。
   */
  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    const run = (async () => {
      try {
        await this.ensureLoaded()
        while (this.events.length > 0) {
          const baseUrl = resolveWebConsoleBaseUrl(this.deps.getWebConsoleBaseUrl())
          const token = this.deps.getToken()
          if (baseUrl === '' || token === undefined || token === '') return
          const batch = this.events.slice(0, AUDIT_BATCH_SIZE)
          await postAccessEvents(baseUrl, token, batch)
          this.events.splice(0, batch.length)
          try {
            await this.persist()
          } catch (error) {
            // 事件已送达，仅本地清除失败：不重试上报（避免重复），下次 flush 成功重写修复
            this.deps.logger.warn('pocket-access: 审计 backlog 清除失败', error)
          }
        }
      } catch (error) {
        this.deps.logger.warn('pocket-access: 审计上报失败，事件留 backlog 稍后重放', error)
        this.scheduleRetry()
      } finally {
        this.flushing = false
      }
    })()
    this.inFlight = run
    await run
  }

  /** 安排 30s 后重试（重复调度时覆盖旧定时器）。 */
  private scheduleRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush()
    }, AUDIT_RETRY_DELAY_MS)
    this.retryTimer.unref()
  }
}
