/**
 * Service Definition for platform-user read access (`ctx.platformUsers`):
 * resolve the platform user record associated with a Supabase Auth access
 * token. Governance writes (approve, disable, roles, etc.) live in the Web
 * Console backend; this seam is read-only on the DSH side.
 *
 * @module @deepseek-ai/dsh-platform-user
 */

import { Context, Service } from '@deepseek-ai/cordis'

import type { PlatformUser } from './types.ts'

export type {
  PlatformRole,
  PlatformUser,
  PlatformUserId,
  PlatformUserStatus,
} from './types.ts'

export {
  DEFAULT_SSO_SCOPES,
  resolveSsoSettings,
} from './sso.ts'
export type {
  ResolvedSsoSettings,
  SsoProvider,
  SsoSettingsInput,
} from './sso.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    platformUsers: PlatformUserService
  }

  interface Events {
    /**
     * A platform user identity was verified through an auth touchpoint
     * (emitted by `platform-user-api` after `getUserByToken` resolves).
     * Listeners typically maintain a latest-verified-identity cache.
     * @param user - the verified platform user record.
     * @param accessToken - the verified bearer token, re-carried so enterprise
     *   consumers (e.g. skill-sync) can call server-side APIs as the signed-in
     *   employee.
     * @mode emit
     */
    'platform-user/verified'(user: PlatformUser, accessToken: string): void
    /**
     * The employee signed out on this DSH instance (emitted by
     * `platform-user-api` on the signout touchpoint). Listeners holding a
     * latest-verified-identity cache must forget it. Carries no payload:
     * the touchpoint does not prove which identity signed out.
     * @mode emit
     */
    'platform-user/signout'(): void
  }
}

/** One provider implementation of the platform-user seam. */
export interface PlatformUserProvider {
  /**
 * Resolve a platform user from an access token issued by the external auth
 * backend (Supabase Auth).
 *
 * Providers verify the JWT locally via JWKS and read the governance record
 * whose `auth_subject` matches the token's `sub` claim; where the record
 * lives and with which credentials it is read is a provider decision.
 *
 * @param accessToken - auth backend access token (Bearer).
 * @returns the platform user record.
 */
  getUserByToken(accessToken: string): Promise<PlatformUser>
}

/** Stable error taxonomy for platform-user failures. */
export class PlatformUserError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PlatformUserError'
  }
}

/** `ctx.platformUsers`: one active provider plus the read entry point. */
export class PlatformUserService extends Service {
  private provider: PlatformUserProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'platformUsers')
  }

  /**
   * Register the active provider. Only one provider may be mounted.
   * @param provider - provider implementation.
   * @returns disposer that unregisters it.
   */
  registerProvider(provider: PlatformUserProvider): () => void {
    const dispose = this.ctx.effect(function* (this: PlatformUserService) {
      if (this.provider !== undefined) {
        throw new PlatformUserError('a platform-user provider is already registered', 'DUPLICATE_PROVIDER')
      }
      this.provider = provider
      yield () => {
        this.provider = undefined
      }
    }.bind(this), 'platformUsers.registerProvider()')
    return () => void dispose()
  }

  /**
   * Resolve a platform user from a Supabase Auth access token.
   * @param accessToken - Supabase Auth access token (Bearer).
   * @returns the platform user record.
   */
  getUserByToken(accessToken: string): Promise<PlatformUser> {
    if (this.provider === undefined) {
      return Promise.reject(new PlatformUserError('no platform-user provider is registered', 'NO_PROVIDER'))
    }
    return this.provider.getUserByToken(accessToken)
  }
}

export default PlatformUserService
