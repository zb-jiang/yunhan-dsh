import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PlatformRole, PlatformUserId } from '@deepseek-ai/dsh-platform-user'
import { PlatformUserError } from '@deepseek-ai/dsh-platform-user'
import {
  apply,
  fetchMeResponse,
  mapPlatformUser,
  readMeResponse,
  readMeUser,
  resolveConfig,
  type MeUser,
} from '../src/index.ts'

const me = (overrides: Partial<MeUser> = {}): MeUser => ({
  id: 'user-1',
  authSubject: 'auth-1',
  loginName: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  status: 'pending_approval',
  platformRoles: [],
  createdAt: '2026-09-21T00:00:00Z',
  createdBy: null,
  approvedAt: null,
  approvedBy: null,
  disabledAt: null,
  disabledBy: null,
  disabledReason: null,
  lockedAt: null,
  lockedBy: null,
  lockedReason: null,
  ...overrides,
})

describe('dsh-platform-user-console', () => {
  it('resolves config through the shared SSO model, trims trailing slash, and rejects empty fields', () => {
    expect(resolveConfig({ supabaseUrl: 'https://example.supabase.co' })).toEqual({
      provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      issuer: 'https://example.supabase.co/auth/v1',
      jwksUrl: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
      clientId: '',
      scopes: 'openid profile',
      webConsoleBaseUrl: 'http://127.0.0.1:8080',
    })
    expect(resolveConfig({
      supabaseUrl: 'https://example.supabase.co',
      webConsoleBaseUrl: 'http://127.0.0.1:8080/',
    })).toMatchObject({ webConsoleBaseUrl: 'http://127.0.0.1:8080' })
    // supabase 未配置(issuer/supabaseUrl 为空)是合法初态,apply 以「未配置」provider 顶替
    expect(resolveConfig({})).toMatchObject({ provider: 'supabase', issuer: '' })
    expect(() => resolveConfig({ webConsoleBaseUrl: ' ' })).toThrow('webConsoleBaseUrl must be a non-empty string')
  })

  it('apply 未配置合法化:SUPABASE_URL 为空时以未配置模式挂载,登录得到明确错误', async () => {
    const registered: { getUserByToken: (token: string) => Promise<unknown> }[] = []
    const ctx = {
      platformUsers: { registerProvider: (provider: { getUserByToken: (token: string) => Promise<unknown> }) => {
        registered.push(provider)
        return () => {}
      } },
      on: () => {},
      logger: { warn: () => {}, info: () => {} },
    } as unknown as Context
    expect(() => { apply(ctx, {
      provider: { get: () => 'supabase' },
      supabaseUrl: { get: () => '' },
      issuer: { get: () => '' },
      jwksUrl: { get: () => '' },
      webConsoleBaseUrl: { get: () => 'http://127.0.0.1:8080' },
    }) }).not.toThrow()
    expect(registered).toHaveLength(1)
    await expect(registered[0]!.getUserByToken('jwt')).rejects.toThrow('认证服务未配置')
    await expect(registered[0]!.getUserByToken('jwt')).rejects.toBeInstanceOf(PlatformUserError)
  })

  it('apply 非 supabase provider 缺 issuer 时加载期抛错(fails loud)', () => {
    const ctx = {
      platformUsers: { registerProvider: () => () => {} },
      on: () => {},
      logger: { warn: () => {}, info: () => {} },
    } as unknown as Context
    expect(() => { apply(ctx, {
      provider: { get: () => 'casdoor' },
      supabaseUrl: { get: () => '' },
      issuer: { get: () => '' },
      jwksUrl: { get: () => '' },
      webConsoleBaseUrl: { get: () => 'http://127.0.0.1:8080' },
    }) }).toThrow('requires an explicit issuer')
  })

  it('unwraps the ApiResponse envelope and rejects failures', () => {
    const data = { id: 'user-1' }
    expect(readMeResponse({ success: true, data, error: null })).toEqual(data)
    expect(() => readMeResponse({ success: false, data: null, error: { message: 'denied' } }))
      .toThrow('/api/users/me reported failure')
    expect(() => readMeResponse('not-an-object')).toThrow('response must be an object')
  })

  it('validates and maps a minimal pending user', () => {
    const validated = readMeUser({ ...me(), platformRoles: [], orgUnits: [] })
    expect(mapPlatformUser(validated)).toEqual({
      id: 'user-1' as PlatformUserId,
      authSubject: 'auth-1',
      loginName: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      status: 'pending_approval',
      platformRoles: [],
      createdAt: '2026-09-21T00:00:00Z',
    })
  })

  it('maps an active user with the approval trail', () => {
    const validated = readMeUser(me({
      status: 'active',
      platformRoles: ['normal_user'],
      createdBy: 'admin-1',
      approvedAt: '2026-09-21T01:00:00Z',
      approvedBy: 'admin-1',
    }))
    expect(mapPlatformUser(validated)).toMatchObject({
      status: 'active',
      platformRoles: ['normal_user'],
      createdBy: 'admin-1' as PlatformUserId,
      approvedAt: '2026-09-21T01:00:00Z',
      approvedBy: 'admin-1' as PlatformUserId,
    })
  })

  it('maps a disabled user with the disable trail', () => {
    const validated = readMeUser(me({
      status: 'disabled',
      disabledAt: '2026-09-21T02:00:00Z',
      disabledBy: 'admin-1',
      disabledReason: '离职',
    }))
    expect(mapPlatformUser(validated)).toMatchObject({
      disabledAt: '2026-09-21T02:00:00Z',
      disabledBy: 'admin-1' as PlatformUserId,
      disabledReason: '离职',
    })
  })

  it('rejects unknown status, unknown roles, and malformed fields', () => {
    expect(() => readMeUser(me({ status: 'unknown' as never }))).toThrow('unknown platform user status')
    expect(() => readMeUser(me({ platformRoles: ['boss' as PlatformRole] }))).toThrow('unknown platform role')
    expect(() => readMeUser(me({ authSubject: '' }))).toThrow('must be a non-empty string')
    expect(() => readMeUser(null)).toThrow('platform user not found')
  })

  it('classifies a missing backend record as UNKNOWN_USER', () => {
    const data = readMeResponse({ success: true, data: null, error: null })
    expect(() => mapPlatformUser(readMeUser(data))).toThrow('platform user not found for authenticated subject')
  })

  it('classifies web-console network failure as PROVIDER_REQUEST_FAILED, not a bare TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED')))
    try {
      await expect(fetchMeResponse('http://127.0.0.1:8080', 'token'))
        .rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' })
      await expect(fetchMeResponse('http://127.0.0.1:8080', 'token'))
        .rejects.toBeInstanceOf(PlatformUserError)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('classifies non-2xx /me responses as PROVIDER_REQUEST_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 503 })))
    try {
      await expect(fetchMeResponse('http://127.0.0.1:8080', 'token'))
        .rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
