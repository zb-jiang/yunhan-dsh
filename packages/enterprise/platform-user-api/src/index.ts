/**
 * HTTP API routes for platform-user authentication on the DSH side.
 *
 * | Method | Path                            | Operation                       |
 * |--------|---------------------------------|---------------------------------|
 * | GET    | /api/enterprise/auth/me         | current user                    |
 * | GET    | /api/enterprise/auth/config     | auth config (mode-branched)     |
 * | GET    | /api/enterprise/auth/oidc/authorize | 302 to IdP authorization page |
 * | POST   | /api/enterprise/auth/oidc/token | OIDC code+PKCE token exchange   |
 * | POST   | /api/enterprise/auth/oidc/refresh | OIDC refresh_token grant      |
 * | POST   | /api/enterprise/auth/connectivity-check | Node-side reachability probe |
 * | POST   | /api/enterprise/auth/signout    | announce signout                |
 *
 * Every verified `/me` response emits `platform-user/verified`; the signout
 * touchpoint emits `platform-user/signout`. Identity-cache listeners (e.g.
 * `user-identity-context`) subscribe to these events; this plugin itself
 * holds no state.
 *
 * The OIDC endpoints exist because the browser must not talk to the auth
 * center directly (CORS is not guaranteed on customer IdPs) — the same
 * "browser can't do it, Node does it" precedent as connectivity-check. The
 * exchanged Bearer token is the `id_token` (RS256 JWT verified by the
 * existing JWKS verification points).
 *
 * Governance writes (register, approve, disable, lock, restore, roles,
 * audit) live in the Web Console backend, not here.
 *
 * @module @deepseek-ai/dsh-platform-user-api
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import {
  PlatformUserError,
  resolveSsoSettings,
  type PlatformUser,
  type ResolvedSsoSettings,
} from '@deepseek-ai/dsh-platform-user'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'platform-user-api'

/** 等待 webServer 和 platformUsers 服务就绪后才挂载路由。 */
export const inject = ['webServer', 'platformUsers']

/** 插件配置：认证中心(SSO)与 Supabase 兼容连接信息，经 /auth/config 向前端暴露。 */
export interface Config {
  /** 认证中心类型 supabase | casdoor | customer-oidc,缺省 supabase;volatile:设置面板可改,即时生效。 */
  provider: Volatile<string>
  /** Supabase 项目 URL(supabase 模式经 /auth/config 暴露给前端直连);volatile:设置面板可改,即时生效。 */
  supabaseUrl: Volatile<string>
  /** 认证中心 issuer,为空时 supabase 模式按 `<supabaseUrl>/auth/v1` 推导;volatile:设置面板可改,即时生效。 */
  issuer: Volatile<string>
  /** JWKS 端点,为空时按 OIDC 发现推导 `<issuer>/.well-known/jwks.json`;volatile:设置面板可改,即时生效。 */
  jwksUrl: Volatile<string>
  /** Supabase anon key，supabase 模式前端直连 Supabase Auth 使用;volatile:设置面板可改,即时生效。 */
  supabaseAnonKey: Volatile<string>
  /** 员工端 RP 在认证中心注册的 client id,provider 非 supabase 时必填;volatile:设置面板可改,即时生效。 */
  clientId: Volatile<string>
  /** OIDC 授权码流程 scopes,为空时缺省 `openid profile`;volatile:设置面板可改,即时生效。 */
  scopes: Volatile<string>
  /**
   * OAuth relay 中转基地址(web-console,如 `http://server:8080`);仅 Pocket Access
   * 手机端登录(非 loopback 访问)时使用,本机登录不经过 relay;volatile:设置面板可改,
   * 即时生效。空串=relay 未启用,手机端退回旧的根路径回调(需在认证中心为每台手机
   * 手工登记回调地址)。
   */
  oidcRelayUrl: Volatile<string>
}

export const Config = z.object({
  provider: z.string().required().volatile(),
  supabaseUrl: z.string().required().volatile(),
  issuer: z.string().required().volatile(),
  jwksUrl: z.string().required().volatile(),
  // 不标 role('secret'):secret 字段经 wire 读取会被永久打码,设置面板的小眼睛
  // 无法回显明文;掩码由面板 UI 层负责(本地 webserver 仅本机可达)。
  supabaseAnonKey: z.string().required().volatile(),
  clientId: z.string().required().volatile(),
  scopes: z.string().required().volatile(),
  // 可选字段带 default:用户层 cordis.patch.yml 的旧 config 快照缺该键不会炸(与
  // provider 的必填教训相反,见 2026-10-14 patch 覆盖事件)。
  oidcRelayUrl: z.string().default('').volatile(),
})

/**
 * 解包 volatile 配置并解析为 RP 视角的认证设置(fails loud)。
 *
 * <p>校验与推导委托共享模型 {@link resolveSsoSettings};追加 RP-grade 校验:
 * provider 非 supabase 时 clientId 必填——本插件是员工端 RP 登录参数的配置
 * 出口,授权码流程缺 clientId 无法发起。anonKey 是 Supabase 专属凭据,不进
 * 共享模型,由 /auth/config 在 supabase 模式单独读取。
 *
 * @param config - 插件 Config(注入的 Volatile 引用)。
 * @returns 校验+推导后的 SSO 设置。
 */
export function resolveAuthSettings(config: Config): ResolvedSsoSettings {
  const resolved = resolveSsoSettings({
    provider: config.provider.get(),
    supabaseUrl: config.supabaseUrl.get(),
    issuer: config.issuer.get(),
    jwksUrl: config.jwksUrl.get(),
    clientId: config.clientId.get(),
    scopes: config.scopes.get(),
  })
  if (resolved.provider !== 'supabase' && resolved.clientId === '') {
    throw new Error(`platform-user-api: provider "${resolved.provider}" requires a non-empty clientId (员工端 RP 注册值)`)
  }
  return resolved
}

/** 认证路由前缀。 */
const AUTH_ROUTE_PREFIX = '/api/enterprise/auth'

/** 连通性探测超时(毫秒):企业内网服务应秒级可达,5s 足够宽容。 */
const PROBE_TIMEOUT_MS = 5000

/** 读取请求体的 JSON(空体/非法 JSON 返回 undefined)。 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 64 * 1024) {
      return undefined
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  } catch {
    return undefined
  }
}

/**
 * Node 侧连通性探测:对目标 URL 发一次 GET,连通(任意 HTTP 状态码)即算可达。
 *
 * <p>必须由 Node 发起而不能在浏览器直接 fetch:引擎/console/SkillHub 的端点
 * 不开 CORS,浏览器探测会把"配置正确"误报为"不可达"。仅接受 http/https。
 */
async function probeConnectivity(rawUrl: string): Promise<{ ok: boolean; status: number; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    const response = await fetch(rawUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
    })
    // 读一小段让连接完成(响应体可能很大,丢弃)
    await response.arrayBuffer()
    return { ok: true, status: response.status, latencyMs: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, latencyMs: Date.now() - started, error: message }
  }
}

/** JSON 响应辅助函数。 */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/**
 * 授权码回调落点页 HTML:iframe 登录弹窗场景父页面读本页地址提取授权码,
 * 脚本停留原地;整页登录场景(window.self === window.top)回跳根路径让 SPA
 * 消费(本站发起的导航,SameSite=Strict 认证 cookie 随行)。
 * @param backUrl 整页场景的回跳 URL(已对 query 做过 encodeURIComponent)。
 * @returns 完整 HTML 文档字符串。
 */
function callbackPageHtml(backUrl: string): string {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>DSH 登录回调</title></head>
<body>
<p>登录成功，正在返回应用…</p>
<script>
if (window.self === window.top) {
  window.location.replace(${JSON.stringify(backUrl)})
}
</script>
</body>
</html>`
}

/** HTML 响应辅助函数(回调落点页专用)。 */
function sendHtml(res: import('node:http').ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

/** OIDC discovery 缓存:issuer → 发现文档端点;volatile 配置改 issuer 换 key,天然隔离。 */
const discoveryCache = new Map<string, { authorizationEndpoint: string; tokenEndpoint: string }>()

/**
 * 经 OIDC discovery 解析认证中心的授权/令牌端点(一次发现、一并缓存)。
 *
 * <p>Casdoor 与客户 IdP 的端点路径不同(Casdoor 是 /login/oauth/authorize 与
 * /api/login/oauth/access_token),硬编码会绑死单一 provider;标准 OIDC 发现
 * 文档是三选一 provider 的公共约定。
 */
async function resolveOidcEndpoints(issuer: string): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
  const cached = discoveryCache.get(issuer)
  if (cached !== undefined) return cached
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`OIDC discovery ${issuer}/.well-known/openid-configuration -> HTTP ${response.status}`)
  }
  const document = (await response.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown }
  if (typeof document.authorization_endpoint !== 'string' || document.authorization_endpoint === '') {
    throw new Error(`OIDC discovery document of "${issuer}" carries no authorization_endpoint`)
  }
  if (typeof document.token_endpoint !== 'string' || document.token_endpoint === '') {
    throw new Error(`OIDC discovery document of "${issuer}" carries no token_endpoint`)
  }
  const resolved = { authorizationEndpoint: document.authorization_endpoint, tokenEndpoint: document.token_endpoint }
  discoveryCache.set(issuer, resolved)
  return resolved
}

/** 从请求体断言非空字符串字段(员工端入参,验证在此处)。 */
function requireOidcField(body: unknown, name: string): string {
  if (typeof body === 'object' && body !== null) {
    const value = (body as Record<string, unknown>)[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  throw new Error(`${name} 缺失或格式无效`)
}

/** token endpoint 的成功响应(按本插件的消费面裁剪)。 */
interface OidcTokenResult {
  /** Bearer 用的 id_token(现有 JWKS 验签点直接验)。 */
  token: string
  /** 续期用 refresh_token,provider 未发时为空串。 */
  refreshToken: string
  /** 过期秒数,provider 未返回时为 0(前端不做本地倒计时)。 */
  expiresIn: number
}

/**
 * 执行一次授权码/刷新 grant:POST token endpoint 并解析响应。
 *
 * <p>非 2xx、响应非 JSON、缺 id_token 都抛错(由调用方映射为 502)——
 * 员工端 Bearer 必须是 id_token,access_token(Casdoor 默认 HS256 HMAC)
 * 过不了 JWKS 验签。
 */
async function runOidcGrant(tokenEndpoint: string, form: URLSearchParams): Promise<OidcTokenResult> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`token endpoint -> HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  let parsed: { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
  try {
    parsed = JSON.parse(text) as { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
  } catch {
    throw new Error(`token endpoint response is not JSON: ${text.slice(0, 200)}`)
  }
  if (typeof parsed.id_token !== 'string' || parsed.id_token === '') {
    throw new Error('token endpoint response carries no id_token (scopes must include openid)')
  }
  return {
    token: parsed.id_token,
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : 0,
  }
}

/** OIDC grant 的公共错误响应:上游(discovery/token endpoint)失败映射 502。 */
function sendOidcUpstreamError(res: import('node:http').ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 502, { error: `OIDC token exchange failed: ${message}` })
}

/** 将 PlatformUserError 映射为 HTTP 状态码。 */
function errorCodeToStatus(code: string): number {
  switch (code) {
    case 'NO_PROVIDER':
    case 'DUPLICATE_PROVIDER':
      return 500
    case 'UNKNOWN_USER':
      return 404
    case 'AUTH_TOKEN_INVALID':
      return 401
    default:
      return 500
  }
}

/** 统一错误处理。 */
function handleError(res: import('node:http').ServerResponse, error: unknown): void {
  if (error instanceof PlatformUserError) {
    sendJson(res, errorCodeToStatus(error.code), { error: error.message, code: error.code })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 400, { error: message })
}

/** 将 PlatformUser 序列化为 JSON 响应对象。 */
function serializeUser(user: PlatformUser): Record<string, unknown> {
  return {
    id: user.id,
    authSubject: user.authSubject,
    loginName: user.loginName,
    displayName: user.displayName,
    email: user.email,
    status: user.status,
    platformRoles: user.platformRoles,
    createdAt: user.createdAt,
    createdBy: user.createdBy,
    approvedAt: user.approvedAt,
    approvedBy: user.approvedBy,
    disabledAt: user.disabledAt,
    disabledBy: user.disabledBy,
    disabledReason: user.disabledReason,
    lockedAt: user.lockedAt,
    lockedBy: user.lockedBy,
    lockedReason: user.lockedReason,
  }
}

/**
 * 解析前缀后的路径段，返回剩余段数组。
 */
function parseSegments(urlPath: string, prefix: string): readonly string[] {
  const stripped = urlPath.slice(prefix.length)
  const trimmed = stripped.replace(/^\/+|\/+$/g, '')
  if (trimmed.length === 0) return []
  return trimmed.split('/')
}

/**
 * 认证路由分发：根据 method + segments 调用对应的服务方法。
 */
async function dispatchAuth(
  ctx: Context,
  config: Config,
  method: string,
  segments: readonly string[],
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // GET /api/enterprise/auth/me - 获取当前用户
  if (method === 'GET' && segments.length === 1 && segments[0] === 'me') {
    const authHeader = req.headers.authorization
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      sendJson(res, 401, { error: 'Authorization: Bearer <token> header is required' })
      return
    }
    const accessToken = authHeader.slice('Bearer '.length)
    const user = await ctx.platformUsers.getUserByToken(accessToken)
    // 事件携带原始 token:skill-sync 等企业消费者以当前登录员工身份调用服务端 API
    ctx.emit('platform-user/verified', user, accessToken)
    sendJson(res, 200, serializeUser(user))
    return
  }

  // POST /api/enterprise/auth/signout - 员工登出的身份缓存失效触点
  if (method === 'POST' && segments.length === 1 && segments[0] === 'signout') {
    ctx.emit('platform-user/signout')
    res.writeHead(204)
    res.end()
    return
  }

  // GET /api/enterprise/auth/config - 向前端暴露认证连接信息(按 provider 分支)
  if (method === 'GET' && segments.length === 1 && segments[0] === 'config') {
    // volatile 配置:每次请求读当前值,设置面板修改后无需重载即生效
    const resolved = resolveAuthSettings(config)
    if (resolved.provider === 'supabase') {
      // 顶层 url/anonKey 保留现有登录 UI(createClient(config.url, config.anonKey))
      // 兼容;supabaseUrl 为空 = 未配置合法初态,前端据此展示首启引导。
      sendJson(res, 200, {
        mode: 'supabase',
        url: resolved.supabaseUrl,
        anonKey: config.supabaseAnonKey.get(),
      })
    } else {
      // OIDC 模式:员工端授权码流程所需的 RP 参数;relayUrl 为 Pocket Access
      // 手机端登录的中转基地址,空串=未启用
      sendJson(res, 200, {
        mode: 'oidc',
        issuer: resolved.issuer,
        clientId: resolved.clientId,
        scopes: resolved.scopes,
        relayUrl: config.oidcRelayUrl.get(),
      })
    }
    return
  }

  // POST /api/enterprise/auth/connectivity-check - Node 侧连通性探测(登录页/设置面板共用)
  if (method === 'POST' && segments.length === 1 && segments[0] === 'connectivity-check') {
    const body = await readJsonBody(req)
    const rawUrl = typeof body === 'object' && body !== null && 'url' in body
      ? String(body.url).trim()
      : ''
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      sendJson(res, 400, { error: 'url 缺失或格式无效' })
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      sendJson(res, 400, { error: '仅支持 http/https 地址' })
      return
    }
    sendJson(res, 200, await probeConnectivity(rawUrl))
    return
  }

  // GET /api/enterprise/auth/oidc/callback - 授权码回调落点。根路径(index)受
  // webserver 认证墙保护,而认证中心发起的跨站导航不携带 SameSite=Strict 认证
  // cookie(钉钉等第三方 Provider 扫码路径即此形态;账号密码 iframe 路径经
  // postMessage 不落此端点),回调必须落在不受认证墙拦截的 API 路径上。父页面
  // (iframe 登录弹窗)读本页地址提取授权码;整页登录场景由本页脚本回跳根路径
  // (本站发起的导航,认证 cookie 随行)交给 SPA 的 readOidcCallback 消费。
  if (method === 'GET' && segments.length === 2 && segments[0] === 'oidc' && segments[1] === 'callback') {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const code = query.get('code') ?? ''
    const state = query.get('state') ?? ''
    if (code === '' || state === '') {
      sendJson(res, 400, { error: 'code、state 均为必填' })
      return
    }
    // 授权码/状态经 encodeURIComponent 转义后再 JSON.stringify 注入,杜绝脚本注入
    const backUrl = `/?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
    sendHtml(res, 200, callbackPageHtml(backUrl))
    return
  }

  // POST /api/enterprise/auth/oidc/relay-register - Pocket Access 手机端登录的
  // relay 会话登记转发。手机端经 pocket 代理只对同源发请求,浏览器直连
  // web-console 有 CORS 限制,由本地 webserver 的 Node 侧转发;登记数据
  // (state=包裹号,returnOrigin=回跳地址)由 relay 侧校验并落 5 分钟 TTL 会话表。
  if (method === 'POST' && segments.length === 2 && segments[0] === 'oidc' && segments[1] === 'relay-register') {
    const resolved = resolveAuthSettings(config)
    if (resolved.provider === 'supabase') {
      sendJson(res, 400, { error: 'oidc/relay-register 仅在 casdoor/customer-oidc 模式可用' })
      return
    }
    const relayUrl = config.oidcRelayUrl.get()
    if (relayUrl === '') {
      sendJson(res, 400, { error: 'relay 中转未配置(oidcRelayUrl 为空),手机端登录需配置 web-console 基地址' })
      return
    }
    const body = await readJsonBody(req)
    const state = typeof body === 'object' && body !== null && 'state' in body
      ? String((body as Record<string, unknown>).state).trim()
      : ''
    const returnOrigin = typeof body === 'object' && body !== null && 'returnOrigin' in body
      ? String((body as Record<string, unknown>).returnOrigin).trim()
      : ''
    if (state === '' || returnOrigin === '') {
      sendJson(res, 400, { error: 'state、returnOrigin 均为必填' })
      return
    }
    try {
      const response = await fetch(`${relayUrl.replace(/\/+$/, '')}/api/auth/dsh-relay/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, returnOrigin }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
      }
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendOidcUpstreamError(res, error)
    }
    return
  }

  // GET /api/enterprise/auth/oidc/authorize - 拼好 RP 参数后 302 跳认证中心授权页。
  // authorization_endpoint 因 provider 而异(Casdoor /login/oauth/authorize,Keycloak
  // /realms/<realm>/protocol/openid-connect/auth),经 discovery 解析;整页导航不受
  // CORS 限制,浏览器不能直接 fetch discovery。
  if (method === 'GET' && segments.length === 2 && segments[0] === 'oidc' && segments[1] === 'authorize') {
    const resolved = resolveAuthSettings(config)
    if (resolved.provider === 'supabase') {
      sendJson(res, 400, { error: 'oidc/authorize 仅在 casdoor/customer-oidc 模式可用' })
      return
    }
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const codeChallenge = query.get('code_challenge') ?? ''
    const state = query.get('state') ?? ''
    const redirectUri = query.get('redirect_uri') ?? ''
    if (codeChallenge === '' || state === '' || redirectUri === '') {
      sendJson(res, 400, { error: 'code_challenge、state、redirect_uri 均为必填' })
      return
    }
    try {
      const { authorizationEndpoint } = await resolveOidcEndpoints(resolved.issuer)
      const target = new URL(authorizationEndpoint)
      target.searchParams.set('client_id', resolved.clientId)
      target.searchParams.set('response_type', 'code')
      target.searchParams.set('redirect_uri', redirectUri)
      target.searchParams.set('scope', resolved.scopes)
      target.searchParams.set('state', state)
      target.searchParams.set('code_challenge', codeChallenge)
      target.searchParams.set('code_challenge_method', 'S256')
      // 换账号场景:强制认证中心重新认证,避免 SSO 静默重登同一账号
      if (query.get('prompt') === 'login') target.searchParams.set('prompt', 'login')
      // iframe 内嵌登录(前端传 popup=iframe):认证中心登录成功不 302 而是向父页面
      // postMessage code/state(Casdoor 原生行为),登录页不跳离 iframe
      if (query.get('popup') === 'iframe') {
        target.searchParams.set('popup', '1')
        target.searchParams.set('popup_type', 'iframe')
      }
      res.writeHead(302, { location: target.toString() })
      res.end()
    } catch (error) {
      sendOidcUpstreamError(res, error)
    }
    return
  }

  // POST /api/enterprise/auth/oidc/token - 授权码+PKCE 换 token(Node 侧执行,
  // 浏览器直连认证中心有 CORS 风险;Bearer = id_token,现有 JWKS 验签点直接验)
  if (method === 'POST' && segments.length === 2 && segments[0] === 'oidc' && segments[1] === 'token') {
    const resolved = resolveAuthSettings(config)
    if (resolved.provider === 'supabase') {
      sendJson(res, 400, { error: 'oidc/token 仅在 casdoor/customer-oidc 模式可用' })
      return
    }
    const body = await readJsonBody(req)
    const code = requireOidcField(body, 'code')
    const codeVerifier = requireOidcField(body, 'codeVerifier')
    const redirectUri = requireOidcField(body, 'redirectUri')
    try {
      const { tokenEndpoint } = await resolveOidcEndpoints(resolved.issuer)
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: resolved.clientId,
      })
      sendJson(res, 200, await runOidcGrant(tokenEndpoint, form))
    } catch (error) {
      sendOidcUpstreamError(res, error)
    }
    return
  }

  // POST /api/enterprise/auth/oidc/refresh - refresh_token grant 续期(D6:token
  // 生命周期归认证中心,本插件只透传 grant 不自研续签)
  if (method === 'POST' && segments.length === 2 && segments[0] === 'oidc' && segments[1] === 'refresh') {
    const resolved = resolveAuthSettings(config)
    if (resolved.provider === 'supabase') {
      sendJson(res, 400, { error: 'oidc/refresh 仅在 casdoor/customer-oidc 模式可用' })
      return
    }
    const refreshToken = requireOidcField(await readJsonBody(req), 'refreshToken')
    try {
      const { tokenEndpoint } = await resolveOidcEndpoints(resolved.issuer)
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: resolved.clientId,
      })
      sendJson(res, 200, await runOidcGrant(tokenEndpoint, form))
    } catch (error) {
      sendOidcUpstreamError(res, error)
    }
    return
  }

  sendJson(res, 404, { error: `no route for ${method} ${AUTH_ROUTE_PREFIX}/${segments.join('/')}` })
}

/**
 * 注册平台用户认证的 HTTP API 路由。
 * @param ctx - 携带 `webServer` 和 `platformUsers` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: AUTH_ROUTE_PREFIX,
      handler: async (req, res) => {
        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
        const segments = parseSegments(urlPath, AUTH_ROUTE_PREFIX)
        try {
          await dispatchAuth(ctx, config, req.method ?? 'GET', segments, req, res)
        } catch (error) {
          handleError(res, error)
        }
      },
    }),
  'platform-user-api: /api/enterprise/auth prefix route',
  )
}
