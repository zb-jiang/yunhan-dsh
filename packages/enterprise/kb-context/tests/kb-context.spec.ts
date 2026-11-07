import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedModel, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as kbContext from '../src/index.ts'
import { renderKbContextText } from '../src/text.ts'

const { apply } = kbContext

const SIGNAL = new AbortController().signal

/** 构造 JSON Response。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 最小 currentUser 桩:只暴露 getToken;token 可变,模拟登出。 */
function stubCurrentUser(token: string | undefined) {
  const state = { token }
  return {
    state,
    getToken: () => state.token,
  }
}

/** webServer 桩:记录注册的路由,测试直调 handler。 */
type StubRoute = {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function stubWebServer() {
  const routes: StubRoute[] = []
  return {
    routes,
    register: (route: StubRoute) => {
      routes.push(route)
      return () => {}
    },
  }
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

/** 按应用解析端点分发的 fetch 桩。 */
function stubKbFetch(handler: (url: string) => Response): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: URL | string) => handler(String(input)))
}

const volatileOf = <T>(value: T): { get: () => T } => ({ get: () => value })

const CONFIG = {
  // 尾斜杠由插件在请求期去尾;断言里的上游地址是无尾斜杠形态。
  webConsoleBaseUrl: volatileOf('http://console:8080/'),
}

async function mount(options: { token?: string | undefined } = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const webServer = stubWebServer()
  const user = stubCurrentUser('token' in options ? options.token : 'jwt-a')
  ctx.provide('webServer', webServer as never)
  ctx.provide('currentUser', user as never)
  apply(ctx, CONFIG)
  return { ctx, webServer, user }
}

/** 调上报路由并返回响应桩;body 为字符串时按原文发送(测畸形体)。 */
async function report(webServer: ReturnType<typeof stubWebServer>, body: unknown) {
  const route = webServer.routes[0]
  if (route === undefined) throw new Error('report route not registered')
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const res = stubResponse()
  await route.handler(stubRequest('POST', '/api/enterprise/kb/session-context', payload) as never, res as never)
  return res
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('kb-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function openMessageTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function kbTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'kb-context') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal = SIGNAL,
): Promise<void> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'request proposal' }],
    source: { kind: 'user' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { modelSelection: { provider: 'mock', model: 'mock' }, messages: [proposed], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      if (message === proposed) continue
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

const KB_ENVELOPE = { success: true, data: { id: 'kb-1', name: '财务制度库' } }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('session report route', () => {
  it('registers one exact route', async () => {
    const { webServer } = await mount()
    expect(webServer.routes).toHaveLength(1)
    expect(webServer.routes[0]?.kind).toBe('exact')
    expect(webServer.routes[0]?.path).toBe('/api/enterprise/kb/session-context')
  })

  it('rejects reports without a login with 401', async () => {
    const { webServer } = await mount({ token: undefined })
    const res = await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    expect(res.status).toBe(401)
  })

  it('accepts well-formed entries with 204', async () => {
    const { webServer } = await mount()
    const res = await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    expect(res.status).toBe(204)
  })

  it('rejects malformed report bodies with 400', async () => {
    const { webServer } = await mount()
    expect((await report(webServer, 'not json')).status).toBe(400)
    expect((await report(webServer, { entries: 'nope' })).status).toBe(400)
    expect((await report(webServer, { entries: [{ sessionId: '', applicationId: 'app-1' }] })).status).toBe(400)
    expect((await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 7 }] })).status).toBe(400)
  })
})

describe('per-turn knowledge-base injection', () => {
  it('injects one kb block at the first step of a reported session', async () => {
    const { ctx, webServer } = await mount()
    vi.stubGlobal('fetch', stubKbFetch((url) => {
      expect(url).toContain('/api/kb/by-app/app-1')
      return jsonResponse(200, KB_ENVELOPE)
    }))
    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    const session = Session.create(SessionId('s-1'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const expected = renderKbContextText({ kbId: 'kb-1', kbName: '财务制度库' })
    expect(kbTexts(session)).toEqual([expected])
    const event = session.snapshotEvents().at(-1)
    expect(event?.type).toBe('user/message')
    if (event?.type !== 'user/message') throw new Error('missing kb block')
    expect(event.data.source).toEqual({
      kind: 'kb-context',
      form: 'snapshot',
      sections: [{ name: 'kb-context', text: expected }],
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('injects nothing for sessions without a report or with a null application', async () => {
    const fetcher = stubKbFetch(() => jsonResponse(200, KB_ENVELOPE))
    vi.stubGlobal('fetch', fetcher)
    const { ctx, webServer } = await mount()
    await report(webServer, {
      entries: [
        { sessionId: 's-null', applicationId: null },
        { sessionId: 's-bound', applicationId: 'app-1' },
      ],
    })
    const unreported = Session.create(SessionId('s-unreported'))
    const nullApp = Session.create(SessionId('s-null'))
    openMessageTurn(unreported, 1)
    openMessageTurn(nullApp, 1)

    await fire(ctx, sessionAgent(unreported), 1, 1)
    await fire(ctx, sessionAgent(nullApp), 1, 1)

    expect(kbTexts(unreported)).toEqual([])
    expect(kbTexts(nullApp)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('skips steps after the first in the same turn', async () => {
    const fetcher = stubKbFetch(() => jsonResponse(200, KB_ENVELOPE))
    vi.stubGlobal('fetch', fetcher)
    const { ctx, webServer } = await mount()
    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    const session = Session.create(SessionId('s-1'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(ctx, agent, 1, 1)
    await fire(ctx, agent, 1, 2)

    expect(kbTexts(session)).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('caches a missing kb (404) instead of re-fetching every turn', async () => {
    const fetcher = stubKbFetch(() => jsonResponse(404, { success: false }))
    vi.stubGlobal('fetch', fetcher)
    const { ctx, webServer } = await mount()
    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    const session = Session.create(SessionId('s-1'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(ctx, agent, 1, 1)
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)

    expect(kbTexts(session)).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('degrades a failed resolution for the turn and retries the next', async () => {
    let failing = true
    const fetcher = stubKbFetch(() => failing
      ? jsonResponse(500, { success: false, error: { message: 'boom' } })
      : jsonResponse(200, KB_ENVELOPE))
    vi.stubGlobal('fetch', fetcher)
    const { ctx, webServer } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    const session = Session.create(SessionId('s-1'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(ctx, agent, 1, 1)
    expect(kbTexts(session)).toEqual([])
    expect(warn).toHaveBeenCalled()

    failing = false
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    expect(kbTexts(session)).toEqual([renderKbContextText({ kbId: 'kb-1', kbName: '财务制度库' })])
    warn.mockRestore()
  })

  it('injects nothing after a logout even with a stored report', async () => {
    const fetcher = stubKbFetch(() => jsonResponse(200, KB_ENVELOPE))
    vi.stubGlobal('fetch', fetcher)
    const { ctx, webServer, user } = await mount()
    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    user.state.token = undefined
    const session = Session.create(SessionId('s-1'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(kbTexts(session)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('stops injecting after a null-application report clears the binding', async () => {
    const fetcher = stubKbFetch(() => jsonResponse(200, KB_ENVELOPE))
    vi.stubGlobal('fetch', fetcher)
    const { ctx, webServer } = await mount()
    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    const session = Session.create(SessionId('s-1'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    expect(kbTexts(session)).toHaveLength(1)

    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: null }] })
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    expect(kbTexts(session)).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('passes a reject decision through untouched', async () => {
    vi.stubGlobal('fetch', stubKbFetch(() => jsonResponse(200, KB_ENVELOPE)))
    const { ctx, webServer } = await mount()
    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const }))
    const session = Session.create(SessionId('s-1'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(kbTexts(session)).toEqual([])
  })

  it('skips an already-aborted step', async () => {
    vi.stubGlobal('fetch', stubKbFetch(() => jsonResponse(200, KB_ENVELOPE)))
    const { ctx, webServer } = await mount()
    await report(webServer, { entries: [{ sessionId: 's-1', applicationId: 'app-1' }] })
    const session = Session.create(SessionId('s-1'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(ctx, agent, 1, 1)
    const abort = new AbortController()
    abort.abort()
    await fire(ctx, agent, 1, 2, abort.signal)

    expect(kbTexts(session)).toHaveLength(1)
  })
})
