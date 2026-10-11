/**
 * launch token 握手（设计 §6.2.4/§6.2.5）。
 *
 * 手机端首次导航 `GET /` 时把桌面 launch token 补进上游 URL（`?token=`），
 * 上游 webserver 以 303 + Set-Cookie 种下 `dsh-auth-<sha256(authority)>` cookie。
 * Safari 忽略该 303 上的 Set-Cookie，故把 303 改写为 200 过渡页（保留 Set-Cookie、
 * meta refresh 0 跳 `/`）。按 IP 记录注入次数防异常循环握手。
 *
 * launch token 每次进程重启重新生成，每次握手即时取用，不缓存跨重启。
 */
/** 注入时补 token 的 query 参数名。 */
export const LAUNCH_TOKEN_QUERY_KEY = 'token'

/** 强制重握手的控制参数（注入时从转发 URL 剥除，不进上游）。 */
export const REAUTH_QUERY_KEY = '__pocket_reauth'

/** 上游种下的宿主认证 cookie 名前缀。 */
export const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** 同一 IP 在窗口内允许的注入次数（达到后 HTML 导航 503）。 */
export const HANDSHAKE_INJECTION_LIMIT = 3

/** 注入计数窗口（毫秒）。 */
export const HANDSHAKE_INJECTION_WINDOW_MS = 60_000

/**
 * 从 authenticatedUrl 返回的 URL 中解析 launch token。
 * @param url 含 query 的完整 URL
 * @returns query 中 `token` 参数的值；URL 非法或参数缺失时为空字符串
 */
export function parseTokenFromUrl(url: string): string {
  try {
    return new URL(url).searchParams.get(LAUNCH_TOKEN_QUERY_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * 解析 Cookie 头里的 cookie 名列表（值不校验）。
 * @param cookieHeader 请求的 Cookie 头原文；undefined 或空视为无 cookie
 * @returns 按出现顺序排列的 cookie 名数组，空白名已剔除
 */
export function parseCookieNames(cookieHeader: string | undefined): string[] {
  if (cookieHeader === undefined || cookieHeader === '') return []
  const names: string[] = []
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    const name = (eq === -1 ? part : part.slice(0, eq)).trim()
    if (name !== '') names.push(name)
  }
  return names
}

/**
 * 请求是否携带上游宿主认证 cookie（任何 `dsh-auth-` 前缀成员即算）。
 * @param cookieHeader 请求的 Cookie 头原文
 * @returns 存在任何 `dsh-auth-` 前缀的 cookie 名时为 true
 */
export function hasAuthCookie(cookieHeader: string | undefined): boolean {
  return parseCookieNames(cookieHeader).some(name => name.startsWith(DSH_AUTH_COOKIE_PREFIX))
}

/**
 * 请求 Accept 头是否表明 HTML 导航。
 * @param acceptHeader 请求的 Accept 头原文
 * @returns 头存在且含 `text/html` 时为 true
 */
export function isHtmlNavigation(acceptHeader: string | undefined): boolean {
  return acceptHeader !== undefined && acceptHeader.includes('text/html')
}

/**
 * 请求 URL 的 query 是否带强制重握手标记。
 * @param pathWithQuery 可能带 query 的请求路径（不含 authority）
 * @returns query 中 `__pocket_reauth=1` 时为 true；解析失败为 false
 */
export function hasReauthFlag(pathWithQuery: string): boolean {
  try {
    return new URL(pathWithQuery, 'http://pocket.invalid').searchParams.get(REAUTH_QUERY_KEY) === '1'
  } catch {
    return false
  }
}

/** 握手依赖面：launch token 获取由宿主接线（index.ts 用 ctx.connection.authenticatedUrl 包装）。 */
export interface HandshakeDeps {
  /** 即时取当前 launch token；connection 不可用或取用失败时 reject。 */
  getLaunchToken(): Promise<string>
}

/** 单 IP 注入计数条目（固定窗口）。 */
interface InjectionEntry {
  count: number
  windowStart: number
}

/** 握手管理器：注入判定、URL 改写、Safari 过渡页、按 IP 重试限速。 */
export class HandshakeManager {
  private readonly injections = new Map<string, InjectionEntry>()

  constructor(
    private readonly deps: HandshakeDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 即时取 launch token（每次握手调用，不缓存跨重启）；失败透传给调用方。
   * @returns 当前进程的 launch token；取用失败时 promise reject
   */
  async getLaunchToken(): Promise<string> {
    return this.deps.getLaunchToken()
  }

  /**
   * 是否为注入候选：仅 `GET /`，且（无 `dsh-auth-` cookie 或带 `__pocket_reauth=1`）。
   * token 是否非空由调用方取得 token 后再判。
   * @param input 请求方法、路径、Cookie 头与 reauth 标记
   * @returns 该请求需要注入 launch token 时为 true
   */
  isInjectCandidate(input: {
    method: string
    path: string
    cookieHeader: string | undefined
    reauth: boolean
  }): boolean {
    if (input.method !== 'GET') return false
    if (input.path !== '/') return false
    if (hasAuthCookie(input.cookieHeader)) return input.reauth
    return true
  }

  /**
   * 把 token 补进上游 URL query；剥除 `__pocket_reauth` 控制参数，其余 query 原样保留。
   * @param pathWithQuery 可能带 query 的请求路径（不含 authority）
   * @param token 当前 launch token
   * @returns 已补入 `token` 参数并剥除 reauth 参数的路径与 query
   */
  buildUpstreamUrl(pathWithQuery: string, token: string): string {
    const url = new URL(pathWithQuery, 'http://pocket.invalid')
    url.searchParams.delete(REAUTH_QUERY_KEY)
    url.searchParams.set(LAUNCH_TOKEN_QUERY_KEY, token)
    return url.pathname + url.search
  }

  /**
   * Safari 过渡页改写判定：本轮已注入 token 且上游返回 303。
   * 上游认证重定向固定为 303（M0 实测），其余状态码不改写。
   * @param input 上游状态码与本轮是否已注入 token
   * @returns 需要把 303 改写为 200 过渡页时为 true
   */
  shouldRewriteRedirect(input: { upstreamStatusCode: number; injectedToken: boolean }): boolean {
    return input.injectedToken && input.upstreamStatusCode === 303
  }

  /**
   * Safari 过渡页 HTML：meta refresh 0 跳 `/`（Set-Cookie 头由代理层原样保留）。
   * @returns 完整的过渡页 HTML 文档文本
   */
  renderInterimPage(): string {
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta http-equiv="refresh" content="0; url=/">',
      '<title>正在登录 DSH…</title>',
      '</head>',
      '<body>',
      '<p>登录处理中，即将返回…</p>',
      '</body>',
      '</html>',
    ].join('\n')
  }

  /**
   * 注入即记录（窗口内达到上限后 isLimited）。
   * @param ip 发起请求的客户端 IP
   */
  noteInjection(ip: string): void {
    const nowMs = this.now()
    const entry = this.injections.get(ip)
    if (entry === undefined || nowMs - entry.windowStart >= HANDSHAKE_INJECTION_WINDOW_MS) {
      this.injections.set(ip, { count: 1, windowStart: nowMs })
      return
    }
    entry.count += 1
  }

  /**
   * 该 IP 窗口内注入次数是否已达上限（超限后 HTML 导航 503）。
   * @param ip 客户端 IP
   * @returns 窗口内注入次数已达到 HANDSHAKE_INJECTION_LIMIT 时为 true
   */
  isLimited(ip: string): boolean {
    const entry = this.injections.get(ip)
    if (entry === undefined) return false
    if (this.now() - entry.windowStart >= HANDSHAKE_INJECTION_WINDOW_MS) {
      this.injections.delete(ip)
      return false
    }
    return entry.count >= HANDSHAKE_INJECTION_LIMIT
  }

  /**
   * 请求携带 `dsh-auth-` cookie（握手成功）即清零该 IP 注入计数。
   * @param cookieHeader 请求的 Cookie 头原文
   * @param ip 客户端 IP
   */
  clearIfAuthenticated(cookieHeader: string | undefined, ip: string): void {
    if (hasAuthCookie(cookieHeader)) this.injections.delete(ip)
  }
}
