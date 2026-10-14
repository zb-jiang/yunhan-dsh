/**
 * 认证会话层:token 存储、认证模式、OIDC 授权码+PKCE 流程。
 *
 * <p>对称员工端 ui-enterprise 的 auth-session;存储 key 用 {@code dsh.console.*}
 * 前缀,与员工端({@code dsh.enterprise.*})不冲突。独立于 React 与 axios
 * (client.ts 引用本模块,故这里只用裸 fetch)。
 *
 * <p>后端响应是 ApiResponse 包装(与员工端 webserver 的裸 JSON 不同),统一经
 * {@link unwrapApiResponse} 解包;config/token/refresh 端点均 permitAll,不带走
 * Authorization 头。
 */

export type AuthMode = 'supabase' | 'oidc'

/** /api/auth/config 的 mode 判别响应(supabase 直连 / OIDC 授权码+PKCE)。 */
export type AuthWebConfig =
  | { mode: 'supabase'; url: string; anonKey: string }
  | { mode: 'oidc'; issuer: string; clientId: string; scopes: string }

/** /api/auth/oidc/token|refresh 的 data(Bearer 用 id_token,后端 JWKS 验签点直接验)。 */
export type OidcTokenResult = { token: string; refreshToken: string; expiresIn: number }

const TOKEN_KEY = 'dsh.console.token'
/** refresh_token 凭据(supabase 模式由 supabase-js 自管,不走这个 key)。 */
const REFRESH_TOKEN_KEY = 'dsh.console.refresh'
/** OIDC 授权码流程的一次性 PKCE verifier 与 state(跳转离开页面回来后消费)。 */
const OIDC_VERIFIER_KEY = 'dsh.console.oidc.verifier'
const OIDC_STATE_KEY = 'dsh.console.oidc.state'

/** 与 client.ts 一致的后端地址:dev 为空走 Vite proxy,生产由 VITE_API_BASE_URL 指向后端。 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

/** 当前认证模式,由 initAuth 读 config 后设置;module-level 供非响应式调用点读取。 */
let authMode: AuthMode = 'supabase'
/** OIDC 认证中心 issuer,由 initAuth 读 config 后设置;iframe 登录消息按其 origin 校验来源。 */
let oidcIssuer = ''

export function getAuthMode(): AuthMode {
  return authMode
}

export function setAuthMode(mode: AuthMode): void {
  authMode = mode
}

export function getOidcIssuer(): string {
  return oidcIssuer
}

export function setOidcIssuer(issuer: string): void {
  oidcIssuer = issuer
}

export function readToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY)
}

export function writeToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token)
}

/** 清本地会话:access token 一律清;OIDC 模式连 refresh_token 一起清。 */
export function clearAuthSession(): void {
  window.localStorage.removeItem(TOKEN_KEY)
  if (authMode === 'oidc') window.localStorage.removeItem(REFRESH_TOKEN_KEY)
}

/**
 * 解包后端 ApiResponse:success → data;非 ok 或 fail → 抛带 error.message 的 Error。
 */
async function unwrapApiResponse<T>(res: Response, action: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: { message?: string } }
    | null
  if (res.ok && body?.success === true) return body.data as T
  throw new Error(`${action}失败:${res.status} ${body?.error?.message ?? res.statusText}`)
}

/** no-store:config 是 volatile 每次现读,部署调整 SSO 配置后新值不迟到。 */
export async function fetchAuthConfig(): Promise<AuthWebConfig> {
  const res = await fetch(`${API_BASE}/api/auth/config`, { cache: 'no-store' })
  return unwrapApiResponse<AuthWebConfig>(res, '认证配置读取')
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** SPA 根路径即 redirect_uri:认证中心登记后 302 回 ?code=&state=。 */
function getOidcRedirectUri(): string {
  return `${window.location.origin}/`
}

/**
 * 拼 OIDC authorize 端点 URL:生成并暂存一次性 PKCE verifier/state 到 sessionStorage,
 * query 含 redirect_uri/code_challenge/state。promptLogin 追加 prompt=login(换账号
 * 强制认证中心重新认证,避免 SSO 静默重登同一账号);popupIframe 追加 popup=iframe
 * (认证中心登录页被 iframe 内嵌,登录成功不 302 而是 postMessage code/state 给父页面,
 * Casdoor 原生行为,父页面经 {@link readOidcLoginSuccessMessage} 消费)。
 */
export async function buildOidcAuthorizeUrl(options: {
  promptLogin: boolean
  popupIframe: boolean
}): Promise<string> {
  if (authMode !== 'oidc') throw new Error('当前不是认证中心登录模式')
  const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64urlEncode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  )
  const state = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
  window.sessionStorage.setItem(OIDC_VERIFIER_KEY, verifier)
  window.sessionStorage.setItem(OIDC_STATE_KEY, state)
  const query = new URLSearchParams({
    redirect_uri: getOidcRedirectUri(),
    code_challenge: challenge,
    state,
  })
  if (options.promptLogin) query.set('prompt', 'login')
  if (options.popupIframe) query.set('popup', 'iframe')
  return `${API_BASE}/api/auth/oidc/authorize?${query}`
}

/** 发起 OIDC 授权码+PKCE 整页跳转(iframe 内嵌登录改走 buildOidcAuthorizeUrl + Modal)。 */
export async function startOidcAuthorize(options: { promptLogin: boolean }): Promise<void> {
  window.location.assign(await buildOidcAuthorizeUrl({ ...options, popupIframe: false }))
}

/** 认证中心回环检测:SPA 根路径 query 带 code+state 即授权码回调。 */
export function readOidcCallback(): { code: string; state: string } | null {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const state = params.get('state')
  return code !== null && state !== null ? { code, state } : null
}

/**
 * 解析认证中心 iframe 内嵌登录的 postMessage(Casdoor 原生 loginSuccess:
 * {type: "loginSuccess", data: {code, state}},targetOrigin 为本页 origin)。
 * 仅接受 origin 与 issuer 同源且 type 匹配的事件;SilentSignin 等其他消息返回 null。
 */
export function readOidcLoginSuccessMessage(
  event: MessageEvent,
  expectedIssuer: string,
): { code: string; state: string } | null {
  if (expectedIssuer === '' || event.origin !== new URL(expectedIssuer).origin) return null
  const data = event.data as { type?: unknown; data?: { code?: unknown; state?: unknown } } | null
  if (data === null || typeof data !== 'object' || data.type !== 'loginSuccess') return null
  const { code, state } = data.data ?? {}
  if (typeof code !== 'string' || typeof state !== 'string') return null
  return { code, state }
}

/**
 * 完成授权码交换:校验 state → 后端代理换 token → 写本地会话。
 * 无论成败都先清地址栏 query 与 sessionStorage 一次性凭据(刷新不应重放已用过的 code)。
 */
export async function completeOidcCallback(callback: { code: string; state: string }): Promise<void> {
  window.history.replaceState(null, '', window.location.pathname)
  const savedState = window.sessionStorage.getItem(OIDC_STATE_KEY)
  const verifier = window.sessionStorage.getItem(OIDC_VERIFIER_KEY)
  window.sessionStorage.removeItem(OIDC_STATE_KEY)
  window.sessionStorage.removeItem(OIDC_VERIFIER_KEY)
  if (savedState === null || savedState !== callback.state || verifier === null) {
    throw new Error('登录状态校验失败，请重新发起登录')
  }
  const res = await fetch(`${API_BASE}/api/auth/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: callback.code, codeVerifier: verifier, redirectUri: getOidcRedirectUri() }),
  })
  const result = await unwrapApiResponse<OidcTokenResult>(res, '认证中心令牌交换')
  writeToken(result.token)
  if (result.refreshToken !== '') {
    window.localStorage.setItem(REFRESH_TOKEN_KEY, result.refreshToken)
  }
}

/** OIDC refresh_token grant 续期:成功写回新 id_token/refresh_token 并返回 true。 */
export async function tryOidcRefresh(): Promise<boolean> {
  const refreshToken = window.localStorage.getItem(REFRESH_TOKEN_KEY)
  if (refreshToken === null || refreshToken === '') return false
  try {
    const res = await fetch(`${API_BASE}/api/auth/oidc/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) return false
    const result = await unwrapApiResponse<OidcTokenResult>(res, '会话续期')
    writeToken(result.token)
    if (result.refreshToken !== '') {
      window.localStorage.setItem(REFRESH_TOKEN_KEY, result.refreshToken)
    }
    return true
  } catch {
    return false
  }
}
