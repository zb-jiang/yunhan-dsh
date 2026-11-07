import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedModel, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as userIdentityContext from '../src/index.ts'
import { renderIdentityText } from '../src/text.ts'
import { platformUser } from './helpers.ts'

const SIGNAL = new AbortController().signal

/** Stub the global fetch with a my-org-positions envelope response. */
function stubPositionsResponse(data: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify(ok ? { success: true, data } : { success: false, error: { message: 'denied' } }),
    { status: ok ? 200 : 403 },
  )))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mount() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  // volatile 配置经 schemastery 包装;传普通值即可(运行时仅调用 get())
  const fiber = await ctx.plugin(userIdentityContext, { webConsoleBaseUrl: 'http://console:8080' })
  return { ctx, fiber }
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
    inject: () => { throw new Error('user-identity-context must append directly to the open step') },
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

function identityTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'user-identity-context') {
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

describe('per-turn identity injection', () => {
  it('injects one identity block at the first step when the store has a verified user', async () => {
    const { ctx } = await mount()
    const user = platformUser()
    ctx.currentUser.observe(user)
    const session = Session.create(SessionId('first'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(identityTexts(session)).toEqual([renderIdentityText(user)])
    const event = session.snapshotEvents().at(-1)
    expect(event?.type).toBe('user/message')
    if (event?.type !== 'user/message') throw new Error('missing identity block')
    expect(event.data.source).toEqual({
      kind: 'user-identity-context',
      form: 'snapshot',
      sections: [{ name: 'user-identity-context', text: renderIdentityText(user) }],
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('injects nothing before any verified login', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('anonymous'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(identityTexts(session)).toEqual([])
  })

  it('skips steps after the first in the same turn', async () => {
    const { ctx } = await mount()
    ctx.currentUser.observe(platformUser())
    const session = Session.create(SessionId('later-step'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(ctx, agent, 1, 1)
    await fire(ctx, agent, 1, 2)

    expect(identityTexts(session)).toHaveLength(1)
  })

  it('injects again at the first step of every new turn', async () => {
    const { ctx } = await mount()
    const user = platformUser()
    ctx.currentUser.observe(user)
    const session = Session.create(SessionId('per-turn'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)

    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)

    expect(identityTexts(session)).toEqual([renderIdentityText(user), renderIdentityText(user)])
  })

  it('reflects a re-login at the next turn', async () => {
    const { ctx } = await mount()
    ctx.currentUser.observe(platformUser())
    const session = Session.create(SessionId('re-login'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)

    const relogged = platformUser({ authSubject: 'sub-2', displayName: '张经理', email: 'zhang2@corp.com' })
    ctx.currentUser.observe(relogged)
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)

    expect(identityTexts(session)).toEqual([
      renderIdentityText(platformUser()),
      renderIdentityText(relogged),
    ])
  })

  it('passes a reject decision through untouched', async () => {
    const { ctx } = await mount()
    ctx.currentUser.observe(platformUser())
    ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const }))
    const session = Session.create(SessionId('reject'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(identityTexts(session)).toEqual([])
  })

  it('skips an already-aborted step', async () => {
    const { ctx } = await mount()
    ctx.currentUser.observe(platformUser())
    const session = Session.create(SessionId('ordering'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(ctx, agent, 1, 1)
    const abort = new AbortController()
    abort.abort()
    await fire(ctx, agent, 1, 2, abort.signal)

    expect(identityTexts(session)).toHaveLength(1)
  })

  it('removes its listener when the plugin fiber disposes', async () => {
    const { ctx, fiber } = await mount()
    ctx.currentUser.observe(platformUser())
    const session = Session.create(SessionId('dispose'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)

    await fiber.dispose()
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)

    expect(identityTexts(session)).toHaveLength(1)
  })
})

describe('platform-user event wiring', () => {
  it('caches the identity announced by platform-user/verified', async () => {
    const { ctx } = await mount()
    stubPositionsResponse([])
    const user = platformUser()
    ctx.emit('platform-user/verified', user, 'jwt-event')
    const session = Session.create(SessionId('event-verified'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(identityTexts(session)).toEqual([renderIdentityText(user, [], 'jwt-event')])
  })

  it('forgets the cached identity on platform-user/signout', async () => {
    const { ctx } = await mount()
    ctx.currentUser.observe(platformUser())
    ctx.emit('platform-user/signout')
    const session = Session.create(SessionId('event-signout'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(identityTexts(session)).toEqual([])
  })
})

describe('org positions injection (design 2026-09-19 §6.4)', () => {
  const POSITIONS = [
    { orgUnitId: 'unit-a', orgUnitName: 'A 部门', pathToRoot: ['总公司', '华东区', 'A 部门'] },
    { orgUnitId: 'unit-b', orgUnitName: 'B 部门', pathToRoot: ['总公司', 'B 部门'] },
  ]

  it('renders fetched positions into the identity block and caches per token', async () => {
    const { ctx } = await mount()
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, data: POSITIONS }),
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const user = platformUser()
    ctx.emit('platform-user/verified', user, 'jwt-1')
    const session = Session.create(SessionId('positions'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(ctx, agent, 1, 1)
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)

    expect(identityTexts(session)).toEqual([
      renderIdentityText(user, POSITIONS, 'jwt-1'),
      renderIdentityText(user, POSITIONS, 'jwt-1'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refetches when the verified token changes', async () => {
    const { ctx } = await mount()
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, data: POSITIONS }),
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const session = Session.create(SessionId('re-login-positions'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    ctx.emit('platform-user/verified', platformUser(), 'jwt-1')
    await fire(ctx, agent, 1, 1)

    const relogged = platformUser({ authSubject: 'sub-2' })
    ctx.emit('platform-user/verified', relogged, 'jwt-2')
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(identityTexts(session)).toEqual([
      renderIdentityText(platformUser(), POSITIONS, 'jwt-1'),
      renderIdentityText(relogged, POSITIONS, 'jwt-2'),
    ])
  })

  it('degrades to a positions-free block when web-console is unreachable', async () => {
    const { ctx } = await mount()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const user = platformUser()
    ctx.emit('platform-user/verified', user, 'jwt-1')
    const session = Session.create(SessionId('unreachable'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(identityTexts(session)).toEqual([renderIdentityText(user, [], 'jwt-1')])
  })

  it('degrades to a positions-free block when the envelope reports failure', async () => {
    const { ctx } = await mount()
    stubPositionsResponse(undefined, false)
    const user = platformUser()
    ctx.emit('platform-user/verified', user, 'jwt-1')
    const session = Session.create(SessionId('envelope-error'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(identityTexts(session)).toEqual([renderIdentityText(user, [], 'jwt-1')])
  })

  it('degrades to a positions-free block when webConsoleBaseUrl is invalid (volatile per-read)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(userIdentityContext, { webConsoleBaseUrl: 'not-a-url' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const user = platformUser()
    ctx.emit('platform-user/verified', user, 'jwt-1')
    const session = Session.create(SessionId('invalid-base-url'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(identityTexts(session)).toEqual([renderIdentityText(user, [], 'jwt-1')])
  })

  it('skips the positions fetch when no verified token exists', async () => {
    const { ctx } = await mount()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const session = Session.create(SessionId('no-token'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(identityTexts(session)).toEqual([])
  })
})

describe('real Loader export path', () => {
  it('keeps namespace metadata and boots the identity listener through unwrapExports', async () => {
    expect('default' in userIdentityContext).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(userIdentityContext) as Record<string, unknown>
    expect(unwrapped).toBe(userIdentityContext)
    expect(unwrapped.name).toBe('user-identity-context')
    expect(unwrapped.inject).toEqual(['agents'])
    expect(typeof unwrapped.apply).toBe('function')

    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const plugin = loader.unwrapExports(userIdentityContext) as Parameters<Context['plugin']>[0]
    // volatile 配置必填(无默认值),测试显式提供
    await ctx.plugin(plugin, { webConsoleBaseUrl: 'http://console:8080' })
    ctx.currentUser.observe(platformUser())
    const session = Session.create(SessionId('loader'))
    openMessageTurn(session, 1)
    await fire(ctx, sessionAgent(session), 1, 1)
    expect(identityTexts(session)).toEqual([renderIdentityText(platformUser())])
  })
})
