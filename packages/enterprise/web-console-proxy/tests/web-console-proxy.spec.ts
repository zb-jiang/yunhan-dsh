import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { proxyRequest, validateBaseUrl, type WebConsoleProxyOptions } from '../src/index.ts'

/** 构造 JSON Response。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** proxyRequest 转发给 fetch 的初始化参数。 */
interface StubFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: Uint8Array | null
}

/** 按前缀分发的 fetch 桩;response 抛错即上游网络失败。 */
function stubFetch(routes: { match: (url: string) => boolean; response: () => Response }[]) {
  return vi.fn(async (input: URL | string, _init?: StubFetchInit) => {
    const url = String(input)
    for (const route of routes) {
      if (route.match(url)) return route.response()
    }
    return jsonResponse(404, { error: `unexpected fetch ${url}` })
  })
}

/** 端点请求桩:Emitter 形状 + 异步迭代器(readBody 整体缓冲请求体)。 */
function stubRequest(method: string, url: string, body?: Buffer) {
  const req = new EventEmitter() as EventEmitter & {
    method: string
    url: string
    headers: Record<string, string>
    [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>
  }
  req.method = method
  req.url = url
  req.headers = {}
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield body
  }
  return req
}

/** 端点响应桩:记录状态码、响应头与响应体。 */
function stubResponse() {
  const res = {
    status: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    writeHead: (status: number, headers?: Record<string, unknown>) => {
      res.status = status
      res.headers = headers ?? {}
    },
    end: (chunk?: string) => {
      res.body += chunk ?? ''
    },
  }
  return res
}

const OPTIONS: WebConsoleProxyOptions = { baseUrl: () => 'http://console:8080/', token: () => 'jwt' }

const LOCAL = '/api/enterprise/x'
const UPSTREAM = '/api/x'

/** 经桩请求/响应直调 proxyRequest 的辅助。 */
async function forward(
  req: IncomingMessage,
  options: typeof OPTIONS = OPTIONS,
): Promise<ReturnType<typeof stubResponse>> {
  const res = stubResponse()
  await proxyRequest(options, LOCAL, UPSTREAM, req, res as never)
  return res
}

describe('web-console-proxy', () => {
  it('validateBaseUrl:合法 URL 通过,非法返回错误消息', () => {
    expect(validateBaseUrl('http://console:8080')).toBeUndefined()
    expect(validateBaseUrl('not-a-url')).toContain('invalid base URL')
  })

  it('未登录返回 401,默认通用文案', async () => {
    const res = await forward(stubRequest('GET', `${LOCAL}/a`) as never, { ...OPTIONS, token: () => undefined })
    expect(res.status).toBe(401)
    expect((JSON.parse(res.body) as { error: string }).error).toContain('未登录')
  })

  it('未登录 401 文案可由消费方按领域覆盖', async () => {
    const res = await forward(stubRequest('GET', `${LOCAL}/a`) as never, {
      ...OPTIONS,
      token: () => undefined,
      unauthorizedMessage: '未登录,无法访问企业知识库',
    })
    expect((JSON.parse(res.body) as { error: string }).error).toBe('未登录,无法访问企业知识库')
  })

  it('GET 转发改写前缀、透传 query、附 JWT,上游响应原样回写', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/x/a?kw=invoice',
      response: () => jsonResponse(200, { success: true, data: [] }),
    }])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await forward(stubRequest('GET', `${LOCAL}/a?kw=invoice`) as never)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('application/json')
      expect(JSON.parse(res.body)).toEqual({ success: true, data: [] })
      const [input, init] = fetchMock.mock.calls[0]!
      expect(String(input)).toBe('http://console:8080/api/x/a?kw=invoice')
      expect(init?.method).toBe('GET')
      expect(init?.headers).toEqual({ authorization: 'Bearer jwt' })
      expect(init?.body).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('POST 转发请求体与 content-type', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/x/a',
      response: () => jsonResponse(200, { success: true, data: {} }),
    }])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const req = stubRequest('POST', `${LOCAL}/a`, Buffer.from('{"a":1}'))
      req.headers['content-type'] = 'application/json'
      const res = await forward(req as never)
      expect(res.status).toBe(200)
      const [, init] = fetchMock.mock.calls[0]!
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ authorization: 'Bearer jwt', 'content-type': 'application/json' })
      expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('{"a":1}')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('baseUrl 配置无效返回 JSON 502(volatile 请求期校验)', async () => {
    const fetchMock = stubFetch([])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await forward(stubRequest('GET', `${LOCAL}/a`) as never, { ...OPTIONS, baseUrl: () => 'not-a-url' })
      expect(res.status).toBe(502)
      expect((JSON.parse(res.body) as { error: string }).error).toContain('webConsoleBaseUrl 配置无效')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('上游不可达返回 JSON 502', async () => {
    const fetchMock = stubFetch([{ match: () => true, response: () => { throw new Error('ECONNREFUSED') } }])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await forward(stubRequest('GET', `${LOCAL}/a`) as never)
      expect(res.status).toBe(502)
      expect((JSON.parse(res.body) as { error: string }).error).toContain('web-console 不可达')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fetch 抛非 Error 值时同样返回 502', async () => {
    const fetchMock = stubFetch([{ match: () => true, response: () => { throw 'boom' } }])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await forward(stubRequest('GET', `${LOCAL}/a`) as never)
      expect(res.status).toBe(502)
      expect((JSON.parse(res.body) as { error: string }).error).toContain('boom')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('上游响应缺 content-type 时回写默认 JSON 类型', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      // null body 的 Response 不携带 content-type 头。
      response: () => new Response(null, { status: 201 }),
    }])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await forward(stubRequest('GET', `${LOCAL}/a`) as never)
      expect(res.status).toBe(201)
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
