/**
 * 认证会话层:token 存储、认证模式、OIDC 授权码+PKCE 流程。
 * 独立于 React 组件,便于在无 DOM 的测试环境验证 PKCE、回调与刷新逻辑。
 */

import { sha256 } from '@noble/hashes/sha2.js'

/** 员工端认证模式:supabase 直连 Supabase Auth,oidc 走企业 IdP 授权码+PKCE。 */
export type AuthMode = 'supabase' | 'oidc'

/** /auth/config 的 mode 判别响应(supabase 直连 / OIDC 授权码+PKCE)。 */
export type AuthWebConfig =
  | { mode: 'supabase'; url: string; anonKey: string }
  | { mode: 'oidc'; issuer: string; clientId: string; scopes: string; relayUrl: string }

/** Node 侧令牌交换端点的响应(Bearer 用 id_token,现有 JWKS 验签点直接验)。 */
export type OidcTokenResult = { token: string; refreshToken: string; expiresIn: number }

const TOKEN_KEY = 'dsh.enterprise.token'
/** refresh_token 凭据(supabase 模式由 supabase-js 自管,不走这个 key)。 */
const REFRESH_TOKEN_KEY = 'dsh.enterprise.refresh'
/** OIDC 授权码流程的一次性 PKCE verifier 与 state(跳转离开页面回来后消费)。 */
const OIDC_VERIFIER_KEY = 'dsh.enterprise.oidc.verifier'
const OIDC_STATE_KEY = 'dsh.enterprise.oidc.state'
/** 匿名使用偏好:用户在登录页选择「匿名使用」后置位,放行未登录进入本机工作台。 */
const ANONYMOUS_PREFERENCE_KEY = 'dsh.enterprise.anonymous'

/** 当前认证模式,由 initAuth 读 config 后设置;module-level 供非响应式调用点读取。 */
let authMode: AuthMode = 'supabase'
/** OIDC 认证中心 issuer,由 initAuth 读 config 后设置;iframe 登录消息按其 origin 校验来源。 */
let oidcIssuer = ''
/**
 * web-console relay 中转基地址,由 initAuth 读 config 后设置;空串=relay 未启用。
 * 仅 Pocket Access 手机端登录(非 loopback 访问)使用,本机登录不经过 relay。
 */
let oidcRelayUrl = ''

/**
 * 读取当前认证模式(模块级快照,非响应式;组件应经由 auth snapshot 取值)。
 * @returns 当前认证模式。
 */
export function getAuthMode(): AuthMode {
  return authMode
}

/**
 * 设置认证模式,initAuth 读 config 后调用(测试环境用于模式切换)。
 * @param mode 目标认证模式。
 */
export function setAuthMode(mode: AuthMode): void {
  authMode = mode
}

/**
 * 读取认证中心 issuer(iframe 登录 postMessage 的 origin 校验用)。
 * @returns issuer;未设置时空串。
 */
export function getOidcIssuer(): string {
  return oidcIssuer
}

/**
 * 设置认证中心 issuer,initAuth 读 config 后调用;空串表示未设置(拒绝一切消息)。
 * @param issuer 认证中心 issuer。
 */
export function setOidcIssuer(issuer: string): void {
  oidcIssuer = issuer
}

/**
 * 读取 relay 中转基地址(测试用)。
 * @returns relay 基地址;未设置时空串。
 */
export function getOidcRelayUrl(): string {
  return oidcRelayUrl
}

/**
 * 设置 relay 中转基地址,initAuth 读 config 后调用;空串表示未启用(手机端退回
 * 旧的根路径回调,需在认证中心为每台手机登记回调地址)。
 * @param relayUrl relay 基地址。
 */
export function setOidcRelayUrl(relayUrl: string): void {
  oidcRelayUrl = relayUrl
}

/**
 * 读取本地 access token(localStorage)。
 * @returns access token;未登录时 null。
 */
export function readToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY)
}

/**
 * 写入本地 access token(localStorage)。
 * @param token 新 access token。
 */
export function writeToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token)
}

/** 清本地会话:access token 一律清;OIDC 模式连 refresh_token 一起清。 */
export function clearAuthSession(): void {
  window.localStorage.removeItem(TOKEN_KEY)
  if (authMode === 'oidc') window.localStorage.removeItem(REFRESH_TOKEN_KEY)
}

/**
 * 清除全部本地登录凭据(认证中心参数变更后的强制重登前置):access/refresh
 * token、OIDC PKCE 一次性凭据,以及 supabase-js 持久会话(localStorage
 * `sb-<project-ref>-auth-token`)。与 {@link clearAuthSession} 不同,不区分当前
 * 模式——provider 切换后旧模式的凭据按定义全部作废。不清匿名使用偏好
 * ({@link clearAnonymousPreference} 由 SSO 应用流程显式调用)。
 */
export function clearStoredLoginState(): void {
  window.localStorage.removeItem(TOKEN_KEY)
  window.localStorage.removeItem(REFRESH_TOKEN_KEY)
  window.sessionStorage.removeItem(OIDC_VERIFIER_KEY)
  window.sessionStorage.removeItem(OIDC_STATE_KEY)
  // 倒序遍历:removeItem 会收缩索引
  for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
    const key = window.localStorage.key(i)
    if (key !== null && key.startsWith('sb-')) window.localStorage.removeItem(key)
  }
}

/**
 * 读取匿名使用偏好(登录页「匿名使用」按钮置位;未登录但放行进入本机工作台)。
 * @returns 偏好开启与否。
 */
export function readAnonymousPreference(): boolean {
  return window.localStorage.getItem(ANONYMOUS_PREFERENCE_KEY) === '1'
}

/**
 * 置匿名使用偏好:登录页「匿名使用」按钮调用,后续启动未登录直接进入本机工作台。
 */
export function writeAnonymousPreference(): void {
  window.localStorage.setItem(ANONYMOUS_PREFERENCE_KEY, '1')
}

/**
 * 清匿名使用偏好。登录成功(升级为已登录)、退出登录(回登录页而非匿名态)、
 * 认证中心参数应用(强制重登)三处调用:偏好只在「匿名使用」到「下次登录」之间有效。
 */
export function clearAnonymousPreference(): void {
  window.localStorage.removeItem(ANONYMOUS_PREFERENCE_KEY)
}

/**
 * no-store:config 是 volatile 每次现读,浏览器缓存会让设置面板改完后的新值迟到。
 * @returns 认证配置(mode 判别:supabase 直连参数或 OIDC issuer/clientId/scopes)。
 */
export async function fetchAuthConfig(): Promise<AuthWebConfig> {
  const res = await fetch('api/enterprise/auth/config', { cache: 'no-store' })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`认证配置读取失败：${res.status} ${text}`)
  }
  return res.json() as Promise<AuthWebConfig>
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * SHA-256 摘要:优先 Web Crypto;crypto.subtle 仅存在于 secure context(HTTPS
 * 或 loopback),手机端 http://LAN-IP 访问(Pocket Access)缺失时回落
 * @noble/hashes 纯 JS 实现。crypto.getRandomValues 不受此限制,无需回落。
 * @param data 待摘要字节。
 * @returns 32 字节 SHA-256 摘要。
 */
async function sha256Bytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // DOM lib 类型认为 subtle 恒存在,浏览器非 secure context 运行时实际是 undefined
  const subtle = (globalThis.crypto as { subtle?: SubtleCrypto }).subtle
  if (subtle !== undefined) {
    return new Uint8Array(await subtle.digest('SHA-256', data))
  }
  return sha256(data)
}

/**
 * 当前访问是否为 loopback(本机 Electron 窗口/浏览器)入口。员工本机访问恒为
 * 127.0.0.1:3080(webserver 只绑 loopback),非 loopback 即 Pocket Access 手机端
 * (LAN IP 或隧道域名)。
 */
function isLoopbackAccess(): boolean {
  const hostname = window.location.hostname
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/** relay 中转回调路径(与 web-console OauthRelayController 的路由对齐)。 */
const RELAY_CALLBACK_PATH = '/api/auth/dsh-relay/callback'

/**
 * 按访问形态计算 redirect_uri:loopback 访问 -> 专用回调端点(API 路径不受
 * webserver 认证墙拦截,钉钉等第三方 Provider 扫码的 302 回调不再撞 401);
 * 手机端且 relay 已启用 -> 固定的 relay 回调地址(手机 LAN/公网地址无法在
 * 认证中心枚举登记,redirect_uri 与实际地址解耦);relay 未启用 -> 旧的根路径
 * (兼容兜底,需在认证中心为每台手机手工登记回调地址)。
 */
function getOidcRedirectUri(): string {
  if (isLoopbackAccess()) {
    return `${window.location.origin}/api/enterprise/auth/oidc/callback`
  }
  if (oidcRelayUrl !== '') {
    return `${oidcRelayUrl}${RELAY_CALLBACK_PATH}`
  }
  return `${window.location.origin}/`
}

/**
 * relay 会话登记(仅 relay 模式调用):state 一物两用作包裹号,把本次访问的
 * origin 登记到 web-console,relay 收到认证中心 302 后按 state 查表回跳该
 * origin。浏览器直连 web-console 有 CORS 限制,经本地 webserver 转发端点
 * (api/enterprise/auth/oidc/relay-register)。
 * @param state 本次生成的 authorize state(兼作 relay 会话号)。
 */
async function registerRelaySession(state: string): Promise<void> {
  const res = await fetch('api/enterprise/auth/oidc/relay-register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, returnOrigin: window.location.origin }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`relay 会话登记失败：${res.status} ${text}`)
  }
}

/**
 * 拼 OIDC authorize 端点 URL:生成并暂存一次性 PKCE verifier/state 到 sessionStorage,
 * query 含 redirect_uri/code_challenge/state。relay 模式(手机端且 relay 已启用)先
 * 用 state 登记中转会话,redirect_uri 恒为认证中心白名单里的 relay 回调地址。
 * promptLogin 追加 prompt=login(强制认证中心重新认证,避免其残留会话
 * 静默重登同一账号——退出登录只清 DSH 侧会话,认证中心会话仍在浏览器);
 * popupIframe 追加 popup=iframe(认证中心登录页被 iframe 内嵌,登录成功
 * 不 302 而是 postMessage code/state 给父页面,Casdoor 原生行为,父页面经
 * {@link readOidcLoginSuccessMessage} 消费)。
 * @param options promptLogin=true 追加 prompt=login;popupIframe=true 追加 popup=iframe。
 * @returns authorize 端点相对 URL(含一次性 PKCE query)。
 */
export async function buildOidcAuthorizeUrl(options: {
  promptLogin: boolean
  popupIframe: boolean
}): Promise<string> {
  if (authMode !== 'oidc') throw new Error('当前不是认证中心登录模式')
  const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64urlEncode(await sha256Bytes(new TextEncoder().encode(verifier)))
  const state = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
  if (!isLoopbackAccess() && oidcRelayUrl !== '') {
    await registerRelaySession(state)
  }
  window.sessionStorage.setItem(OIDC_VERIFIER_KEY, verifier)
  window.sessionStorage.setItem(OIDC_STATE_KEY, state)
  const query = new URLSearchParams({
    redirect_uri: getOidcRedirectUri(),
    code_challenge: challenge,
    state,
  })
  if (options.promptLogin) query.set('prompt', 'login')
  if (options.popupIframe) query.set('popup', 'iframe')
  return `api/enterprise/auth/oidc/authorize?${query}`
}

/**
 * 认证中心回环检测:SPA 根路径 query 带 code+state 即授权码回调。
 * @returns 回调凭据;query 不齐时 null。
 */
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
 * @param event window message 事件。
 * @param expectedIssuer 认证中心 issuer(空串一律拒绝)。
 * @returns 授权码与 state;来源或载荷不合法时 null。
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
 * 完成授权码交换:校验 state → Node 侧换 token → 写本地会话。
 * 无论成败都先清地址栏 query 与 sessionStorage 一次性凭据(刷新不应重放已用过的 code)。
 * @param callback 地址栏回调凭据(readOidcCallback 的返回值)。
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
  const res = await fetch('api/enterprise/auth/oidc/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: callback.code, codeVerifier: verifier, redirectUri: getOidcRedirectUri() }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`认证中心令牌交换失败：${res.status} ${text}`)
  }
  const result = await res.json() as OidcTokenResult
  writeToken(result.token)
  if (result.refreshToken !== '') {
    window.localStorage.setItem(REFRESH_TOKEN_KEY, result.refreshToken)
  }
}

/**
 * OIDC refresh_token grant 续期:成功写回新 id_token/refresh_token。
 * @returns 续期成功与否;无 refresh token、上游失败一律 false。
 */
export async function tryOidcRefresh(): Promise<boolean> {
  const refreshToken = window.localStorage.getItem(REFRESH_TOKEN_KEY)
  if (refreshToken === null || refreshToken === '') return false
  try {
    const res = await fetch('api/enterprise/auth/oidc/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) return false
    const result = await res.json() as OidcTokenResult
    writeToken(result.token)
    if (result.refreshToken !== '') {
      window.localStorage.setItem(REFRESH_TOKEN_KEY, result.refreshToken)
    }
    return true
  } catch {
    return false
  }
}
