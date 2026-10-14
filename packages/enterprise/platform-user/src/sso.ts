/**
 * Shared SSO auth-center configuration model for the enterprise deployment
 * (design: docs/plans/2026-10-11-sso-auth-center-design.md §5.2): which auth
 * center issues employee JWTs (provider) plus the issuer/JWKS/clientId/scopes
 * parameters. Pure TS without schemastery — each plugin unpacks its own
 * volatile Config fields and hands the plain values to
 * {@link resolveSsoSettings} for validation and derivation; misconfiguration
 * fails loud.
 *
 * @module
 */

/** 认证中心类型(设计 §5.2 三选一);缺省 `supabase`(组合①零改动)。 */
export type SsoProvider = 'supabase' | 'casdoor' | 'customer-oidc'

/** OIDC 授权码流程缺省 scopes。 */
export const DEFAULT_SSO_SCOPES = 'openid profile'

/** 原始 SSO 配置(各插件 Volatile 字段解包后的普通值,均可省略)。 */
export interface SsoSettingsInput {
  /** 认证中心类型;缺省 `supabase`。 */
  provider?: string
  /** Supabase 项目 URL(仅 supabase 模式参与 issuer 推导)。 */
  supabaseUrl?: string
  /** 认证中心 issuer;非 supabase 模式必须显式给出。 */
  issuer?: string
  /** JWKS 端点;缺省按 OIDC 发现推导 `<issuer>/.well-known/jwks.json`。 */
  jwksUrl?: string
  /** 员工端 RP 在认证中心注册的 client id;此处仅透传,RP 消费者自行决定必填校验。 */
  clientId?: string
  /** OIDC scopes;缺省 {@link DEFAULT_SSO_SCOPES}。 */
  scopes?: string
}

/** 校验+推导完成的 SSO 配置。 */
export interface ResolvedSsoSettings {
  /** 认证中心类型。 */
  provider: SsoProvider
  /** Supabase 项目 URL(去尾斜杠);非 Supabase 部署可为空。 */
  supabaseUrl: string
  /** 认证中心 issuer(显式或推导);空串仅出现在 supabase 模式,表示认证中心尚未配置。 */
  issuer: string
  /** JWKS 端点(显式或推导);issuer 为空时为空。 */
  jwksUrl: string
  /** 员工端 RP client id(透传,可为空)。 */
  clientId: string
  /** OIDC scopes(缺省已补)。 */
  scopes: string
}

const SSO_PROVIDERS: readonly SsoProvider[] = ['supabase', 'casdoor', 'customer-oidc']

function trimUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

function requireHttpUrl(name: string, value: string): string {
  if (!/^https?:\/\//.test(value)) {
    throw new Error(`sso: ${name} must be an http(s) URL, got "${value}"`)
  }
  return value
}

/**
 * 校验并推导 SSO 配置(fails loud)。
 *
 * <p>校验规则:provider 非法值 → throw(加载期报错);非 supabase 模式 issuer
 * 必须显式给出(Casdoor/客户 IdP 没有 Supabase 那样的 `<url>/auth/v1` 推导
 * 约定);所有非空 URL(supabaseUrl/issuer/jwksUrl)必须为 http(s)。supabase
 * 模式保留「issuer 为空 = 未配置合法初态」——员工端首启经登录页服务配置
 * 引导完成配置,与 §5.2 的 issuer 必填相比是已确立的引导期例外。
 *
 * <p>clientId 为员工端 RP 注册值,此处仅透传不校验:RS 验签点(如
 * platform-user-console)用不到它,必填校验归属需要发起授权码流程的 RP
 * 消费者(如 platform-user-api)。
 *
 * @param input - 原始 SSO 配置。
 * @returns 校验+推导后的配置。
 */
export function resolveSsoSettings(input: SsoSettingsInput): ResolvedSsoSettings {
  const providerRaw = (input.provider ?? 'supabase').trim()
  if (!SSO_PROVIDERS.includes(providerRaw as SsoProvider)) {
    throw new Error(`sso: provider must be one of ${SSO_PROVIDERS.join(' | ')}, got "${providerRaw}"`)
  }
  const provider = providerRaw as SsoProvider
  const supabaseUrl = trimUrl(input.supabaseUrl)
  if (supabaseUrl !== '') requireHttpUrl('supabaseUrl', supabaseUrl)
  const explicitIssuer = trimUrl(input.issuer)
  let issuer: string
  if (provider === 'supabase') {
    issuer = explicitIssuer || (supabaseUrl === '' ? '' : `${supabaseUrl}/auth/v1`)
  } else if (explicitIssuer === '') {
    throw new Error(`sso: provider "${provider}" requires an explicit issuer (no derivation outside supabase)`)
  } else {
    issuer = explicitIssuer
  }
  if (issuer !== '') requireHttpUrl('issuer', issuer)
  const explicitJwksUrl = trimUrl(input.jwksUrl)
  const jwksUrl = explicitJwksUrl || (issuer === '' ? '' : `${issuer}/.well-known/jwks.json`)
  if (jwksUrl !== '') requireHttpUrl('jwksUrl', jwksUrl)
  return {
    provider,
    supabaseUrl,
    issuer,
    jwksUrl,
    clientId: (input.clientId ?? '').trim(),
    scopes: (input.scopes ?? '').trim() || DEFAULT_SSO_SCOPES,
  }
}
