import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildOidcAuthorizeUrl,
  clearAuthSession,
  completeOidcCallback,
  fetchAuthConfig,
  getOidcIssuer,
  readOidcCallback,
  readOidcLoginSuccessMessage,
  readToken,
  setAuthMode,
  setOidcIssuer,
  setOidcRelayUrl,
  tryOidcRefresh,
  writeToken,
} from '../src/client/auth-session.ts'

// 与 auth-session.ts 内部常量同口径的存储键名(白盒断言用)。
const TOKEN_KEY = 'dsh.enterprise.token'
const REFRESH_KEY = 'dsh.enterprise.refresh'
const VERIFIER_KEY = 'dsh.enterprise.oidc.verifier'
const STATE_KEY = 'dsh.enterprise.oidc.state'

/** 构造无 DOM 的浏览器环境:Map 存储 + 可变 search 的 location + 记录型 history。 */
function makeBrowser() {
  const localStorageMap = new Map<string, string>()
  const sessionStorageMap = new Map<string, string>()
  const storage = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  })
  const historyUrls: string[] = []
  const location = {
    origin: 'http://localhost:3080',
    hostname: 'localhost',
    pathname: '/',
    search: '',
  }
  const history = {
    replaceState: vi.fn((_state: unknown, _title: unknown, url: string) => {
      historyUrls.push(url)
      // 对齐浏览器行为:replaceState 到 pathname 会清掉 query
      location.search = ''
    }),
  }
  vi.stubGlobal('window', {
    localStorage: storage(localStorageMap),
    sessionStorage: storage(sessionStorageMap),
    location,
    history,
  })
  return { localStorageMap, sessionStorageMap, historyUrls, location }
}

/** 从 assign 的 authorize URL 中取 query。 */
function assignedQuery(url: string): URLSearchParams {
  return new URLSearchParams(url.split('?')[1])
}

/** Node 全局 webcrypto 快照(import 时捕获,用例内 stub 全局 crypto 不影响对照口径)。 */
const nodeWebCrypto = globalThis.crypto

/** 与实现同口径的 S256 challenge 计算(Node webcrypto,无需 stub)。 */
async function expectedChallenge(verifier: string): Promise<string> {
  return Buffer.from(await nodeWebCrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
}

describe('auth-session(OIDC 授权码+PKCE 客户端逻辑)', () => {
  let browser: ReturnType<typeof makeBrowser>

  beforeEach(() => {
    browser = makeBrowser()
    // 模块级 authMode/oidcIssuer/oidcRelayUrl 跨用例持久,每用例显式重置;supabase 用例内自行切换
    setAuthMode('oidc')
    setOidcIssuer('')
    setOidcRelayUrl('')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('buildOidcAuthorizeUrl', () => {
    it('popupIframe=true 返回带 popup=iframe 的 authorize URL 并落一次性凭据', async () => {
      const url = await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: true })
      expect(url.startsWith('api/enterprise/auth/oidc/authorize?')).toBe(true)
      const query = assignedQuery(url)
      expect(query.get('popup')).toBe('iframe')
      expect(query.get('prompt')).toBeNull()
      // PKCE 一次性凭据随 URL 生成落库
      const state = query.get('state')
      expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(browser.sessionStorageMap.get(STATE_KEY)).toBe(state)
      const verifier = browser.sessionStorageMap.get(VERIFIER_KEY)
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(query.get('code_challenge')).toBe(await expectedChallenge(verifier!))
    })

    it('promptLogin=true 透传 prompt=login(退出后防认证中心会话静默重登)', async () => {
      const query = assignedQuery(await buildOidcAuthorizeUrl({ promptLogin: true, popupIframe: true }))
      expect(query.get('prompt')).toBe('login')
      expect(query.get('popup')).toBe('iframe')
    })

    it('popupIframe=false 不带 popup 参数', async () => {
      const query = assignedQuery(await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: false }))
      expect(query.has('popup')).toBe(false)
    })

    it('crypto.subtle 缺失(手机端 http 非 secure context)时回落 noble sha256 且摘要一致', async () => {
      // 非 secure context 形态:crypto 对象存在但无 subtle(getRandomValues 仍可用)
      vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
      const url = await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: true })
      const verifier = browser.sessionStorageMap.get(VERIFIER_KEY)!
      // 回落路径与 Web Crypto digest 对同一 verifier 产出相同 challenge
      expect(assignedQuery(url).get('code_challenge')).toBe(await expectedChallenge(verifier))
    })
  })

  describe('relay 模式(Pocket Access 手机端登录)', () => {
    const RELAY_BASE = 'http://server:8080'
    const PHONE_ORIGIN = 'http://192.168.1.5:3081'

    /** 把 location 切到手机端形态(非 loopback)。 */
    function asPocketAccess(): void {
      browser.location.origin = PHONE_ORIGIN
      browser.location.hostname = '192.168.1.5'
    }

    /** stub relay 登记成功的 fetch(带 init 类型使 mock.calls 可安全断言)。 */
    function stubRelayRegister() {
      const fetchMock = vi.fn(async (_input: unknown, _init?: { body?: string }) =>
        new Response(JSON.stringify({ success: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('relay 已启用时 redirect_uri 指向 relay 回调并登记中转会话', async () => {
      asPocketAccess()
      setOidcRelayUrl(RELAY_BASE)
      const fetchMock = stubRelayRegister()

      const url = await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: true })
      const query = assignedQuery(url)
      expect(query.get('redirect_uri')).toBe(`${RELAY_BASE}/api/auth/dsh-relay/callback`)
      // state 一物两用:登记请求体里的 state 与 authorize query 里的一致
      expect(fetchMock.mock.calls).toHaveLength(1)
      expect(String(fetchMock.mock.calls[0]![0])).toBe('api/enterprise/auth/oidc/relay-register')
      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body!)).toEqual({
        state: query.get('state'),
        returnOrigin: PHONE_ORIGIN,
      })
    })

    it('relay 模式下令牌交换沿用 relay 回调地址(与发起一致)', async () => {
      asPocketAccess()
      setOidcRelayUrl(RELAY_BASE)
      const fetchMock = vi.fn(async (_input: unknown, _init?: { body?: string }) =>
        new Response(JSON.stringify({ token: 'id-token-1', refreshToken: 'r-1', expiresIn: 3600 }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const url = await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: true })
      const state = assignedQuery(url).get('state')!
      await completeOidcCallback({ code: 'auth-code', state })
      const exchangeBody = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]![1]!.body!) as { redirectUri: string }
      expect(exchangeBody.redirectUri).toBe(`${RELAY_BASE}/api/auth/dsh-relay/callback`)
    })

    it('relay 登记失败时拒绝发起登录', async () => {
      asPocketAccess()
      setOidcRelayUrl(RELAY_BASE)
      vi.stubGlobal('fetch', vi.fn(async () => new Response('relay down', { status: 502 })))

      await expect(buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: true }))
        .rejects.toThrow('relay 会话登记失败：502')
    })

    it('relay 未启用时手机端退回旧的根路径回调且不登记', async () => {
      asPocketAccess()
      const fetchMock = stubRelayRegister()

      const url = await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: true })
      expect(assignedQuery(url).get('redirect_uri')).toBe(`${PHONE_ORIGIN}/`)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('loopback 访问即便配置了 relay 也不走 relay', async () => {
      setOidcRelayUrl(RELAY_BASE)
      const fetchMock = stubRelayRegister()

      const url = await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: true })
      expect(assignedQuery(url).get('redirect_uri')).toBe('http://localhost:3080/api/enterprise/auth/oidc/callback')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('readOidcLoginSuccessMessage', () => {
    const ISSUER = 'https://idp.example.com'

    /** 构造携带 origin/data 的 message 事件。 */
    function messageOf(origin: string, data: unknown): MessageEvent {
      return new MessageEvent('message', { origin, data })
    }

    it('未设置 issuer 时一律拒绝', () => {
      expect(readOidcLoginSuccessMessage(messageOf(ISSUER, { type: 'loginSuccess' }), getOidcIssuer())).toBeNull()
    })

    it('origin 与 issuer 不符拒绝', () => {
      setOidcIssuer(ISSUER)
      expect(readOidcLoginSuccessMessage(messageOf('https://evil.example.com', { type: 'loginSuccess' }), getOidcIssuer())).toBeNull()
    })

    it('非 loginSuccess 消息与缺 code/state 均拒绝', () => {
      setOidcIssuer(ISSUER)
      expect(readOidcLoginSuccessMessage(messageOf(ISSUER, { type: 'other' }), getOidcIssuer())).toBeNull()
      expect(readOidcLoginSuccessMessage(messageOf(ISSUER, { type: 'loginSuccess' }), getOidcIssuer())).toBeNull()
      expect(readOidcLoginSuccessMessage(messageOf(ISSUER, { type: 'loginSuccess', data: { code: 'c' } }), getOidcIssuer())).toBeNull()
    })

    it('合法 loginSuccess 消息提取 code+state', () => {
      setOidcIssuer(ISSUER)
      expect(getOidcIssuer()).toBe(ISSUER)
      expect(readOidcLoginSuccessMessage(messageOf(ISSUER, { type: 'loginSuccess', data: { code: 'auth-code', state: 's1' } }), getOidcIssuer())).toEqual({
        code: 'auth-code',
        state: 's1',
      })
    })
  })

  describe('readOidcCallback', () => {
    it('code+state 齐全才识别为回调', () => {
      expect(readOidcCallback()).toBeNull()
      browser.location.search = '?code=abc'
      expect(readOidcCallback()).toBeNull()
      browser.location.search = '?code=abc&state=xyz'
      expect(readOidcCallback()).toEqual({ code: 'abc', state: 'xyz' })
    })
  })

  describe('completeOidcCallback', () => {
    it('完成令牌交换并落库会话', async () => {
      const fetchMock = vi.fn(async (_input: unknown, _init?: { body?: string }) =>
        new Response(JSON.stringify({ token: 'id-token-1', refreshToken: 'refresh-1', expiresIn: 3600 }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      // 先走真实 authorize 拿到 state,再模拟认证中心 302 回环
      const authorizeUrl = await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: false })
      const state = assignedQuery(authorizeUrl).get('state')!
      const verifier = browser.sessionStorageMap.get(VERIFIER_KEY)!
      browser.location.search = `?code=auth-code&state=${state}`
      await completeOidcCallback(readOidcCallback()!)
      // 地址栏 query 已清,一次性凭据已删
      expect(browser.historyUrls).toEqual(['/'])
      expect(browser.location.search).toBe('')
      expect(browser.sessionStorageMap.has(VERIFIER_KEY)).toBe(false)
      expect(browser.sessionStorageMap.has(STATE_KEY)).toBe(false)
      // 会话落库
      expect(browser.localStorageMap.get(TOKEN_KEY)).toBe('id-token-1')
      expect(browser.localStorageMap.get(REFRESH_KEY)).toBe('refresh-1')
      // 交换请求携带 code/codeVerifier/redirectUri(与发起时的 loopback 回调地址一致)
      expect(fetchMock.mock.calls).toHaveLength(1)
      expect(String(fetchMock.mock.calls[0]![0])).toBe('api/enterprise/auth/oidc/token')
      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body!)).toEqual({
        code: 'auth-code',
        codeVerifier: verifier,
        redirectUri: 'http://localhost:3080/api/enterprise/auth/oidc/callback',
      })
    })

    it('state 不匹配时拒绝且一次性凭据已清', async () => {
      browser.sessionStorageMap.set(STATE_KEY, 'expected-state')
      browser.sessionStorageMap.set(VERIFIER_KEY, 'verifier-1')
      browser.location.search = '?code=auth-code&state=wrong-state'
      await expect(completeOidcCallback(readOidcCallback()!)).rejects.toThrow('登录状态校验失败，请重新发起登录')
      expect(browser.sessionStorageMap.has(STATE_KEY)).toBe(false)
      expect(browser.sessionStorageMap.has(VERIFIER_KEY)).toBe(false)
      expect(browser.historyUrls).toEqual(['/'])
    })
  })

  describe('tryOidcRefresh', () => {
    it('无 refresh token 时返回 false', async () => {
      await expect(tryOidcRefresh()).resolves.toBe(false)
    })

    it('成功续期并写回新会话', async () => {
      browser.localStorageMap.set(REFRESH_KEY, 'refresh-old')
      browser.localStorageMap.set(TOKEN_KEY, 'id-token-old')
      const fetchMock = vi.fn(async (_input: unknown) =>
        new Response(JSON.stringify({ token: 'id-token-new', refreshToken: 'refresh-new', expiresIn: 3600 }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(tryOidcRefresh()).resolves.toBe(true)
      expect(String(fetchMock.mock.calls[0]![0])).toBe('api/enterprise/auth/oidc/refresh')
      expect(browser.localStorageMap.get(TOKEN_KEY)).toBe('id-token-new')
      expect(browser.localStorageMap.get(REFRESH_KEY)).toBe('refresh-new')
    })

    it('上游失败时返回 false 且会话不变', async () => {
      browser.localStorageMap.set(REFRESH_KEY, 'refresh-old')
      browser.localStorageMap.set(TOKEN_KEY, 'id-token-old')
      vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
      await expect(tryOidcRefresh()).resolves.toBe(false)
      expect(browser.localStorageMap.get(TOKEN_KEY)).toBe('id-token-old')
      expect(browser.localStorageMap.get(REFRESH_KEY)).toBe('refresh-old')
    })
  })

  describe('clearAuthSession 与 token 存储', () => {
    it('token 读写走 localStorage', () => {
      expect(readToken()).toBeNull()
      writeToken('id-token-1')
      expect(readToken()).toBe('id-token-1')
    })

    it('OIDC 模式连 refresh 一起清', () => {
      browser.localStorageMap.set(TOKEN_KEY, 'id-token-1')
      browser.localStorageMap.set(REFRESH_KEY, 'refresh-1')
      clearAuthSession()
      expect(browser.localStorageMap.has(TOKEN_KEY)).toBe(false)
      expect(browser.localStorageMap.has(REFRESH_KEY)).toBe(false)
    })

    it('supabase 模式保留 refresh(supabase-js 自管)', () => {
      setAuthMode('supabase')
      browser.localStorageMap.set(TOKEN_KEY, 'id-token-1')
      browser.localStorageMap.set(REFRESH_KEY, 'refresh-1')
      clearAuthSession()
      expect(browser.localStorageMap.has(TOKEN_KEY)).toBe(false)
      expect(browser.localStorageMap.has(REFRESH_KEY)).toBe(true)
    })
  })

  describe('fetchAuthConfig', () => {
    it('no-store 现读 config', async () => {
      const payload = { mode: 'oidc', issuer: 'https://authz.example.com', clientId: 'dsh-rp', scopes: 'openid profile', relayUrl: 'http://server:8080' }
      const fetchMock = vi.fn(async (_input: unknown, _init?: { cache?: string }) =>
        new Response(JSON.stringify(payload), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(fetchAuthConfig()).resolves.toEqual(payload)
      expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: 'no-store' })
    })

    it('非 200 抛带状态码错误', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('config unavailable', { status: 503 })))
      await expect(fetchAuthConfig()).rejects.toThrow('认证配置读取失败：503 config unavailable')
    })
  })
})
