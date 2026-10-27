import { describe, expect, it } from 'vitest'
import type { FieldSpec, SsoDraft } from '../src/client/EnterpriseServicesSection.tsx'
import {
  ALL_FIELDS,
  isSsoProvider,
  probeTarget,
  SSO_PROVIDERS,
  toSsoDraft,
  validateSsoDraft,
} from '../src/client/EnterpriseServicesSection.tsx'
import { createEnterpriseServicesAccess } from '../src/client/enterprise-services-access.ts'
import type { SettingsRpcFace } from '../src/client/enterprise-services-access.ts'

/** settings describe 返回的一个命名空间视图。 */
interface NsView { ns: string; revision: number; value: unknown }

/**
 * 记录 update 调用并按命名空间应答的 RPC 桩;可选 per-ns 失败注入。
 * @param namespaces describe 应答的命名空间视图列表。
 * @param failNs 让 update 失败的命名 => 错误消息。
 */
function rpc(namespaces: readonly NsView[], failNs: Record<string, string> = {}): SettingsRpcFace & {
  updates: { ns: string; patch: Record<string, unknown>; revision: number | undefined }[]
} {
  const updates: { ns: string; patch: Record<string, unknown>; revision: number | undefined }[] = []
  const revisions = new Map(namespaces.map(view => [view.ns, view.revision]))
  return {
    updates,
    async describe() {
      return { ok: true, value: { namespaces } }
    },
    async update(ns, patch, expectedRevision) {
      updates.push({ ns, patch, revision: expectedRevision })
      const failure = failNs[ns]
      if (failure !== undefined) return { ok: false, error: { message: failure } }
      revisions.set(ns, (revisions.get(ns) ?? 0) + 1)
      return { ok: true }
    },
  }
}

describe('EnterpriseServicesSection field registry', () => {
  it('collects the four groups including the merged authentication service fields', () => {
    const byLabel = new Map(ALL_FIELDS.map(field => [field.label, field]))
    expect([...byLabel.keys()].slice(0, 7)).toEqual([
      'SSO_PROVIDER', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
      'SSO_ISSUER', 'SSO_JWKS_URL', 'SSO_CLIENT_ID', 'SSO_SCOPES',
    ])
    expect(byLabel.get('SSO_PROVIDER')).toMatchObject({ ns: 'platform-user-api', key: 'provider' })
    expect(byLabel.get('SSO_SCOPES')).toMatchObject({ ns: 'platform-user-api', key: 'scopes' })
  })

  it('declares the SSO verify trio to mirror into platform-user-console and invalidate the session', () => {
    for (const label of ['SUPABASE_URL', 'SSO_PROVIDER', 'SSO_ISSUER', 'SSO_JWKS_URL']) {
      const field = ALL_FIELDS.find(candidate => candidate.label === label)
      expect(field?.mirrorNs).toEqual(['platform-user-console'])
      expect(field?.requireRelogin).toBe(true)
    }
    // 只影响下次登录的 RP 参数不需要确认,也不镜像(clientId/scopes 仅 platform-user-api 持有)
    expect(ALL_FIELDS.find(field => field.label === 'SSO_CLIENT_ID')?.requireRelogin).toBeUndefined()
    expect(ALL_FIELDS.find(field => field.label === 'SSO_CLIENT_ID')?.mirrorNs).toBeUndefined()
  })

  it('renders SSO_PROVIDER as the very first field with the provider enum as select options', () => {
    expect(ALL_FIELDS[0]?.label).toBe('SSO_PROVIDER')
    const ssoLabels = ['SSO_PROVIDER', 'SSO_ISSUER', 'SSO_JWKS_URL', 'SSO_CLIENT_ID', 'SSO_SCOPES']
    expect(ALL_FIELDS.map(field => field.label).filter(label => ssoLabels.includes(label))).toEqual(ssoLabels)
    expect(ALL_FIELDS.find(field => field.label === 'SSO_PROVIDER')?.options).toEqual([...SSO_PROVIDERS])
  })

  it('shows supabase params only in supabase mode and the OIDC four only outside it', () => {
    const visibleWhen = (label: string): ((provider: 'supabase' | 'casdoor') => boolean) | undefined => {
      const found = ALL_FIELDS.find(field => field.label === label)
      if (found === undefined) throw new Error(`字段定义缺失: ${label}`)
      return found.visibleWhen
    }
    expect(visibleWhen('SUPABASE_URL')?.('supabase')).toBe(true)
    expect(visibleWhen('SUPABASE_ANON_KEY')?.('supabase')).toBe(true)
    expect(visibleWhen('SUPABASE_URL')?.('casdoor')).toBe(false)
    expect(visibleWhen('SUPABASE_ANON_KEY')?.('casdoor')).toBe(false)
    for (const label of ['SSO_ISSUER', 'SSO_JWKS_URL', 'SSO_CLIENT_ID', 'SSO_SCOPES']) {
      expect(visibleWhen(label)?.('supabase')).toBe(false)
      expect(visibleWhen(label)?.('casdoor')).toBe(true)
    }
    expect(visibleWhen('SSO_PROVIDER')).toBeUndefined()
  })

  it('builds probe targets per kind', () => {
    expect(probeTarget('supabase', 'https://s.example/')).toBe('https://s.example/auth/v1/health')
    expect(probeTarget('actuator', 'http://e.example:8090/')).toBe('http://e.example:8090/actuator/health')
    expect(probeTarget('root', 'https://jwks.example')).toBe('https://jwks.example')
  })
})

describe('SSO draft helpers', () => {
  it('normalizes untyped settings values into an SSO draft with a supabase fallback', () => {
    expect(toSsoDraft({ SSO_PROVIDER: 'casdoor', SSO_ISSUER: 'http://idp.example' })).toEqual({
      provider: 'casdoor', supabaseUrl: '', supabaseAnonKey: '',
      issuer: 'http://idp.example', jwksUrl: '', clientId: '', scopes: '',
    })
    expect(toSsoDraft({}).provider).toBe('supabase')
    expect(toSsoDraft({ SSO_PROVIDER: 'bogus' }).provider).toBe('supabase')
    expect(toSsoDraft({ SUPABASE_URL: 'https://s.example', SUPABASE_ANON_KEY: 'anon' })).toMatchObject({
      supabaseUrl: 'https://s.example', supabaseAnonKey: 'anon',
    })
  })

  it('guards the provider enum', () => {
    expect(isSsoProvider('casdoor')).toBe(true)
    expect(isSsoProvider('customer-oidc')).toBe(true)
    expect(isSsoProvider('nope')).toBe(false)
  })

  it('validates the draft: each mode requires only its own params', () => {
    expect(validateSsoDraft({ provider: 'supabase', supabaseUrl: '', supabaseAnonKey: 'a', issuer: '', jwksUrl: '', clientId: '', scopes: '' }))
      .toBe('SUPABASE_URL 必填:supabase 认证中心的项目地址')
    expect(validateSsoDraft({ provider: 'supabase', supabaseUrl: 'https://s.example', supabaseAnonKey: '', issuer: '', jwksUrl: '', clientId: '', scopes: '' }))
      .toBe('SUPABASE_ANON_KEY 必填:supabase 认证中心的 anon key')
    expect(validateSsoDraft({ provider: 'supabase', supabaseUrl: ' https://s.example ', supabaseAnonKey: ' a ', issuer: '', jwksUrl: '', clientId: '', scopes: '' })).toBeNull()
    expect(validateSsoDraft({ provider: 'casdoor', supabaseUrl: '', supabaseAnonKey: '', issuer: ' ', jwksUrl: '', clientId: 'c', scopes: '' }))
      .toBe('SSO_ISSUER 必填:非 supabase 认证中心必须显式提供 issuer')
    expect(validateSsoDraft({ provider: 'casdoor', supabaseUrl: '', supabaseAnonKey: '', issuer: 'http://idp.example', jwksUrl: '', clientId: '', scopes: '' }))
      .toBe('SSO_CLIENT_ID 必填:员工端在认证中心注册的 client id')
    expect(validateSsoDraft({ provider: 'casdoor', supabaseUrl: '', supabaseAnonKey: '', issuer: 'http://idp.example', jwksUrl: 'http://idp.example/jwks', clientId: 'c-1', scopes: 'openid' })).toBeNull()
  })
})

describe('createEnterpriseServicesAccess', () => {
  const namespace = (ns: string, value: Record<string, unknown>): NsView => ({ ns, revision: 7, value })

  it('loads every declared field across namespaces, including the SSO group', async () => {
    const access = createEnterpriseServicesAccess(rpc([
      namespace('platform-user-api', {
        provider: 'casdoor', issuer: 'http://idp.example', jwksUrl: 'http://idp.example/.well-known/jwks',
        clientId: 'c-1', scopes: 'openid', supabaseUrl: 'https://s.example', supabaseAnonKey: 'anon',
      }),
      namespace('flowable-task-proxy', { engineBaseUrl: 'http://127.0.0.1:8090' }),
    ]))
    const result = await access.load()
    expect(result).toMatchObject({
      ok: true,
      values: {
        SSO_PROVIDER: 'casdoor',
        SSO_ISSUER: 'http://idp.example',
        SSO_JWKS_URL: 'http://idp.example/.well-known/jwks',
        SSO_CLIENT_ID: 'c-1',
        SSO_SCOPES: 'openid',
        FLOWABLE_ENGINE_URL: 'http://127.0.0.1:8090',
      },
    })
    // 面板未持有该 ns 的字段留空,不报错
    expect(result.ok && result.values.SKILLHUB_URL).toBe('')
  })

  it('rejects a non-numeric value for number fields before any write', async () => {
    const stub = rpc([namespace('skill-sync', { intervalMs: 600000 })])
    const access = createEnterpriseServicesAccess(stub)
    const result = await access.save(
      ALL_FIELDS.find(field => field.label === 'SKILL_SYNC_INTERVAL_MS') as FieldSpec,
      'not-a-number',
    )
    expect(result).toEqual({ ok: false, message: 'SKILL_SYNC_INTERVAL_MS 必须是数字(毫秒)' })
    expect(stub.updates).toHaveLength(0)
  })

  it('writes only the primary namespace when the field declares no mirror', async () => {
    const stub = rpc([namespace('platform-user-api', { scopes: 'openid' })])
    const access = createEnterpriseServicesAccess(stub)
    const result = await access.save(
      ALL_FIELDS.find(field => field.label === 'SSO_SCOPES') as FieldSpec,
      'openid profile',
    )
    expect(result).toEqual({ ok: true })
    expect(stub.updates).toEqual([
      { ns: 'platform-user-api', patch: { scopes: 'openid profile' }, revision: 7 },
    ])
  })

  it('mirrors an SSO provider change into platform-user-console with the same key', async () => {
    const stub = rpc([
      namespace('platform-user-api', { provider: 'supabase' }),
      namespace('platform-user-console', { provider: 'supabase' }),
    ])
    const access = createEnterpriseServicesAccess(stub)
    const result = await access.save(
      ALL_FIELDS.find(field => field.label === 'SSO_PROVIDER') as FieldSpec,
      'casdoor',
    )
    expect(result).toEqual({ ok: true })
    expect(stub.updates).toEqual([
      { ns: 'platform-user-api', patch: { provider: 'casdoor' }, revision: 7 },
      { ns: 'platform-user-console', patch: { provider: 'casdoor' }, revision: 7 },
    ])
  })

  it('reports the first failing mirror namespace while the primary write landed', async () => {
    const stub = rpc([
      namespace('platform-user-api', { issuer: '' }),
      namespace('platform-user-console', { issuer: '' }),
    ], { 'platform-user-console': 'revision mismatch' })
    const access = createEnterpriseServicesAccess(stub)
    const result = await access.save(
      ALL_FIELDS.find(field => field.label === 'SSO_ISSUER') as FieldSpec,
      'http://idp.example',
    )
    expect(result).toEqual({ ok: false, message: '主条目已保存,但 platform-user-console 同步失败: revision mismatch' })
    expect(stub.updates).toHaveLength(2)
  })

  it('fans WEB_CONSOLE_URL out to every consuming mirror namespace', async () => {
    const all = ['user-identity-context', 'knowledge', 'process-start', 'llm-access', 'kb-context', 'instance-workspace', 'pocket-access']
    const stub = rpc([
      namespace('platform-user-console', { webConsoleBaseUrl: 'http://127.0.0.1:8080' }),
      ...all.map(ns => namespace(ns, { webConsoleBaseUrl: 'http://127.0.0.1:8080' })),
    ])
    const access = createEnterpriseServicesAccess(stub)
    const result = await access.save(
      ALL_FIELDS.find(field => field.label === 'WEB_CONSOLE_URL') as FieldSpec,
      'http://10.0.0.5:8080',
    )
    expect(result).toEqual({ ok: true })
    expect(stub.updates.map(update => update.ns)).toEqual(['platform-user-console', ...all])
    for (const update of stub.updates) {
      expect(update.patch).toEqual({ webConsoleBaseUrl: 'http://10.0.0.5:8080' })
    }
  })

  /** 认证服务组级应用的 describe 应答:主条目与镜像条目各持一份带残留的认证中心参数。 */
  const ssoNamespaces = (): NsView[] => [
    namespace('platform-user-api', {
      provider: 'supabase', issuer: 'http://old.example', jwksUrl: 'http://old.example/jwks',
      clientId: 'c-1', scopes: 'openid profile', supabaseUrl: 'https://s.example', supabaseAnonKey: 'anon-1',
    }),
    namespace('platform-user-console', { provider: 'supabase', issuer: 'http://old.example', jwksUrl: 'http://old.example/jwks', supabaseUrl: 'https://s.example' }),
  ]

  it('applies a supabase draft by writing supabase params and clearing residual issuer/jwksUrl without touching clientId/scopes', async () => {
    const stub = rpc(ssoNamespaces())
    const access = createEnterpriseServicesAccess(stub)
    const result = await access.saveSso({
      provider: 'supabase', supabaseUrl: ' https://s2.example ', supabaseAnonKey: ' anon-2 ',
      issuer: '', jwksUrl: '', clientId: '', scopes: '',
    })
    expect(result).toEqual({ ok: true })
    expect(stub.updates).toHaveLength(2)
    expect(stub.updates).toEqual([
      { ns: 'platform-user-api', patch: { provider: 'supabase', issuer: '', jwksUrl: '', supabaseUrl: 'https://s2.example', supabaseAnonKey: 'anon-2' }, revision: 7 },
      { ns: 'platform-user-console', patch: { provider: 'supabase', issuer: '', jwksUrl: '', supabaseUrl: 'https://s2.example' }, revision: 7 },
    ])
  })

  it('applies a casdoor draft with the full five-key primary patch and the three-key verify mirror, leaving supabase params untouched', async () => {
    const stub = rpc(ssoNamespaces())
    const access = createEnterpriseServicesAccess(stub)
    const result = await access.saveSso({
      provider: 'casdoor', supabaseUrl: 'https://s.example', supabaseAnonKey: 'anon-1',
      issuer: ' http://idp.example ',
      jwksUrl: 'http://idp.example/jwks',
      clientId: ' c-2 ',
      scopes: 'openid profile',
    })
    expect(result).toEqual({ ok: true })
    expect(stub.updates).toEqual([
      {
        ns: 'platform-user-api',
        patch: { provider: 'casdoor', issuer: 'http://idp.example', jwksUrl: 'http://idp.example/jwks', clientId: 'c-2', scopes: 'openid profile' },
        revision: 7,
      },
      {
        ns: 'platform-user-console',
        patch: { provider: 'casdoor', issuer: 'http://idp.example', jwksUrl: 'http://idp.example/jwks' },
        revision: 7,
      },
    ])
  })

  it('rejects an invalid SSO draft before any write', async () => {
    const stub = rpc(ssoNamespaces())
    const access = createEnterpriseServicesAccess(stub)
    const missingIssuer: SsoDraft = { provider: 'casdoor', supabaseUrl: '', supabaseAnonKey: '', issuer: '', jwksUrl: '', clientId: 'c-2', scopes: '' }
    expect((await access.saveSso(missingIssuer)).ok).toBe(false)
    const missingClient: SsoDraft = { provider: 'casdoor', supabaseUrl: '', supabaseAnonKey: '', issuer: 'http://idp.example', jwksUrl: '', clientId: '', scopes: '' }
    expect((await access.saveSso(missingClient)).ok).toBe(false)
    const missingUrl: SsoDraft = { provider: 'supabase', supabaseUrl: '', supabaseAnonKey: 'a', issuer: '', jwksUrl: '', clientId: '', scopes: '' }
    expect((await access.saveSso(missingUrl)).ok).toBe(false)
    expect(stub.updates).toHaveLength(0)
  })

  it('reports the first failing SSO mirror namespace while the primary write landed', async () => {
    const stub = rpc(ssoNamespaces(), { 'platform-user-console': 'revision mismatch' })
    const access = createEnterpriseServicesAccess(stub)
    const result = await access.saveSso({
      provider: 'casdoor', supabaseUrl: '', supabaseAnonKey: '',
      issuer: 'http://idp.example', jwksUrl: 'http://idp.example/jwks', clientId: 'c-2', scopes: 'openid',
    })
    expect(result).toEqual({ ok: false, message: '主条目已保存,但 platform-user-console 同步失败: revision mismatch' })
    expect(stub.updates).toHaveLength(2)
  })
})
