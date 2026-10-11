/**
 * 闸门二：同账号身份严格镜像校验。
 *
 * 手机端携带的 Supabase Bearer token 经 `platformUsers.getUserByToken` 解析
 * （JWKS 验签 + 治理库读取，含网络调用），与桌面端当前登录员工比较。token → userId
 * 的解析结果做正向缓存（负向绝不缓存——避免攻击者用垃圾 token 打满缓存）；
 * 校验失败与 token 验证失败内部归并同一 reason，不回泄具体差异；对外文案见 `IDENTITY_REJECTION_MESSAGES`。
 */
import { createHash } from 'node:crypto'

/** 身份闸门失败原因（对外原因只有两种，具体差异只进日志/审计）。 */
export type IdentityCheckFailureReason = 'desktop-login-required' | 'identity-mismatch'

/** 失败原因 → 手机端直接渲染的对外文案（代理 403 响应体的 error 值）。 */
export const IDENTITY_REJECTION_MESSAGES: Record<IdentityCheckFailureReason, string> = {
  'desktop-login-required': '桌面端未登录，请先在电脑上登录 DSH 后再使用手机访问。',
  'identity-mismatch': '手机端登录账号与桌面当前登录账号不一致，请在手机上改用与电脑相同的账号登录。',
}

/** 正向缓存条目有效期（毫秒，5 分钟）。 */
export const IDENTITY_CACHE_TTL_MS = 5 * 60_000

/** 正向缓存容量上限（防异 token 打满，LRU 淘汰）。 */
export const IDENTITY_CACHE_MAX_ENTRIES = 128

/** 身份校验依赖面（结构兼容 ctx.currentUser / ctx.platformUsers）。 */
export interface IdentityCheckerDeps {
  /** 桌面端当前登录员工；未登录为 undefined。 */
  getCurrentUser(): { id: string } | undefined
  /** 通过 Supabase token 解析平台用户；token 无效或后端不可达时 reject。 */
  getUserByToken(token: string): Promise<{ id: string }>
}

/** 身份校验结论。 */
export type IdentityCheckResult =
  | { ok: true }
  | {
    ok: false
    reason: IdentityCheckFailureReason
    /** 提交 token 解析出的用户 id（只进日志/审计，不进响应体）；解析失败时缺省。 */
    presentedUserId?: string
  }

/** 缓存条目。 */
interface CacheEntry {
  userId: string
  /** 写入时刻（epoch 毫秒）。 */
  at: number
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 闸门二校验器：每次校验都与桌面当前身份实时比较，缓存只省 token 解析的网络调用。 */
export class IdentityChecker {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly deps: IdentityCheckerDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 校验手机端提交的 Bearer token 是否与桌面端登录员工同账号。
   * @param presentedToken - 手机端 Authorization 头剥去 Bearer 前缀后的纯 token。
   * @returns 校验结论：同账号为 `{ ok: true }`；桌面未登录为 `desktop-login-required`，
   * token 解析失败或账号不一致为 `identity-mismatch`（两者对外同一拒绝语义，不回泄差异）。
   */
  async check(presentedToken: string): Promise<IdentityCheckResult> {
    const desktopUser = this.deps.getCurrentUser()
    if (desktopUser === undefined) {
      return { ok: false, reason: 'desktop-login-required' }
    }

    const key = sha256Hex(presentedToken)
    const cached = this.cache.get(key)
    let presentedUserId: string
    if (cached !== undefined && this.now() - cached.at < IDENTITY_CACHE_TTL_MS) {
      // LRU 触碰：重新插入保持淘汰序
      this.cache.delete(key)
      this.cache.set(key, cached)
      presentedUserId = cached.userId
    } else {
      if (cached !== undefined) this.cache.delete(key)
      try {
        const user = await this.deps.getUserByToken(presentedToken)
        presentedUserId = user.id
        this.cacheSet(key, presentedUserId)
      } catch {
        // token 验证失败与账号不一致对外同一拒绝，不回泄差异；负向不写缓存
        return { ok: false, reason: 'identity-mismatch' }
      }
    }

    if (presentedUserId !== desktopUser.id) {
      return { ok: false, reason: 'identity-mismatch', presentedUserId }
    }
    return { ok: true }
  }

  private cacheSet(key: string, userId: string): void {
    if (this.cache.size >= IDENTITY_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, { userId, at: this.now() })
  }
}
