/**
 * Web Console provider for `ctx.platformUsers`: verifies auth-center JWTs
 * locally via JWKS (provider/issuer/JWKS URL resolved through the shared SSO
 * config model) and reads the caller's governance record from the
 * Web Console backend (`GET /api/users/me`) with the user's bearer token.
 * Governance writes live in the Web Console backend.
 *
 * @module @deepseek-ai/dsh-platform-user-console
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type {} from '@deepseek-ai/dsh-platform-user'
import {
  PlatformUserError,
  resolveSsoSettings,
  type PlatformUser,
  type PlatformRole,
  type PlatformUserProvider,
  type PlatformUserStatus,
  type ResolvedSsoSettings,
  type SsoSettingsInput,
} from '@deepseek-ai/dsh-platform-user'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'platform-user-console'

/** Default Web Console base URL, aligned with the other enterprise consumers. */
export const DEFAULT_WEB_CONSOLE_BASE_URL = 'http://127.0.0.1:8080'

/** The platform-user seam this provider registers into. */
export const inject = ['platformUsers']

/** Plugin config for the Web-Console-backed provider. */
export interface Config {
  /** 认证中心类型 supabase | casdoor | customer-oidc,缺省 supabase;volatile:设置面板可改,即时生效。 */
  provider: Volatile<string>
  /** Supabase project URL; only its Auth issuer is used for JWT verification;volatile:设置面板可改,即时生效。 */
  supabaseUrl: Volatile<string>
  /** 认证中心 JWT issuer,为空时按 Supabase 约定推导 `<supabaseUrl>/auth/v1`;volatile:设置面板可改,即时生效。 */
  issuer: Volatile<string>
  /** JWKS 端点,为空时按 OIDC 约定推导 `<issuer>/.well-known/jwks.json`;volatile:设置面板可改,即时生效。 */
  jwksUrl: Volatile<string>
  /** Web Console backend base URL serving `GET /api/users/me`;volatile:设置面板可改,即时生效。 */
  webConsoleBaseUrl: Volatile<string>
}

export const Config = z.object({
  provider: z.string().required().volatile(),
  supabaseUrl: z.string().required().volatile(),
  issuer: z.string().required().volatile(),
  jwksUrl: z.string().required().volatile(),
  webConsoleBaseUrl: z.string().required().volatile(),
})

/** Complete config after schemastery applies defaults. */
export interface ResolvedConfig extends ResolvedSsoSettings {
  /** Web Console backend base URL without a trailing slash. */
  webConsoleBaseUrl: string
}

function requireNonEmpty(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new Error(`platform-user-console: ${name} must be a non-empty string`)
  }
  return value
}

/**
 * Resolve the runtime spec from a plain config snapshot.
 *
 * <p>SSO 部分校验与推导委托共享模型 {@link resolveSsoSettings}(provider 缺省
 * supabase;非 supabase 时 issuer 必须显式给出,fails loud;supabase 未配置时
 * issuer 为空串,由 {@link apply} 以「未配置」provider 顶替)。webConsoleBaseUrl
 * 必填,本插件是纯 RS 验签点,不消费 clientId/scopes。
 *
 * @param config - plain config values(Volatile 字段请先经 {@link snapshotConfig} 解包)。
 * @returns the fully resolved config;issuer 为空串表示认证中心未配置。
 */
export function resolveConfig(config: SsoSettingsInput & {
  webConsoleBaseUrl?: string
}): ResolvedConfig {
  return {
    ...resolveSsoSettings(config),
    webConsoleBaseUrl: requireNonEmpty(
      'webConsoleBaseUrl',
      config.webConsoleBaseUrl ?? DEFAULT_WEB_CONSOLE_BASE_URL,
    ).replace(/\/+$/, ''),
  }
}

/**
 * 解包 volatile 配置引用为普通值快照。
 * @param config - 插件 Config(注入的 Volatile 引用)。
 * @returns 供 {@link resolveConfig} 消费的普通值快照。
 */
export function snapshotConfig(config: Config): SsoSettingsInput & {
  webConsoleBaseUrl?: string
} {
  return {
    provider: config.provider.get(),
    supabaseUrl: config.supabaseUrl.get(),
    issuer: config.issuer.get(),
    jwksUrl: config.jwksUrl.get(),
    webConsoleBaseUrl: config.webConsoleBaseUrl.get(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`platform-user-console: user field "${field}" must be a non-empty string`)
  }
  return value
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new Error(`platform-user-console: user field "${field}" must be a string or null`)
  }
  return value
}

function readStatus(value: unknown): PlatformUserStatus {
  const status = readString(value, 'status')
  if (!['pending_approval', 'active', 'disabled', 'locked'].includes(status)) {
    throw new Error(`platform-user-console: unknown platform user status "${status}"`)
  }
  return status as PlatformUserStatus
}

function readRoles(value: unknown): readonly PlatformRole[] {
  if (!Array.isArray(value)) {
    throw new Error('platform-user-console: user field "platformRoles" must be a string array')
  }
  return value.map((entry) => {
    const role = readString(entry, 'platformRoles[]')
    if (!['system_admin', 'app_admin', 'normal_user'].includes(role)) {
      throw new Error(`platform-user-console: unknown platform role "${role}"`)
    }
    return role as PlatformRole
  })
}

/** Governance record as returned by the Web Console `GET /api/users/me` data field (camelCase). */
export interface MeUser {
  id: string
  authSubject: string
  loginName: string
  displayName: string
  email: string
  status: PlatformUserStatus
  platformRoles: readonly PlatformRole[]
  createdAt: string
  createdBy: string | null
  approvedAt: string | null
  approvedBy: string | null
  disabledAt: string | null
  disabledBy: string | null
  disabledReason: string | null
  lockedAt: string | null
  lockedBy: string | null
  lockedReason: string | null
}

/**
 * Unwrap the Web Console `ApiResponse` envelope and return the data field.
 * @param payload - parsed JSON body of the `/api/users/me` response.
 * @returns the data field value, or null when the backend reports no record.
 */
export function readMeResponse(payload: unknown): unknown {
  if (!isRecord(payload)) {
    throw new Error('platform-user-console: /api/users/me response must be an object')
  }
  if (payload.success !== true) {
    throw new PlatformUserError(
      `getUserByToken: /api/users/me reported failure: ${JSON.stringify(payload.error)}`,
      'PROVIDER_REQUEST_FAILED',
    )
  }
  return payload.data
}

/**
 * Validate and normalize one `/api/users/me` data record. Unknown fields
 * (e.g. `orgUnits`) are ignored.
 * @param value - raw data field value.
 * @returns the validated user record.
 */
export function readMeUser(value: unknown): MeUser {
  if (!isRecord(value)) {
    throw new PlatformUserError(
      'platform user not found for authenticated subject',
      'UNKNOWN_USER',
    )
  }
  return {
    id: readString(value.id, 'id'),
    authSubject: readString(value.authSubject, 'authSubject'),
    loginName: readString(value.loginName, 'loginName'),
    displayName: readString(value.displayName, 'displayName'),
    email: readString(value.email, 'email'),
    status: readStatus(value.status),
    platformRoles: readRoles(value.platformRoles),
    createdAt: readString(value.createdAt, 'createdAt'),
    createdBy: readOptionalString(value.createdBy, 'createdBy'),
    approvedAt: readOptionalString(value.approvedAt, 'approvedAt'),
    approvedBy: readOptionalString(value.approvedBy, 'approvedBy'),
    disabledAt: readOptionalString(value.disabledAt, 'disabledAt'),
    disabledBy: readOptionalString(value.disabledBy, 'disabledBy'),
    disabledReason: readOptionalString(value.disabledReason, 'disabledReason'),
    lockedAt: readOptionalString(value.lockedAt, 'lockedAt'),
    lockedBy: readOptionalString(value.lockedBy, 'lockedBy'),
    lockedReason: readOptionalString(value.lockedReason, 'lockedReason'),
  }
}

/**
 * Map one validated record into the seam's stable `PlatformUser` value.
 * @param user - validated record.
 * @returns the seam value.
 */
export function mapPlatformUser(user: MeUser): PlatformUser {
  return {
    id: user.id as PlatformUser['id'],
    authSubject: user.authSubject,
    loginName: user.loginName,
    displayName: user.displayName,
    email: user.email,
    status: user.status,
    platformRoles: user.platformRoles,
    createdAt: user.createdAt,
    ...(user.createdBy === null ? {} : { createdBy: user.createdBy as PlatformUser['id'] }),
    ...(user.approvedAt === null ? {} : { approvedAt: user.approvedAt }),
    ...(user.approvedBy === null ? {} : { approvedBy: user.approvedBy as PlatformUser['id'] }),
    ...(user.disabledAt === null ? {} : { disabledAt: user.disabledAt }),
    ...(user.disabledBy === null ? {} : { disabledBy: user.disabledBy as PlatformUser['id'] }),
    ...(user.disabledReason === null ? {} : { disabledReason: user.disabledReason }),
    ...(user.lockedAt === null ? {} : { lockedAt: user.lockedAt }),
    ...(user.lockedBy === null ? {} : { lockedBy: user.lockedBy as PlatformUser['id'] }),
    ...(user.lockedReason === null ? {} : { lockedReason: user.lockedReason }),
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

/**
 * Web-Console-backed read-only provider. Verifies JWTs locally via JWKS and
 * reads the caller's governance record from `GET /api/users/me` using the
 * user's own bearer token.
 */
export class ConsolePlatformUserProvider implements PlatformUserProvider {
  private readonly issuer: string

  /**
   * @param issuer - 认证中心 JWT issuer(iss claim 校验值)。
   * @param webConsoleBaseUrl - Web Console backend base URL without trailing slash.
   * @param jwks - JWKS key store for JWT signature verification.
   */
  constructor(
    issuer: string,
    private readonly webConsoleBaseUrl: string,
    private readonly jwks: ReturnType<typeof createRemoteJWKSet>,
  ) {
    this.issuer = issuer
  }

  async getUserByToken(accessToken: string): Promise<PlatformUser> {
    await this.verifyJwt(accessToken)
    const payload = await this.readMe(accessToken)
    return mapPlatformUser(readMeUser(readMeResponse(payload)))
  }

  /** Verify the JWT locally; the backend re-verifies it, this only classifies bad tokens early. */
  private async verifyJwt(accessToken: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(accessToken, this.jwks, {
        issuer: this.issuer,
      })
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new PlatformUserError('JWT missing sub claim', 'AUTH_TOKEN_INVALID')
      }
    } catch (error) {
      if (error instanceof PlatformUserError) throw error
      throw new PlatformUserError(
        `getUserByToken: JWT verification failed: ${normalizeError(error).message}`,
        'AUTH_TOKEN_INVALID',
        { cause: normalizeError(error) },
      )
    }
  }

  /** Read the caller's governance record from the Web Console backend. */
  private async readMe(accessToken: string): Promise<unknown> {
    return fetchMeResponse(this.webConsoleBaseUrl, accessToken)
  }
}

/**
 * Fetch and unwrap the raw `/api/users/me` payload. Network failures and
 * non-2xx responses both classify as `PROVIDER_REQUEST_FAILED` — the provider
 * being unreachable is not the caller's fault, and an unclassified network
 * TypeError would surface as 400 in platform-user-api's HTTP mapping.
 *
 * @param webConsoleBaseUrl - Web Console backend base URL without trailing slash.
 * @param accessToken - caller's bearer token, forwarded verbatim.
 * @returns the parsed JSON body (envelope included; validation happens in {@link readMeResponse}).
 */
export async function fetchMeResponse(
  webConsoleBaseUrl: string,
  accessToken: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${webConsoleBaseUrl}/api/users/me`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    })
  } catch (error) {
    // 连接拒绝/DNS 失败等网络错误是提供方不可达,不是调用方参数问题
    throw new PlatformUserError(
      `getUserByToken: /api/users/me unreachable at ${webConsoleBaseUrl}: ${normalizeError(error).message}`,
      'PROVIDER_REQUEST_FAILED',
      { cause: normalizeError(error) },
    )
  }
  const body = await response.text().catch(() => '')
  if (!response.ok) {
    throw new PlatformUserError(
      `getUserByToken: /api/users/me failed: ${response.status} ${body}`,
      'PROVIDER_REQUEST_FAILED',
    )
  }
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new PlatformUserError(
      `getUserByToken: invalid JSON response: ${normalizeError(error).message}`,
      'PROVIDER_REQUEST_FAILED',
      { cause: normalizeError(error) },
    )
  }
}

/**
 * Register the Web-Console-backed platform-user provider.
 * @param ctx - Cordis context carrying `ctx.platformUsers`.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  // provider 构造时把 JWKS 集合绑定到 issuer,无法惰性切换;
  // volatile 变更(loader/volatile-update)到达时注销旧 provider 并按新值重建。
  let unregister: (() => void) | undefined
  const mount = (): void => {
    const raw = snapshotConfig(config)
    unregister?.()
    const resolved = resolveConfig(raw)
    // 未配置合法化:登录页是首次配置入口,启动时认证中心未配置(issuer/supabaseUrl
    // 均为空)是合法态,不阻塞挂载;以"未配置"provider 顶替,登录会得到明确的
    // 未配置错误,配置完成后 volatile-update 到达自动重建真 provider。
    if (resolved.issuer === '') {
      unregister = ctx.platformUsers.registerProvider({
        getUserByToken: () => Promise.reject(new PlatformUserError(
          '认证服务未配置(issuer/supabaseUrl 均为空),请在登录页「服务配置」中完成设置',
          'PROVIDER_REQUEST_FAILED',
        )),
      })
      ctx.logger.warn('platform-user-console: 认证中心未配置(issuer/supabaseUrl 为空),认证 provider 以未配置模式挂载')
      return
    }
    unregister = ctx.platformUsers.registerProvider(new ConsolePlatformUserProvider(
      resolved.issuer,
      resolved.webConsoleBaseUrl,
      createRemoteJWKSet(new URL(resolved.jwksUrl)),
    ))
  }
  mount()
  ctx.on('loader/volatile-update', () => {
    try {
      mount()
      ctx.logger.info('platform-user-console: 配置已更新,provider 已按新地址重建')
    } catch (error) {
      // 重建失败保留旧 provider(旧值快照仍在服务),只报告错误
      ctx.logger.warn('platform-user-console: 配置更新后 provider 重建失败,沿用旧配置', error)
    }
  })
}
