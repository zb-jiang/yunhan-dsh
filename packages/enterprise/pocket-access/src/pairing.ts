/**
 * 闸门一：配对码生成与校验、设备 cookie 签发与校验、设备清单管理、配对尝试限速。
 *
 * 配对码一次性、单活跃码（新码作废旧码）；设备 cookie = `<deviceId>.<HMAC-SHA256(deviceId, secret)>`；
 * 校验 = 签名有效且 deviceId 在活跃清单中。限速三通道（POST 表单 / URL code / WS query）共用
 * 同一计数器，锁定期内不做比对；无凭据访问与 cookie 失配不计失败（仅提交了错误配对码才计）。
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DeviceStore, PairedDeviceSource } from './state.ts'

/** 配对码长度。 */
export const PAIRING_CODE_LENGTH = 8

/** 配对码字符表（去除 0/O/1/I/l 易混淆字符）。 */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** 配对码有效期（毫秒，5 分钟）。 */
export const PAIRING_TTL_MS = 300_000

/** 已配对设备上限。 */
export const MAX_DEVICES = 10

/** 设备 cookie 名。 */
export const DEVICE_COOKIE_NAME = 'dsh-pocket-device'

/** 设备 cookie 有效期（秒，30 天）。 */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** 单 IP 失败阈值（60s 窗口内）。 */
export const RATE_LIMIT_PER_IP_MAX_FAILURES = 5

/** 单 IP 锁定时长（毫秒）。 */
export const RATE_LIMIT_PER_IP_LOCK_MS = 60_000

/** 全局失败阈值（60s 窗口内）。 */
export const RATE_LIMIT_GLOBAL_MAX_FAILURES = 50

/** 全局锁定时长（毫秒）。 */
export const RATE_LIMIT_GLOBAL_LOCK_MS = 30_000

/** 失败计数窗口（毫秒）。 */
export const RATE_LIMIT_WINDOW_MS = 60_000

/**
 * 用 CSPRNG 生成 8 字符配对码（禁止伪随机源，由源码守卫测试防回归）。
 * @returns 从 PAIRING_CODE_ALPHABET 随机抽取的 8 字符配对码
 */
export function generatePairingCode(): string {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length))
  }
  return code
}

/**
 * 常量时间字符串比较；长度不同直接不等（码长与签名长度均为公开常量，不泄露信息）。
 * @param a 待比较的字符串
 * @param b 待比较的字符串
 * @returns 两者逐字节相等时为 true
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** 失败计数条目：窗口起点与锁定截止。 */
interface FailureEntry {
  count: number
  windowStart: number
  lockedUntil: number
}

/** 限速查询结果。 */
export interface RateLimitCheck {
  limited: boolean
  /** 限流时距锁定的剩余毫秒数；未限流为 0。 */
  retryAfterMs: number
}

/** FailureCounter 的阈值配置。 */
export interface FailureCounterOptions {
  /** 单窗口内允许的最大失败次数，达到即进入锁定。 */
  maxFailures: number
  /** 失败计数窗口时长（毫秒）。 */
  windowMs: number
  /** 达到阈值后的锁定时长（毫秒）。 */
  lockMs: number
}

/**
 * 固定窗口失败计数器：窗口内累计失败达阈值即锁定 lockMs；锁定期结束后窗口已滚动，条目作废重来。
 * 条目在窗口滚动后被惰性清除。
 */
export class FailureCounter {
  private readonly entries = new Map<string, FailureEntry>()

  constructor(private readonly options: FailureCounterOptions) {}

  /**
   * key 是否处于锁定期（锁定期内调用方必须拒绝且不得比对）。
   * @param key 限速主体标识（IP 或固定 key）
   * @param now 当前时间（epoch 毫秒）
   * @returns 该 key 的限速判定结果；limited 为 true 时 retryAfterMs 为距解锁的剩余毫秒数
   */
  check(key: string, now: number): RateLimitCheck {
    const entry = this.entries.get(key)
    if (!entry) return { limited: false, retryAfterMs: 0 }
    if (now < entry.lockedUntil) {
      return { limited: true, retryAfterMs: entry.lockedUntil - now }
    }
    if (now - entry.windowStart >= this.options.windowMs) {
      this.entries.delete(key)
    }
    return { limited: false, retryAfterMs: 0 }
  }

  /**
   * 记一次失败；窗口内达到阈值即锁定。
   * @param key 限速主体标识（IP 或固定 key）
   * @param now 当前时间（epoch 毫秒）
   */
  recordFailure(key: string, now: number): void {
    const entry = this.entries.get(key)
    if (!entry || now - entry.windowStart >= this.options.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now, lockedUntil: 0 })
      return
    }
    entry.count += 1
    if (entry.count >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.lockMs
    }
  }

  /**
   * 成功清零该 key 的失败计数（全局计数器不调用——跨 IP 总闸不因单次成功重置）。
   * @param key 限速主体标识
   */
  recordSuccess(key: string): void {
    this.entries.delete(key)
  }
}

/** 活跃配对码。 */
export interface ActivePairingCode {
  code: string
  /** 过期时间（epoch 毫秒）。 */
  expiresAt: number
}

/**
 * 设备 cookie 校验结果：失败按原因细分，供闸门一 401 区分「配对已撤销」与
 * 「未配对/已清除」（桌面登出清空后记录不存在，与从未配对同形态，无法再分）。
 */
export type DeviceCookieCheck =
  | { ok: true; deviceId: string }
  | { ok: false; reason: 'revoked' | 'unpaired' }

/** 配对尝试结果。 */
export type PairingAttemptResult =
  | { ok: true; deviceId: string; cookie: string }
  | {
    ok: false
    reason: 'rate-limited' | 'invalid-code' | 'no-active-code' | 'max-devices'
    /** reason 为 rate-limited 时提供。 */
    retryAfterMs?: number
  }

/** 全局失败计数器的固定 key。 */
const GLOBAL_FAILURE_KEY = '__global__'

/**
 * 配对与设备管理器：持有 DeviceStore，负责配对码生命周期、设备签发/校验/吊销与限速。
 * 所有变更立即经 DeviceStore.save() 持久化。
 */
export class PairingManager {
  private activeCode: ActivePairingCode | null = null
  private readonly perIpFailures = new FailureCounter({
    maxFailures: RATE_LIMIT_PER_IP_MAX_FAILURES,
    windowMs: RATE_LIMIT_WINDOW_MS,
    lockMs: RATE_LIMIT_PER_IP_LOCK_MS,
  })
  private readonly globalFailures = new FailureCounter({
    maxFailures: RATE_LIMIT_GLOBAL_MAX_FAILURES,
    windowMs: RATE_LIMIT_WINDOW_MS,
    lockMs: RATE_LIMIT_GLOBAL_LOCK_MS,
  })

  constructor(
    private readonly store: DeviceStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 生成新配对码（作废旧码），返回码与过期时间。
   * @returns 新配对码及其过期时间（epoch 毫秒）
   */
  createPairingCode(): ActivePairingCode {
    this.activeCode = { code: generatePairingCode(), expiresAt: this.now() + PAIRING_TTL_MS }
    return { ...this.activeCode }
  }

  /**
   * 当前有效配对码；过期或未生成返回 null。
   * @returns 当前配对码的副本；未生成或已过期时为 null（过期同时清除内部活跃码）
   */
  getActivePairingCode(): ActivePairingCode | null {
    if (this.activeCode === null) return null
    if (this.now() >= this.activeCode.expiresAt) {
      this.activeCode = null
      return null
    }
    return { ...this.activeCode }
  }

  /**
   * 签发设备 cookie 值 `<deviceId>.<HMAC>`。
   * @param deviceId 设备唯一标识
   * @returns 形如 `<deviceId>.<HMAC-SHA256>` 的 cookie 值
   */
  signDeviceCookie(deviceId: string): string {
    return `${deviceId}.${this.hmacDevice(deviceId)}`
  }

  /**
   * 校验设备 cookie：签名有效且 deviceId 在活跃清单中。
   * 失败细分：签名有效但记录已吊销 → 'revoked'；其余（未配对、签名失效、
   * 记录不存在——桌面登出清空后即此形态）→ 'unpaired'。
   * @param cookieValue 请求中的设备 cookie 值；undefined 或空视为未配对
   * @returns 校验结果；成功携带 deviceId，失败按 'revoked'/'unpaired' 细分
   */
  verifyDeviceCookie(cookieValue: string | undefined): DeviceCookieCheck {
    if (cookieValue === undefined || cookieValue === '') return { ok: false, reason: 'unpaired' }
    const dotIndex = cookieValue.indexOf('.')
    if (dotIndex <= 0) return { ok: false, reason: 'unpaired' }
    const deviceId = cookieValue.slice(0, dotIndex)
    const signature = cookieValue.slice(dotIndex + 1)
    if (!constantTimeEquals(this.hmacDevice(deviceId), signature)) return { ok: false, reason: 'unpaired' }
    const device = this.store.state.devices.find(entry => entry.id === deviceId)
    if (device === undefined) return { ok: false, reason: 'unpaired' }
    if (device.revokedAt !== null) return { ok: false, reason: 'revoked' }
    return { ok: true, deviceId }
  }

  /**
   * 提交配对码尝试（三通道共用）：限速 → 常量时间比对 → 焚码 → 设备签发。
   * 比对失败计入单 IP 与全局计数；成功清零该 IP 计数。
   * source 为本次配对的网络入口（调用方由来源分类映射），复用与新建都会把它
   * 记录为设备的最近入口；不传表示来源未知（记录保持缺失，UI 显示未知）。
   * @param submittedCode 用户提交的配对码原文
   * @param ip 提交方客户端 IP（单 IP 限速主体）
   * @param ua 提交方 User-Agent；同 UA 活跃设备复用记录而非新增，空字符串跳过复用
   * @param source 本次配对的网络入口；缺省表示来源未知
   * @returns 成功携带 deviceId 与已签发 cookie；失败按原因细分，rate-limited 附 retryAfterMs
   */
  async attemptPair(submittedCode: string, ip: string, ua: string, source?: PairedDeviceSource): Promise<PairingAttemptResult> {
    const now = this.now()
    const ipCheck = this.perIpFailures.check(ip, now)
    if (ipCheck.limited) return { ok: false, reason: 'rate-limited', retryAfterMs: ipCheck.retryAfterMs }
    const globalCheck = this.globalFailures.check(GLOBAL_FAILURE_KEY, now)
    if (globalCheck.limited) return { ok: false, reason: 'rate-limited', retryAfterMs: globalCheck.retryAfterMs }

    const active = this.getActivePairingCode()
    const matched = active !== null && constantTimeEquals(submittedCode, active.code)
    if (!matched) {
      this.perIpFailures.recordFailure(ip, now)
      this.globalFailures.recordFailure(GLOBAL_FAILURE_KEY, now)
      return { ok: false, reason: active === null ? 'no-active-code' : 'invalid-code' }
    }

    // 一次性：无论后续是否成功签发，码即焚毁
    this.activeCode = null
    this.perIpFailures.recordSuccess(ip)

    // 同 UA 活跃设备复用：设备 cookie 按 host 隔离，同一手机经局域网与公网两个入口会各配对一次；
    // UA 一致视为同一物理设备，复用记录（刷新 lastSeenAt）而不新增，也不受设备上限约束。
    const nowIso = new Date(now).toISOString()
    const existing = ua === '' ? undefined : this.store.state.devices.find(entry => entry.revokedAt === null && entry.ua === ua)
    if (existing !== undefined) {
      existing.lastSeenAt = nowIso
      if (source !== undefined) existing.source = source
      await this.store.save()
      return { ok: true, deviceId: existing.id, cookie: this.signDeviceCookie(existing.id) }
    }

    const activeCount = this.store.state.devices.filter(entry => entry.revokedAt === null).length
    if (activeCount >= MAX_DEVICES) {
      return { ok: false, reason: 'max-devices' }
    }

    const deviceId = randomUUID()
    // exactOptionalPropertyTypes：source 缺失时不得写入 undefined 键
    this.store.state.devices.push({
      id: deviceId,
      createdAt: nowIso,
      lastSeenAt: nowIso,
      ua,
      revokedAt: null,
      ...(source === undefined ? {} : { source }),
    })
    await this.store.save()
    return { ok: true, deviceId, cookie: this.signDeviceCookie(deviceId) }
  }

  /**
   * 吊销设备（即时生效）；设备不存在或已吊销返回 false。
   * @param deviceId 待吊销的设备唯一标识
   * @returns 实际执行了吊销时为 true；设备不存在或已吊销为 false
   */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const device = this.store.state.devices.find(entry => entry.id === deviceId && entry.revokedAt === null)
    if (device === undefined) return false
    device.revokedAt = new Date(this.now()).toISOString()
    await this.store.save()
    return true
  }

  /** 清空全部设备（signout 联动）。 */
  async clearAllDevices(): Promise<void> {
    this.store.state.devices = []
    await this.store.save()
  }

  /**
   * 更新设备 lastSeenAt（仅真实用户操作调用——WS/自动请求不续）。
   * @param deviceId 待续期的设备唯一标识；不存在或已吊销时不做任何操作
   */
  async touchDevice(deviceId: string): Promise<void> {
    const device = this.store.state.devices.find(entry => entry.id === deviceId && entry.revokedAt === null)
    if (device === undefined) return
    device.lastSeenAt = new Date(this.now()).toISOString()
    await this.store.save()
  }

  private hmacDevice(deviceId: string): string {
    return createHmac('sha256', this.store.state.secret).update(deviceId).digest('hex')
  }
}

/**
 * 构造设备 cookie 的 Set-Cookie 响应头值。
 * @param cookieValue 已签发的设备 cookie 值（signDeviceCookie 的返回值）
 * @returns 完整的 Set-Cookie 头值（含 Path、Max-Age、HttpOnly、SameSite 属性）
 */
export function deviceCookieSetCookie(cookieValue: string): string {
  return `${DEVICE_COOKIE_NAME}=${cookieValue}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict`
}
