/**
 * 设备持久化层：已配对设备清单与配对密钥的读写。
 *
 * 文件位于 `$DSH_HOME/pocket-access/devices.json`；保存走「临时文件 + fsync + rename」
 * 原子替换，每次保存把文件权限归一为 0600；缺失或损坏时回退默认状态并告警，不抛错。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** devices.json 所在目录名（相对 $DSH_HOME）。 */
export const POCKET_ACCESS_DIR_NAME = 'pocket-access'

/** devices.json 文件名。 */
export const DEVICES_FILE_NAME = 'devices.json'

/** 设备来源：配对请求的网络入口分类（公网宿主以外的来源一律归局域网）。 */
export type PairedDeviceSource = 'lan' | 'wan'

/** 已配对设备记录。 */
export interface PairedDevice {
  /** 设备 id（CSPRNG UUID），设备 cookie 的第一段。 */
  id: string
  /** 配对完成时间（ISO-8601）。 */
  createdAt: string
  /** 最近一次认证通过时间（ISO-8601）。 */
  lastSeenAt: string
  /** 配对时浏览器 User-Agent。 */
  ua: string
  /** 撤销时间（ISO-8601）；未撤销为 null。 */
  revokedAt: string | null
  /** 最近一次配对（含复用）的网络入口；早于该字段引入的记录缺失，UI 显示未知。 */
  source?: PairedDeviceSource
}

/** devices.json 持久化结构。 */
export interface PocketAccessState {
  /** 配对密钥：设备 cookie 的 HMAC-SHA256 签名钥。 */
  secret: string
  /** 已配对设备清单。 */
  devices: PairedDevice[]
}

/** 持久化层依赖的日志面（结构兼容 cordis Logger）。 */
export interface DeviceStoreLogger {
  warn(message?: unknown, ...args: unknown[]): void
}

/**
 * 生成默认状态：新配对密钥（256 位 CSPRNG 十六进制）+ 空设备清单。
 *
 * @returns 携带全新 secret 与空设备清单的状态对象。
 */
export function createDefaultState(): PocketAccessState {
  return { secret: randomBytes(32).toString('hex'), devices: [] }
}

/**
 * devices.json 落盘路径。
 *
 * @returns `$DSH_HOME/pocket-access/devices.json` 绝对路径。
 */
export function devicesFilePath(): string {
  return dshHomePath(POCKET_ACCESS_DIR_NAME, DEVICES_FILE_NAME)
}

/**
 * 严格校验并解析 devices.json 内容；结构不合法返回 null（调用方回退默认状态）。
 *
 * @param raw - 文件原始文本。
 * @returns 校验通过的状态对象；JSON 非法或任何必填字段缺失/类型错误时 null。
 */
export function parseState(raw: string): PocketAccessState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.secret !== 'string' || record.secret.length === 0) return null
  if (!Array.isArray(record.devices)) return null
  const devices: PairedDevice[] = []
  for (const item of record.devices) {
    if (typeof item !== 'object' || item === null) return null
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id.length === 0) return null
    if (typeof entry.createdAt !== 'string' || entry.createdAt.length === 0) return null
    if (typeof entry.lastSeenAt !== 'string' || entry.lastSeenAt.length === 0) return null
    if (typeof entry.ua !== 'string') return null
    if (entry.revokedAt !== null && (typeof entry.revokedAt !== 'string' || entry.revokedAt.length === 0)) return null
    // source 旧记录缺失为 undefined；存在但非法同样视为缺失（不拒整文件，避免清单被重置）
    const source: PairedDeviceSource | undefined =
      entry.source === 'lan' || entry.source === 'wan' ? entry.source : undefined
    devices.push({
      id: entry.id,
      createdAt: entry.createdAt,
      lastSeenAt: entry.lastSeenAt,
      ua: entry.ua,
      revokedAt: entry.revokedAt,
      ...(source === undefined ? {} : { source }),
    })
  }
  return { secret: record.secret, devices }
}

/**
 * 原子写盘：临时文件（0600）+ fsync + rename 覆盖；隧道状态文件（tunnel-token.json / tunnel-marker.json）复用。
 *
 * @param filePath - 目标文件路径（所在目录不存在时自动递归创建）。
 * @param content - 写入内容（文本或字节）。
 */
export async function writeFileAtomic(filePath: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  const handle = await open(tmpPath, 'w', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmpPath, filePath)
  } catch (error) {
    // rename 失败时清理临时文件；清理失败可忽略，目标原文件未受影响
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * 设备持久化仓储：内存状态为唯一权威，save() 落盘，load() 启动时恢复。
 * 变更走「调用方修改 getState() 返回的对象，再调用 save()」。
 */
export class DeviceStore {
  private currentState: PocketAccessState = createDefaultState()

  constructor(
    private readonly logger: DeviceStoreLogger,
    private readonly filePath: string = devicesFilePath(),
  ) {}

  /** 当前内存状态；变更后必须调用 save() 才会持久化。 */
  get state(): PocketAccessState {
    return this.currentState
  }

  /** 启动时加载：缺失或损坏回默认状态并告警，不抛错。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      // 文件缺失（首次启动属正常路径）或不可读：以默认状态起底并落盘
      this.currentState = createDefaultState()
      await this.save()
      return
    }
    const parsed = parseState(raw)
    if (parsed === null) {
      this.logger.warn(`pocket-access 设备文件损坏，已重置为默认状态：${this.filePath}`)
      this.currentState = createDefaultState()
      await this.save()
      return
    }
    this.currentState = parsed
  }

  /** 将当前内存状态原子写盘。 */
  async save(): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(this.currentState, null, 2)}\n`)
  }
}
