import { Context } from '@deepseek-ai/cordis'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import type { PlatformUser, PlatformUserId } from '@deepseek-ai/dsh-platform-user'
import { PlatformUserError } from '@deepseek-ai/dsh-platform-user'

const { apply } = await import('../src/index.ts')

/** 最小 WebServer 桩，收集注册的路由。 */
function createStubWebServer() {
  const routes: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []
  const stub = {
    routes,
    register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
      routes.push(route)
      return () => {
        const idx = routes.indexOf(route)
        if (idx >= 0) routes.splice(idx, 1)
      }
    },
    registerUpgrade() { return () => {} },
    registerFallback() { return () => {} },
    tapIndex() { return () => {} },
    applyIndexTaps(html: string) { return html },
    host: '127.0.0.1' as const,
    port: 0,
  }
  return stub
}

/** 最小 PlatformUsers 桩，只实现 getUserByToken。 */
function createStubPlatformUsers() {
  const tokenToUser = new Map<string, PlatformUser>()
  const alice: PlatformUser = {
    id: 'u1' as PlatformUserId,
    authSubject: 'auth-1',
    loginName: 'alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    status: 'active',
    platformRoles: ['normal_user'],
    createdAt: '2026-08-30T00:00:00.000Z',
  }
  tokenToUser.set('valid-token', alice)
  return {
    async getUserByToken(accessToken: string) {
      const user = tokenToUser.get(accessToken)
      if (user === undefined) {
        throw new PlatformUserError('invalid token', 'AUTH_TOKEN_INVALID')
      }
      return user
    },
  }
}

/** 模拟 IncomingMessage。 */
function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    method,
    url,
    headers,
  } as unknown as IncomingMessage
}

/** 模拟 ServerResponse，通过对象引用读取 statusCode、headers 和 body。 */
function mockRes() {
  const state = { statusCode: 0, body: '', headers: {} as Record<string, unknown> }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      state.statusCode = status
      if (headers !== undefined) state.headers = headers
    },
    end(data?: string) { state.body = data ?? '' },
  } as unknown as ServerResponse
  return { res, state }
}

/** 构造测试用 volatile 配置引用(插件运行时仅调用 get())。 */
const volatileOf = <T>(value: T): { get: () => T } => ({ get: () => value })

const TEST_CONFIG = {
  provider: volatileOf('supabase'),
  supabaseUrl: volatileOf('https://example.supabase.co'),
  issuer: volatileOf(''),
  jwksUrl: volatileOf(''),
  supabaseAnonKey: volatileOf('anon-secret'),
  clientId: volatileOf(''),
  scopes: volatileOf(''),
  oidcRelayUrl: volatileOf(''),
}

/** casdoor 模式配置:issuer 显式给出,jwksUrl 留空按 OIDC 发现推导。 */
const TEST_CONFIG_OIDC = {
  provider: volatileOf('casdoor'),
  supabaseUrl: volatileOf(''),
  issuer: volatileOf('https://door.example.com'),
  jwksUrl: volatileOf(''),
  supabaseAnonKey: volatileOf(''),
  clientId: volatileOf('dsh-rp'),
  scopes: volatileOf(''),
  oidcRelayUrl: volatileOf(''),
}

describe('platform-user-api', () => {
  let ctx: Context
  let stubWebServer: ReturnType<typeof createStubWebServer>
  let stubUsers: ReturnType<typeof createStubPlatformUsers>

  beforeEach(() => {
    ctx = new Context()
    stubWebServer = createStubWebServer()
    stubUsers = createStubPlatformUsers()
    ctx.provide('webServer', stubWebServer as unknown as import('@deepseek-ai/dsh-host-webserver').WebServer)
    ctx.provide('platformUsers', stubUsers as unknown as import('@deepseek-ai/dsh-platform-user').PlatformUserService)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('注册 /api/enterprise/auth 前缀路由', () => {
    apply(ctx, TEST_CONFIG)
    expect(stubWebServer.routes).toHaveLength(1)
    expect(stubWebServer.routes[0]!.kind).toBe('prefix')
    expect(stubWebServer.routes[0]!.path).toBe('/api/enterprise/auth')
  })

  it('GET /me 通过 Bearer token 获取当前用户', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    const req = mockReq('GET', '/api/enterprise/auth/me', {
      authorization: 'Bearer valid-token',
    })
    await handler(req, res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { loginName: string; status: string }
    expect(parsed.loginName).toBe('alice')
    expect(parsed.status).toBe('active')
  })

  it('GET /me 成功后发出 platform-user/verified 事件', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const verified: PlatformUser[] = []
    ctx.on('platform-user/verified', (user) => { verified.push(user) })
    const { res } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/me', {
      authorization: 'Bearer valid-token',
    }), res)
    expect(verified).toHaveLength(1)
    expect(verified[0]!.authSubject).toBe('auth-1')
  })

  it('GET /me 失败时不发出 verified 事件', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const verified: PlatformUser[] = []
    ctx.on('platform-user/verified', (user) => { verified.push(user) })
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/me', {
      authorization: 'Bearer bogus-token',
    }), res)
    expect(state.statusCode).toBe(401)
    expect(verified).toEqual([])
  })

  it('POST /signout 返回 204 并发出 platform-user/signout 事件', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    let signouts = 0
    ctx.on('platform-user/signout', () => { signouts += 1 })
    const { res, state } = mockRes()
    await handler(mockReq('POST', '/api/enterprise/auth/signout'), res)
    expect(state.statusCode).toBe(204)
    expect(state.body).toBe('')
    expect(signouts).toBe(1)
  })

  it('GET /signout 方法不匹配返回 404', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/signout'), res)
    expect(state.statusCode).toBe(404)
  })

  it('GET /me 缺少 Authorization 头返回 401', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/me'), res)
    expect(state.statusCode).toBe(401)
  })

  it('GET /me 无效 token 返回 401', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    const req = mockReq('GET', '/api/enterprise/auth/me', {
      authorization: 'Bearer bogus-token',
    })
    await handler(req, res)
    expect(state.statusCode).toBe(401)
  })

  it('GET /config supabase 模式返回 mode/url/anonKey', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/config'), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { mode: string; url: string; anonKey: string }
    expect(parsed.mode).toBe('supabase')
    expect(parsed.url).toBe('https://example.supabase.co')
    expect(parsed.anonKey).toBe('anon-secret')
  })

  it('GET /config supabase 模式未配置时 url 为空串(首启引导初态,不报错)', async () => {
    apply(ctx, { ...TEST_CONFIG, supabaseUrl: volatileOf('') })
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/config'), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { mode: string; url: string }
    expect(parsed.mode).toBe('supabase')
    expect(parsed.url).toBe('')
  })

  it('GET /config oidc 模式返回 issuer/clientId/scopes/relayUrl', async () => {
    apply(ctx, TEST_CONFIG_OIDC)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/config'), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { mode: string; issuer: string; clientId: string; scopes: string; relayUrl: string }
    expect(parsed.mode).toBe('oidc')
    expect(parsed.issuer).toBe('https://door.example.com')
    expect(parsed.clientId).toBe('dsh-rp')
    expect(parsed.scopes).toBe('openid profile')
    expect(parsed.relayUrl).toBe('')
  })

  it('GET /config oidc 模式返回配置的 relayUrl(Pocket Access 手机端登录中转基地址)', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, oidcRelayUrl: volatileOf('http://console.example.com:8080/') })
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/config'), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { relayUrl: string }
    expect(parsed.relayUrl).toBe('http://console.example.com:8080/')
  })

  it('GET /config oidc 模式缺 clientId 返回 400(fails loud)', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, clientId: volatileOf('') })
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/config'), res)
    expect(state.statusCode).toBe(400)
    const parsed = JSON.parse(state.body) as { error: string }
    expect(parsed.error).toContain('requires a non-empty clientId')
  })

  /** 模拟带 JSON 体的异步可迭代请求(readJsonBody 经 for-await 读体)。 */
  function mockJsonReq(method: string, url: string, body: unknown): IncomingMessage {
    return {
      method,
      url,
      headers: { 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify(body))
      },
    } as unknown as IncomingMessage
  }

  it('POST /connectivity-check 无效 url 返回 400', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/connectivity-check', { url: 'not-a-url' }), res)
    expect(state.statusCode).toBe(400)
  })

  it('POST /connectivity-check 探测可达目标返回 ok=true 与状态码', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/connectivity-check', { url: 'http://engine:8090/actuator/health' }), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { ok: boolean; status: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.status).toBe(200)
  })

  it('POST /connectivity-check 探测不可达目标返回 200 + ok=false(Node 侧兜住网络错误)', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/connectivity-check', { url: 'http://engine:8090/actuator/health' }), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { ok: boolean; error: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('ECONNREFUSED')
  })

  // ── OIDC callback(授权码回调落点:绕开 index 认证墙的 SameSite=Strict 问题) ──

  it('GET /oidc/callback 返回 HTML 回调页,整页场景回跳根路径', async () => {
    apply(ctx, TEST_CONFIG_OIDC)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/oidc/callback?code=auth-code-1&state=state-1'), res)
    expect(state.statusCode).toBe(200)
    expect(state.headers['content-type']).toBe('text/html; charset=utf-8')
    // 回跳脚本携带转义后的 code/state(JSON.stringify 注入,防脚本注入)
    expect(state.body).toContain('window.location.replace("/?code=auth-code-1&state=state-1")')
  })

  it('GET /oidc/callback 特殊字符 code 被转义(防脚本注入)', async () => {
    apply(ctx, TEST_CONFIG_OIDC)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/oidc/callback?code=%3Cscript%3E&state=s'), res)
    expect(state.statusCode).toBe(200)
    expect(state.body).toContain(encodeURIComponent('<script>'))
  })

  it('GET /oidc/callback 缺 code 或 state 返回 400', async () => {
    apply(ctx, TEST_CONFIG_OIDC)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/oidc/callback?state=s'), res)
    expect(state.statusCode).toBe(400)
    const parsed = JSON.parse(state.body) as { error: string }
    expect(parsed.error).toContain('code')
  })

  // ── OIDC relay-register(Pocket Access 手机端 relay 会话登记转发) ──

  it('POST /oidc/relay-register supabase 模式返回 400', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/relay-register', { state: 's', returnOrigin: 'http://192.168.1.5:3081' }), res)
    expect(state.statusCode).toBe(400)
  })

  it('POST /oidc/relay-register 未配置 relayUrl 返回 400', async () => {
    apply(ctx, TEST_CONFIG_OIDC)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/relay-register', { state: 's', returnOrigin: 'http://192.168.1.5:3081' }), res)
    expect(state.statusCode).toBe(400)
    const parsed = JSON.parse(state.body) as { error: string }
    expect(parsed.error).toContain('oidcRelayUrl')
  })

  it('POST /oidc/relay-register 缺 state/returnOrigin 返回 400', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, oidcRelayUrl: volatileOf('http://console.example.com:8080') })
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/relay-register', { state: 's' }), res)
    expect(state.statusCode).toBe(400)
  })

  it('POST /oidc/relay-register 转发 state/returnOrigin 到 web-console relay 端点', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, oidcRelayUrl: volatileOf('http://console.example.com:8080/') })
    const handler = stubWebServer.routes[0]!.handler
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/relay-register', {
      state: 'state-1',
      returnOrigin: 'http://192.168.1.5:3081',
    }), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { ok: boolean }
    expect(parsed.ok).toBe(true)
    // relayUrl 末尾斜杠被剥掉后拼接 relay 登记端点
    expect(fetchMock).toHaveBeenCalledWith('http://console.example.com:8080/api/auth/dsh-relay/register', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ state: 'state-1', returnOrigin: 'http://192.168.1.5:3081' }),
    }))
  })

  it('POST /oidc/relay-register 上游 web-console 失败返回 502', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, oidcRelayUrl: volatileOf('http://console.example.com:8080') })
    const handler = stubWebServer.routes[0]!.handler
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/relay-register', { state: 's', returnOrigin: 'http://192.168.1.5:3081' }), res)
    expect(state.statusCode).toBe(502)
    const parsed = JSON.parse(state.body) as { error: string }
    expect(parsed.error).toContain('HTTP 500')
  })

  // ── OIDC authorize / token / refresh(casdoor / customer-oidc 模式) ──
  // discovery 缓存是模块级且按 issuer 记键:成功路径用例各用独立 issuer,避免缓存串扰。

  /** OIDC discovery 文档响应体(固定端点与各用例的 issuer 域名解耦)。 */
  const DISCOVERY_BODY = JSON.stringify({
    authorization_endpoint: 'https://idp.example.com/login/oauth/authorize',
    token_endpoint: 'https://idp.example.com/login/oauth/token',
  })

  /** stub fetch:discovery 请求返回固定文档,其余(即 token endpoint)返回 tokenResponse。 */
  function stubOidcFetch(tokenResponse?: () => Response) {
    const fetchMock = vi.fn(async (input: unknown, _init?: { body?: unknown }) => {
      const url = String(input)
      if (url.includes('/.well-known/openid-configuration')) {
        return new Response(DISCOVERY_BODY, { status: 200 })
      }
      return tokenResponse !== undefined ? tokenResponse() : new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('GET /oidc/authorize 302 到认证中心,Location 携带 PKCE 与 state', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, issuer: volatileOf('https://authz.example.com') })
    const handler = stubWebServer.routes[0]!.handler
    const fetchMock = stubOidcFetch()
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/oidc/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F&code_challenge=challenge-1&state=state-1'), res)
    expect(state.statusCode).toBe(302)
    const target = new URL(String(state.headers.location))
    expect(`${target.origin}${target.pathname}`).toBe('https://idp.example.com/login/oauth/authorize')
    expect(target.searchParams.get('client_id')).toBe('dsh-rp')
    expect(target.searchParams.get('response_type')).toBe('code')
    expect(target.searchParams.get('redirect_uri')).toBe('http://localhost:5173/')
    expect(target.searchParams.get('scope')).toBe('openid profile')
    expect(target.searchParams.get('state')).toBe('state-1')
    expect(target.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(target.searchParams.get('code_challenge_method')).toBe('S256')
    expect(target.searchParams.has('prompt')).toBe(false)
    expect(target.searchParams.has('popup')).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://authz.example.com/.well-known/openid-configuration',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
  })

  it('GET /oidc/authorize 透传 prompt=login(换账号强制重认证)', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, issuer: volatileOf('https://prompt.example.com') })
    const handler = stubWebServer.routes[0]!.handler
    stubOidcFetch()
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/oidc/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F&code_challenge=c&state=s&prompt=login'), res)
    expect(state.statusCode).toBe(302)
    const target = new URL(String(state.headers.location))
    expect(target.searchParams.get('prompt')).toBe('login')
  })

  it('GET /oidc/authorize 透传 popup=iframe(iframe 内嵌登录)', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, issuer: volatileOf('https://popup.example.com') })
    const handler = stubWebServer.routes[0]!.handler
    stubOidcFetch()
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/oidc/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F&code_challenge=c&state=s&popup=iframe'), res)
    expect(state.statusCode).toBe(302)
    const target = new URL(String(state.headers.location))
    expect(target.searchParams.get('popup')).toBe('1')
    expect(target.searchParams.get('popup_type')).toBe('iframe')
  })

  it('GET /oidc/authorize 缺 code_challenge 返回 400', async () => {
    apply(ctx, TEST_CONFIG_OIDC)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/oidc/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F&state=s'), res)
    expect(state.statusCode).toBe(400)
  })

  it('GET /oidc/authorize supabase 模式返回 400', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/oidc/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F&code_challenge=c&state=s'), res)
    expect(state.statusCode).toBe(400)
  })

  it('POST /oidc/token 交换成功并携带授权码表单', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, issuer: volatileOf('https://token.example.com') })
    const handler = stubWebServer.routes[0]!.handler
    const fetchMock = stubOidcFetch(() => new Response(
      JSON.stringify({ id_token: 'id-token-jwt', refresh_token: 'refresh-xyz', expires_in: 3600 }),
      { status: 200 },
    ))
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/token', { code: 'auth-code-1', codeVerifier: 'verifier-1', redirectUri: 'http://localhost:5173/' }), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { token: string; refreshToken: string; expiresIn: number }
    expect(parsed.token).toBe('id-token-jwt')
    expect(parsed.refreshToken).toBe('refresh-xyz')
    expect(parsed.expiresIn).toBe(3600)
    const tokenCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/login/oauth/token'))
    expect(tokenCall).toBeDefined()
    const form = new URLSearchParams(String(tokenCall![1]!.body))
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('auth-code-1')
    expect(form.get('code_verifier')).toBe('verifier-1')
    expect(form.get('redirect_uri')).toBe('http://localhost:5173/')
    expect(form.get('client_id')).toBe('dsh-rp')
  })

  it('POST /oidc/token 缺 codeVerifier 返回 400', async () => {
    apply(ctx, TEST_CONFIG_OIDC)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/token', { code: 'auth-code-1', redirectUri: 'http://localhost:5173/' }), res)
    expect(state.statusCode).toBe(400)
  })

  it('POST /oidc/token 上游 discovery 失败返回 502', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, issuer: volatileOf('https://broken.example.com') })
    const handler = stubWebServer.routes[0]!.handler
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/token', { code: 'c', codeVerifier: 'v', redirectUri: 'http://localhost:5173/' }), res)
    expect(state.statusCode).toBe(502)
    const parsed = JSON.parse(state.body) as { error: string }
    expect(parsed.error).toContain('HTTP 500')
  })

  it('POST /oidc/token 响应缺 id_token 返回 502', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, issuer: volatileOf('https://noidtoken.example.com') })
    const handler = stubWebServer.routes[0]!.handler
    stubOidcFetch(() => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }))
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/token', { code: 'c', codeVerifier: 'v', redirectUri: 'http://localhost:5173/' }), res)
    expect(state.statusCode).toBe(502)
    const parsed = JSON.parse(state.body) as { error: string }
    expect(parsed.error).toContain('id_token')
  })

  it('POST /oidc/refresh 续期成功并携带 refresh_token 表单', async () => {
    apply(ctx, { ...TEST_CONFIG_OIDC, issuer: volatileOf('https://refresh.example.com') })
    const handler = stubWebServer.routes[0]!.handler
    const fetchMock = stubOidcFetch(() => new Response(
      JSON.stringify({ id_token: 'new-id-token', refresh_token: 'new-refresh', expires_in: 3600 }),
      { status: 200 },
    ))
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/refresh', { refreshToken: 'refresh-xyz' }), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body) as { token: string; refreshToken: string }
    expect(parsed.token).toBe('new-id-token')
    expect(parsed.refreshToken).toBe('new-refresh')
    const refreshCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/login/oauth/token'))
    expect(refreshCall).toBeDefined()
    const form = new URLSearchParams(String(refreshCall![1]!.body))
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('refresh-xyz')
    expect(form.get('client_id')).toBe('dsh-rp')
  })

  it('POST /oidc/refresh supabase 模式返回 400', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockJsonReq('POST', '/api/enterprise/auth/oidc/refresh', { refreshToken: 'r' }), res)
    expect(state.statusCode).toBe(400)
  })

  it('未匹配的路由返回 404', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('DELETE', '/api/enterprise/auth/unknown'), res)
    expect(state.statusCode).toBe(404)
  })
})
