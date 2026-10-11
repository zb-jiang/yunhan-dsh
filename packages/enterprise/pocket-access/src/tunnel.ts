/**
 * 公网隧道层（pocket-access-design M3 §6.6/§6.8）：cloudflared 子进程生命周期与状态文件。
 *
 * 两种模式：
 * - quick：快速隧道（trycloudflare），无需账号，URL 随机分配；
 * - named：命名隧道，hostname + Tunnel token（经 `TUNNEL_TOKEN` 环境变量注入，不走 argv）。
 *
 * 二进制解析顺序：显式配置路径 → PATH 探测（win32 查 cloudflared.exe，其余查 cloudflared）。
 * 不做自动下载与缓存——cloudflared 由用户手工安装，PATH 无可执行文件时抛 TunnelRequestError
 * （安装指引经管理路由 400 直达设置页）。
 *
 * 自动恢复标记 tunnel-marker.json 只在用户手动 start 成功（就绪）后写入；
 * 手动停/总开关关时删除，进程 dispose（被动消失）或自动恢复失败时保留，
 * 下次启动据此免 disclaimer 自动拉起隧道。标记读写经串行队列防交错。
 *
 * @module @deepseek-ai/dsh-pocket-access/tunnel
 */
import { readFile, unlink } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { POCKET_ACCESS_DIR_NAME, writeFileAtomic } from './state.ts'

/** tunnel-token.json 文件名（命名隧道凭据，0600）。 */
export const TUNNEL_TOKEN_FILE_NAME = 'tunnel-token.json'

/** tunnel-marker.json 文件名（自动恢复标记）。 */
export const TUNNEL_MARKER_FILE_NAME = 'tunnel-marker.json'

/** 等待隧道就绪的超时（快速隧道分配 URL / 命名隧道注册连接）。 */
export const TUNNEL_READY_TIMEOUT_MS = 30_000

/** terminate 后等待子进程退出的宽限。 */
const TUNNEL_TERM_GRACE_MS = 3_000

/** 快速隧道 URL 提取正则（负向前瞻排除 api.trycloudflare.com 误报）。 */
export const TUNNEL_URL_PATTERN = /https:\/\/(?!api\.trycloudflare\.com)[a-z0-9-]+\.trycloudflare\.com/i

/** 命名隧道就绪判据（cloudflared stderr）。 */
const NAMED_READY_PATTERN = /Registered tunnel connection/

/** 启动参数错误的特征（用于摘要取整行）。 */
const PARAM_ERROR_PATTERN = /flag provided but not defined|Incorrect usage|invalid value/i

/** 就绪扫描输出缓冲上限（防长输出撑内存，保留尾部足够匹配 URL/注册行）。 */
const READY_SCAN_BUFFER_CAP = 16_000

/** 隧道模块依赖的日志面（结构兼容 cordis Logger）。 */
export interface TunnelLogger {
  info(message?: unknown, ...args: unknown[]): void
  warn(message?: unknown, ...args: unknown[]): void
  error(message?: unknown, ...args: unknown[]): void
}

/** 隧道模式。 */
export type TunnelMode = 'quick' | 'named'

/** 隧道运行状态。 */
export type TunnelState = 'idle' | 'starting' | 'running' | 'error'

/** 快照中的隧道块（§7.4）。 */
export interface TunnelSnapshot {
  /** 用户开关意愿（管理面板持久化值，由快照组装方传入）。 */
  enabled: boolean
  /** 运行状态。 */
  state: TunnelState
  /** 隧道模式。 */
  mode: TunnelMode
  /** 快速隧道分配的公网 URL；命名隧道与未运行为 null。 */
  url: string | null
  /** 命名隧道地址（归一化前展示配置原值）。 */
  hostname: string
  /** Tunnel token 是否已配置（只回显布尔，token 本体不出快照）。 */
  tokenSet: boolean
  /** 最近一次失败摘要（参数错误取命中行，否则尾部 4 行）。 */
  detail: string
  /** 本次运行开始时间（epoch 毫秒）；未运行为 0。 */
  startedAt: number
}

/** 隧道启动前置校验失败（管理路由转 HTTP 400）。 */
export class TunnelRequestError extends Error {
  /**
   * @param message - 面向设置页的中文失败原因。
   */
  constructor(message: string) {
    super(message)
    this.name = 'TunnelRequestError'
  }
}

/**
 * 启动参数构造：`--no-autoupdate` 与 `--protocol http2` 均为全局/子命令位置参数。
 * Token 走环境变量，绝不进 argv（进程列表可见）。
 *
 * @param binaryPath - cloudflared 可执行文件路径。
 * @param mode - 隧道模式。
 * @param proxyPort - 本地代理监听端口（快速隧道回源目标）。
 * @returns 完整 argv。
 */
export function tunnelArgv(binaryPath: string, mode: TunnelMode, proxyPort: number): readonly string[] {
  const base = [binaryPath, '--no-autoupdate', 'tunnel']
  if (mode === 'quick') {
    return [...base, '--url', `http://127.0.0.1:${String(proxyPort)}`, '--protocol', 'http2']
  }
  return [...base, 'run', '--protocol', 'http2']
}

/**
 * 失败摘要：参数错误（用户可自助修复）取首个命中行，否则取尾部 4 行；整体截 500 字符。
 *
 * @param output - 子进程合并输出（stdout + stderr）。
 * @returns 单行拼接的摘要；空输入返回 ''。
 */
export function summarizeTunnelFailure(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  if (lines.length === 0) return ''
  const paramLine = lines.find(line => PARAM_ERROR_PATTERN.test(line))
  const picked = paramLine !== undefined ? [paramLine] : lines.slice(-4)
  return picked.join(' | ').slice(0, 500)
}

/**
 * 命名隧道地址归一化：剥协议/路径/端口 → 小写 → 至少 2 个 label →
 * label 格式校验 → 末 label 全数字按裸 IP 拒绝。
 *
 * @param raw - 用户输入的 hostname（可带协议/路径/端口）。
 * @returns 归一化后的 hostname；不合法返回 null。
 */
export function normalizeTunnelHostname(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  value = value.replace(/^https?:\/\//, '')
  value = value.split('/')[0] ?? ''
  value = value.split(':')[0] ?? ''
  if (value === '') return null
  const labels = value.split('.')
  if (labels.length < 2) return null
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null
  }
  const last = labels[labels.length - 1]
  if (last !== undefined && /^\d+$/.test(last)) return null
  return value
}

/**
 * tunnel-token.json 落盘路径。
 *
 * @returns `$DSH_HOME/pocket-access/tunnel-token.json` 绝对路径。
 */
export function tunnelTokenFilePath(): string {
  return dshHomePath(POCKET_ACCESS_DIR_NAME, TUNNEL_TOKEN_FILE_NAME)
}

/**
 * tunnel-marker.json 落盘路径。
 *
 * @returns `$DSH_HOME/pocket-access/tunnel-marker.json` 绝对路径。
 */
export function tunnelMarkerFilePath(): string {
  return dshHomePath(POCKET_ACCESS_DIR_NAME, TUNNEL_MARKER_FILE_NAME)
}

/**
 * cloudflared 二进制解析：显式配置路径 → PATH 探测（win32 查 cloudflared.exe，其余查 cloudflared）。
 * 不做自动下载——cloudflared 由用户手工安装（winget/brew/官网安装包），程序只探测。
 *
 * @param options - configuredPath（Config cloudflaredPath，'' 表示走 PATH 探测）、subprocess、logger。
 * @returns 可执行文件绝对路径。
 * @throws PATH 中无 cloudflared 时抛 TunnelRequestError（含手工安装指引，经管理路由 400 直达设置页）。
 */
export async function resolveCloudflaredBinary(options: {
  configuredPath: string
  subprocess: SubprocessRuntime
  logger: TunnelLogger
}): Promise<string> {
  const explicit = options.configuredPath.trim()
  if (explicit !== '') return explicit
  const pathName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  try {
    return await options.subprocess.resolveExecutable(pathName)
  } catch (error) {
    options.logger.info(`pocket-access: PATH 中未找到 ${pathName}`, error)
    throw new TunnelRequestError(
      '未在 PATH 中找到 cloudflared 可执行文件，无法开启公网访问。' +
        '请先手工安装：Windows 运行 winget install --id Cloudflare.cloudflared，' +
        'macOS 运行 brew install cloudflared，' +
        '或从 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载安装；' +
        '装好后重启 DSH，也可在本设置页填写 cloudflared 完整路径。',
    )
  }
}

/**
 * 等待隧道就绪：扫描 stdout + stderr，快速隧道以 URL 正则命中为准，
 * 命名隧道以 `Registered tunnel connection` 为准；30s 超时或进程提前退出都转为失败
 * （失败信息携带输出摘要）。就绪后摘除 data 监听并 `resume()` 流，
 * 防止管道水位积压阻塞子进程输出。
 *
 * @param handle - 已 spawn 的子进程句柄。
 * @param options - mode（就绪判据）与 timeoutMs。
 * @returns 快速隧道命中 URL 与扫描期累积输出的尾部。
 */
export function waitForTunnelReady(
  handle: SubprocessHandle,
  options: { mode: TunnelMode; timeoutMs: number },
): Promise<{ url: string | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const streams = [handle.stdout, handle.stderr].filter((stream): stream is Readable => stream !== undefined)
    let buffer = ''
    let settled = false
    const finish = (settle: (value: { url: string | null; tail: string }) => void, value: { url: string | null; tail: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const stream of streams) {
        stream.off('data', onData)
        stream.resume()
      }
      settle(value)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const stream of streams) stream.off('data', onData)
      reject(error)
    }
    const onData = (chunk: string | Buffer): void => {
      buffer = `${buffer}${chunk.toString()}`.slice(-READY_SCAN_BUFFER_CAP)
      if (options.mode === 'quick') {
        const url = TUNNEL_URL_PATTERN.exec(buffer)?.[0]
        if (url !== undefined) finish(resolve, { url, tail: buffer })
      } else if (NAMED_READY_PATTERN.test(buffer)) {
        finish(resolve, { url: null, tail: buffer })
      }
    }
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      const summary = summarizeTunnelFailure(buffer)
      fail(new Error(`等待隧道就绪超时（${String(options.timeoutMs)}ms）${summary === '' ? '，子进程无输出' : `。输出摘要：${summary}`}`))
    }, options.timeoutMs)
    void handle.done.then(
      (outcome) => {
        const summary = summarizeTunnelFailure(buffer)
        fail(
          new Error(
            `隧道进程提前退出（exit=${String(outcome.exitCode)} signal=${String(outcome.signal)}）${summary === '' ? '' : `。输出摘要：${summary}`}`,
          ),
        )
      },
      (error: unknown) => {
        fail(new Error(`隧道进程启动失败：${error instanceof Error ? error.message : String(error)}`))
      },
    )
    for (const stream of streams) {
      stream.setEncoding('utf8')
      stream.on('data', onData)
    }
  })
}

/** tunnel-token.json 持久化结构。 */
interface TunnelTokenFile {
  token: string
}

/**
 * 命名隧道 Token 存储：`$DSH_HOME/pocket-access/tunnel-token.json`（0600）。
 * token 本体只在内存与文件中流转，快照只回显 tokenSet 布尔。
 */
export class TunnelTokenStore {
  private token: string | null = null

  constructor(
    private readonly logger: TunnelLogger,
    private readonly filePath: string = tunnelTokenFilePath(),
  ) {}

  /** 启动时加载：缺失或损坏回 null 并告警，不抛错。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      this.token = null
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TunnelTokenFile>
      this.token = typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : null
      if (this.token === null) this.logger.warn(`pocket-access: tunnel-token.json 结构不合法，已忽略：${this.filePath}`)
    } catch {
      this.token = null
      this.logger.warn(`pocket-access: tunnel-token.json 损坏，已忽略：${this.filePath}`)
    }
  }

  /**
   * token 是否已配置。
   *
   * @returns 已配置（load 读入或 set 过）为 true；未加载或已清除为 false。
   */
  hasToken(): boolean {
    return this.token !== null
  }

  /**
   * 供子进程环境变量读取的当前 token；未设置为 null。
   *
   * @returns 当前 token；未设置时 null（调用方需自行兜底）。
   */
  currentToken(): string | null {
    return this.token
  }

  /**
   * 保存 token（0600 原子写）。
   *
   * @param token - 用户粘贴的 Tunnel token（首尾空白去除后保存，空串视为非法）。
   */
  async set(token: string): Promise<void> {
    const trimmed = token.trim()
    if (trimmed === '') throw new TunnelRequestError('Tunnel token 不能为空')
    this.token = trimmed
    const record: TunnelTokenFile = { token: trimmed }
    await writeFileAtomic(this.filePath, `${JSON.stringify(record, null, 2)}\n`)
  }

  /** 清除 token（文件缺失忽略）。 */
  async clear(): Promise<void> {
    this.token = null
    await unlink(this.filePath).catch(() => {})
  }
}

/** tunnel-marker.json 持久化结构。 */
interface TunnelMarkerFile {
  mode: TunnelMode
  startedAt: number
}

/**
 * 自动恢复标记存储：tunnel-marker.json（0600）。
 * 所有读写经串行 promise 队列，防 start 就绪写与 stop 删除交错。
 */
export class TunnelMarkerStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string = tunnelMarkerFilePath()) {}

  /** 串行执行标记操作（前序失败不阻断后续）。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 标记是否存在（文件缺失或损坏均视为不存在）。
   *
   * @returns 标记文件存在且结构合法为 true；缺失、不可读或结构非法为 false。
   */
  async present(): Promise<boolean> {
    return this.enqueue(async () => {
      let raw: string
      try {
        raw = await readFile(this.filePath, 'utf8')
      } catch {
        return false
      }
      try {
        const parsed = JSON.parse(raw) as Partial<TunnelMarkerFile>
        return (parsed.mode === 'quick' || parsed.mode === 'named') && typeof parsed.startedAt === 'number'
      } catch {
        return false
      }
    })
  }

  /**
   * 写入标记（0600 原子写）。
   *
   * @param mode - 本次手动启动成功的隧道模式。
   * @param startedAt - 本次启动时间（epoch 毫秒）。
   */
  async write(mode: TunnelMode, startedAt: number): Promise<void> {
    return this.enqueue(async () => {
      const record: TunnelMarkerFile = { mode, startedAt }
      await writeFileAtomic(this.filePath, `${JSON.stringify(record, null, 2)}\n`)
    })
  }

  /** 删除标记（文件缺失忽略）。 */
  async remove(): Promise<void> {
    return this.enqueue(async () => {
      await unlink(this.filePath).catch(() => {})
    })
  }
}

/** TunnelManager 依赖（全部显式注入，便于测试替身）。 */
export interface TunnelManagerOptions {
  subprocess: SubprocessRuntime
  logger: TunnelLogger
  /** 当前隧道模式（Config 读取函数）。 */
  mode: () => TunnelMode
  /** 当前命名隧道地址原始配置。 */
  hostname: () => string
  /** 显式 cloudflared 路径配置（'' 表示自动）。 */
  cloudflaredPath: () => string
  /** 代理是否运行中（隧道前置条件）。 */
  proxyRunning: () => boolean
  /** 代理监听端口；未运行为 null。 */
  proxyPort: () => number | null
  tokenStore: TunnelTokenStore
  markerStore: TunnelMarkerStore
}

/**
 * 隧道生命周期管理：状态机 idle|starting|running|error。
 *
 * - start 单飞：进行中的启动被后续调用复用；
 * - stop/start 竞态：stopRequested 标志 + 引用比对，stop 终止进行中的启动并把状态收敛为 idle；
 * - 意外退出：running 期进程退出 → error 态 + 输出摘要，自动恢复标记保留（下次启动重试）；
 * - 手动 start 成功（就绪）才写自动恢复标记；autoRestore 场景不写（标记已存在）。
 */
export class TunnelManager {
  private stateValue: TunnelState = 'idle'
  private urlValue: string | null = null
  private detailValue = ''
  private startedAtValue = 0
  private handle: SubprocessHandle | null = null
  private startPromise: Promise<void> | null = null
  private stopRequested = false

  constructor(private readonly options: TunnelManagerOptions) {}

  /** 当前状态。 */
  get state(): TunnelState {
    return this.stateValue
  }

  /** 快速隧道公网 URL；命名隧道与未运行为 null。 */
  get url(): string | null {
    return this.urlValue
  }

  /**
   * 组装快照隧道块（enabled 为用户开关意愿，由组装方传入）。
   *
   * @param enabled - 用户开关意愿（管理面板持久化值）。
   * @returns 当前隧道状态快照（token 本体不进快照，仅回显 tokenSet 布尔）。
   */
  snapshot(enabled: boolean): TunnelSnapshot {
    return {
      enabled,
      state: this.stateValue,
      mode: this.options.mode(),
      url: this.urlValue,
      hostname: this.options.hostname().trim(),
      tokenSet: this.options.tokenStore.hasToken(),
      detail: this.detailValue,
      startedAt: this.startedAtValue,
    }
  }

  /**
   * 启动隧道（单飞）。手动启动必须携带 disclaimer:true（服务端强制，防绕过前端直调）；
   * autoRestore（自动恢复）免除 disclaimer——上次启动已确认过。
   *
   * @param options - disclaimer 用户确认标志；autoRestore 是否自动恢复场景。
   * @throws TunnelRequestError 前置校验失败；其他错误为解析/spawn/就绪失败（状态已置 error）。
   */
  start(options: { disclaimer: boolean; autoRestore?: boolean }): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    // stopRequested 保持 true 到这里才复位：doStart 的 catch 与就绪分流靠它识别 stop 意图
    this.stopRequested = false
    this.startPromise = this.doStart({ disclaimer: options.disclaimer, autoRestore: options.autoRestore ?? false }).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  /**
   * 同步前置校验：管理路由在 fire-and-forget 启动前调用它以获得 400 语义，
   * doStart 亦复用（同一套校验，避免路由放行后异步启动才失败）。
   *
   * @param options - disclaimer 用户确认标志；autoRestore 是否自动恢复场景（免除 disclaimer）。
   * @returns 校验通过后的回源端口与隧道模式（doStart 以此构造启动参数）。
   * @throws TunnelRequestError 免责确认缺失、代理未运行、端口不可用、命名隧道配置不完整。
   */
  validateStart(options: { disclaimer: boolean; autoRestore: boolean }): { proxyPort: number; mode: TunnelMode } {
    if (!options.autoRestore && !options.disclaimer) {
      throw new TunnelRequestError('缺少免责确认（disclaimer），拒绝启动公网隧道')
    }
    if (!this.options.proxyRunning()) {
      throw new TunnelRequestError('手机访问代理未运行，请先开启总开关')
    }
    const proxyPort = this.options.proxyPort()
    if (proxyPort === null) {
      throw new TunnelRequestError('代理端口不可用，无法确定回源目标')
    }
    const mode = this.options.mode()
    if (mode === 'named') {
      if (normalizeTunnelHostname(this.options.hostname()) === null) {
        throw new TunnelRequestError('命名隧道地址无效：需要形如 example.example.com 的域名（不接受裸 IP 或单段主机名）')
      }
      if (!this.options.tokenStore.hasToken()) {
        throw new TunnelRequestError('命名隧道缺少 Tunnel token，请先在设置页粘贴')
      }
    }
    return { proxyPort, mode }
  }

  private async doStart(options: { disclaimer: boolean; autoRestore: boolean }): Promise<void> {
    const { proxyPort, mode } = this.validateStart(options)
    if (this.stateValue === 'running' && this.handle !== null) return

    this.stateValue = 'starting'
    this.detailValue = ''
    let binaryPath: string
    try {
      binaryPath = await resolveCloudflaredBinary({
        configuredPath: this.options.cloudflaredPath(),
        subprocess: this.options.subprocess,
        logger: this.options.logger,
      })
    } catch (error) {
      this.stateValue = 'error'
      this.detailValue = error instanceof Error ? error.message : String(error)
      throw error
    }

    const env = mode === 'named' ? { TUNNEL_TOKEN: this.options.tokenStore.currentToken() ?? '' } : undefined
    let handle: SubprocessHandle
    try {
      handle = this.options.subprocess.spawn({
        argv: tunnelArgv(binaryPath, mode, proxyPort),
        cwd: dshHomePath(POCKET_ACCESS_DIR_NAME),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: TUNNEL_TERM_GRACE_MS,
        env,
      })
    } catch (error) {
      this.stateValue = 'error'
      this.detailValue = error instanceof Error ? error.message : String(error)
      throw error
    }
    this.handle = handle
    const startedAt = Date.now()
    try {
      const ready = await waitForTunnelReady(handle, { mode, timeoutMs: TUNNEL_READY_TIMEOUT_MS })
      if (this.handle !== handle || this.stopRequested) {
        // 启动期间被 stop/dispose 接管：终止进程并收敛为 idle，不覆盖接管方的状态
        handle.terminate()
        await handle.done.catch(() => {})
        if (this.handle === handle) this.handle = null
        this.stateValue = 'idle'
        return
      }
      this.stateValue = 'running'
      this.urlValue = ready.url
      this.startedAtValue = startedAt
      this.detailValue = ''
      // 自动恢复场景标记已存在不重写；手动启动成功（就绪）才写，spawn 失败不留标记
      if (!options.autoRestore) {
        await this.options.markerStore.write(mode, startedAt)
      }
    } catch (error) {
      handle.terminate()
      await handle.done.catch(() => {})
      if (this.handle === handle) this.handle = null
      if (this.stopRequested) {
        this.stateValue = 'idle'
        return
      }
      this.stateValue = 'error'
      this.detailValue = error instanceof Error ? error.message : String(error)
      throw error
    }
    // running 期意外退出：error 态 + 摘要；标记保留供下次启动自动重试
    void handle.done.then(
      (outcome: SubprocessOutcome) => {
        this.onExited(handle, outcome)
      },
      (error: unknown) => {
        this.onExited(handle, null, error)
      },
    )
  }

  /** running 期退出处理：仅当句柄仍归属自己（未被 stop/新 start 接管）才置 error。 */
  private onExited(handle: SubprocessHandle, outcome: SubprocessOutcome | null, error?: unknown): void {
    if (this.handle !== handle) return
    this.handle = null
    if (this.stopRequested) {
      this.stateValue = 'idle'
      return
    }
    const cause =
      error instanceof Error
        ? error.message
        : outcome !== null
          ? `exit=${String(outcome.exitCode)} signal=${String(outcome.signal)}`
          : '未知原因'
    this.stateValue = 'error'
    this.detailValue = `隧道进程意外退出（${cause}）；自动恢复标记已保留，重启应用后自动重试`
  }

  /**
   * 手动停止：终止进程、状态收敛 idle 并删除自动恢复标记（用户主动语义）。
   * 与进行中的 start 竞态安全（见 doStart 的 stopRequested 分流）。
   */
  async stop(): Promise<void> {
    await this.shutdown(true)
  }

  /**
   * 随宿主卸载的清理：终止进程但不删标记——被动消失（非用户操作），
   * 下次启动据标记自动拉起（免 disclaimer）。
   */
  async disposeKeepMarker(): Promise<void> {
    await this.shutdown(false)
  }

  private async shutdown(removeMarker: boolean): Promise<void> {
    this.stopRequested = true
    const handle = this.handle
    this.handle = null
    if (handle !== null) {
      handle.terminate()
      await handle.done.catch(() => {})
    }
    // stopRequested 保持 true 到下次 start 单飞入口才复位：doStart 的 catch 与就绪分流
    // 靠它识别 stop 意图，此处提前复位会让「start 期间 stop」竞态误判为意外失败。
    this.stateValue = 'idle'
    this.urlValue = null
    this.startedAtValue = 0
    if (removeMarker) await this.options.markerStore.remove()
  }

  /**
   * 启动时自动恢复：标记存在则免 disclaimer 拉起隧道；失败保留标记供下次重试（不抛出）。
   */
  async autoRestore(): Promise<void> {
    if (!(await this.options.markerStore.present())) return
    this.options.logger.info('pocket-access: 检测到自动恢复标记，正在拉起公网隧道')
    try {
      await this.start({ disclaimer: true, autoRestore: true })
    } catch (error) {
      this.options.logger.warn('pocket-access: 公网隧道自动恢复失败，标记保留，下次启动重试', error)
    }
  }
}
