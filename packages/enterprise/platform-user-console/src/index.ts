/**
 * Web Console provider for `ctx.platformUsers`: verifies auth-center JWTs
 * locally via JWKS (provider/issuer/JWKS URL resolved through the shared SSO
 * config model) and reads the caller's governance record from the
 * Web Console backend (`GET /api/users/me`) with the user's bearer token.
 * Governance writes live in the Web Console backend.
 *
 * Config resolution, response handling and the provider class live in the
 * internal {@link ./console-client.ts} module (entry keeps name/inject/Config/apply,
 * verify-plugin-entry-exports).
 *
 * @module @deepseek-ai/dsh-platform-user-console
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { createRemoteJWKSet } from 'jose'
import type {} from '@deepseek-ai/dsh-platform-user'
import { PlatformUserError } from '@deepseek-ai/dsh-platform-user'
import {
  ConsolePlatformUserProvider,
  resolveConfig,
  snapshotConfig,
} from './console-client.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'platform-user-console'

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
