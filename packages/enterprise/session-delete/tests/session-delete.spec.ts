/**
 * dsh-session-delete 端点集成测试：请求校验与路由注册、真实 JSONL 后端下的
 * 删除闭环（工件目录 + pending 登记 + 投影缓存 + workspace 记账 + 归档集），
 * 以及 persistenceRoot 对非 JSONL 后端配置的结构探测拒绝。
 * webServer/workspaceRegistry/投影缓存用真实类的记录式子类直接 new 注册，
 * 持久化用真实 JsonlSessionPersistence 落盘，HTTP 走 127.0.0.1 回环。
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence, { sessionDir } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionProjectionCache } from '@deepseek-ai/dsh-session-projection-cache'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { apply } from '../src/index.ts'

/** escape 用例的开关：激活后被测代码拿到的 sessionDir 逃逸出持久化根。 */
const escapeState = vi.hoisted(() => ({ active: false }))

// 只劫持 sessionDir 的跨模块导入面：激活时把目录指到持久化根之外，覆盖逃逸
// 防御分支；未激活时透传真实实现。JsonlSessionPersistence 内部物化走同模块
// 本地绑定不受影响，落盘仍在真实 root 下。
vi.mock('@deepseek-ai/dsh-session-persistence-jsonl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-persistence-jsonl')>()
  const pathModule = await import('node:path')
  return {
    ...actual,
    sessionDir(root: string, cwd: string | undefined, id: SessionId) {
      if (escapeState.active) return pathModule.join(root, '..', 'escaped-session')
      return actual.sessionDir(root, cwd, id)
    },
  }
})

/** 源码未导出路由常量，这里按路由契约硬编码同一字符串。 */
const DELETE_ROUTE = '/api/enterprise/sessions/delete'

/** 最小合法 session header（cwd 缺省时省略该字段）。 */
function meta(id: string, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1000,
    isSeeded: false,
    ...cwd !== undefined ? { cwd } : {},
  }
}

/** 在持久化后端物化一个会话：create → 追加一个事件 → flush 强制落盘 → close。 */
async function materializeSession(persistence: SessionPersistence, header: SessionHeader): Promise<void> {
  const handle = await persistence.create(header)
  try {
    const event: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }
    await handle.append([event])
    await handle.flush()
  } finally {
    await handle.close()
  }
}

interface StubWorkspaceOptions {
  sessionIds: SessionId[]
  detached: SessionId[]
  rejection?: unknown
}

/** 纯对象 Workspace 桩：除 detachSession 记录/拒绝外均为 no-op。 */
function stubWorkspace(options: StubWorkspaceOptions): Workspace {
  return {
    id: WorkspaceId('ws-stub'),
    path: '/stub',
    title: 'stub',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: options.sessionIds,
    setTitle: () => Promise.resolve(),
    attachSession: () => Promise.resolve(),
    insertSessionBefore: () => Promise.resolve(),
    detachSession: (sessionId: SessionId) => {
      // rejection 可能是故意透传的 raw 值（非 Error）；as Error 仅为满足 reject-errors 规则。
      // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- Promise.reject 参数本就接受 unknown，断言只为让 reject 值带上 Error 类型
      if (options.rejection !== undefined) return Promise.reject(options.rejection as Error)
      options.detached.push(sessionId)
      return Promise.resolve()
    },
    status: () => Promise.resolve('ok'),
  }
}

interface TestServer {
  request(method: string, body?: string): Promise<Response>
  handler: WebRoute['handler']
  close(): Promise<void>
}

/** 在 127.0.0.1 随机端口起一个只分发到给定 handler 的 HTTP 回环服务器。 */
async function startServer(handler: WebRoute['handler']): Promise<TestServer> {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('expected a TCP address from a freshly listening server')
  }
  return {
    handler,
    async request(method, body) {
      return fetch(`http://127.0.0.1:${address.port}${DELETE_ROUTE}`, {
        method,
        ...(body !== undefined ? { body } : {}),
      })
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) rejectClose(error)
          else resolveClose()
        })
      })
    },
  }
}

/** 记录路由注册的 WebServer 桩：覆盖 register，不启动任何监听。 */
class RecordingWebServer extends WebServer {
  readonly routes: WebRoute[] = []

  constructor(ctx: Context) {
    super(ctx, { host: '127.0.0.1', port: 0 })
  }

  override register(route: WebRoute): () => void {
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }
}

/** 记录式 workspaceRegistry 桩：归档集、工作区列表与解除归档全部由用例控制。 */
class RecordingRegistry extends WorkspaceRegistry {
  readonly archived: SessionId[] = []
  readonly unarchived: SessionId[] = []
  readonly workspaces: Workspace[] = []

  override get archivedSessionIds(): readonly SessionId[] {
    return this.archived
  }

  override list(): Workspace[] {
    return this.workspaces
  }

  override async unarchiveSession(sessionId: SessionId): Promise<void> {
    this.unarchived.push(sessionId)
  }
}

/** 记录式投影缓存桩：只记录 drop 调用（init 才装写后逻辑，直接 new 无副作用）。 */
class RecordingProjectionCache extends SessionProjectionCache {
  readonly dropped: SessionId[] = []

  constructor(ctx: Context) {
    super(ctx, { writeEveryEvents: 1, writeIntervalMs: 1 })
  }

  override async drop(id: SessionId): Promise<void> {
    this.dropped.push(id)
  }
}

/** 不暴露 config 的持久化桩：覆盖 configless 探测分支。 */
class ConfiglessPersistence extends SessionPersistence {
  create(): Promise<SessionHandle> {
    return Promise.reject(new Error('not used'))
  }

  open(): Promise<SessionHandle> {
    return Promise.reject(new Error('not used'))
  }

  flush(): Promise<void> {
    return Promise.resolve()
  }

  stat(): Promise<SessionPersistenceSnapshot | undefined> {
    return Promise.resolve(undefined)
  }

  list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return Promise.resolve([{ header: meta('probe-target'), revision: SessionPersistenceRevision('probe-revision') }])
  }
}

/** 暴露任意 config 的持久化桩：覆盖 root 探测的类型与空值分支。 */
class ProbePersistence extends SessionPersistence {
  config: unknown = { root: '/unused' }

  create(): Promise<SessionHandle> {
    return Promise.reject(new Error('not used'))
  }

  open(): Promise<SessionHandle> {
    return Promise.reject(new Error('not used'))
  }

  flush(): Promise<void> {
    return Promise.resolve()
  }

  stat(): Promise<SessionPersistenceSnapshot | undefined> {
    return Promise.resolve(undefined)
  }

  list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return Promise.resolve([{ header: meta('probe-target'), revision: SessionPersistenceRevision('probe-revision') }])
  }
}

/** 组装被测端点：挂上记录式 webServer/registry 桩并注册路由。 */
function mount(ctx: Context): { webServer: RecordingWebServer; registry: RecordingRegistry } {
  const webServer = new RecordingWebServer(ctx)
  const registry = new RecordingRegistry(ctx)
  apply(ctx)
  return { webServer, registry }
}

describe('请求校验与路由注册', () => {
  let ctx: Context
  let webServer: RecordingWebServer
  let server: TestServer

  beforeAll(async () => {
    ctx = new Context()
    const mounted = mount(ctx)
    webServer = mounted.webServer
    server = await startServer(webServer.routes[0]!.handler)
  })

  afterAll(async () => {
    await server.close()
    await ctx.fiber.dispose()
  })

  it('注册 prefix 路由', () => {
    expect(webServer.routes).toHaveLength(1)
    expect(webServer.routes[0]).toMatchObject({ kind: 'prefix', path: DELETE_ROUTE })
  })

  it('拒绝非 POST 请求（GET）', async () => {
    const response = await server.request('GET')
    expect(response.status).toBe(405)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('is not supported; use POST')
  })

  it('method 缺失时按 405 拒绝', async () => {
    const req = new IncomingMessage(new Socket())
    const res = new ServerResponse(req)
    await server.handler(req, res)
    expect(res.statusCode).toBe(405)
  })

  it.each([
    ['空请求体', ''],
    ['非法 JSON', '{oops'],
    ['空对象缺少 sessionId', '{}'],
    ['sessionId 非字符串', '{"sessionId":42}'],
    ['sessionId 为空字符串', '{"sessionId":""}'],
    ['JSON 标量', '42'],
  ])('拒绝非法请求体：%s', async (_label, body) => {
    const response = await server.request('POST', body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'request body must be JSON of the form { "sessionId": "<id>" }' })
  })

  it('拒绝超过 64KB 的请求体', async () => {
    const response = await server.request('POST', 'x'.repeat(70 * 1024))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'request body must be JSON of the form { "sessionId": "<id>" }' })
  })

  it('拒绝删除未归档会话', async () => {
    const response = await server.request('POST', JSON.stringify({ sessionId: 'ghost' }))
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain("session 'ghost' is not archived")
  })
})

describe('真实 JSONL 持久化下的删除流程', () => {
  let parent: string
  let root: string
  let ctx: Context
  let webServer: RecordingWebServer
  let registry: RecordingRegistry

  beforeEach(async () => {
    escapeState.active = false
    parent = await mkdtemp(join(tmpdir(), 'session-delete-'))
    root = join(parent, 'sessions')
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const mounted = mount(ctx)
    webServer = mounted.webServer
    registry = mounted.registry
  })

  afterEach(async () => {
    escapeState.active = false
    await ctx.fiber.dispose()
    await rm(parent, { recursive: true, force: true })
  })

  it('删除已归档会话：工件目录、投影缓存、workspace 记账与归档集一并清理', async () => {
    const cache = new RecordingProjectionCache(ctx)
    registry.archived.push(SessionId('gone'))
    const detached: SessionId[] = []
    // 客户端列表 store 在 baseline 之外只经 api-session/removed 增量移除条目；
    // 冷删除必须补发该事件，否则条目残留到重启。
    const removed: SessionId[] = []
    const unfollow = ctx.on('api-session/removed', (sessionId) => { removed.push(sessionId) })
    registry.workspaces.push(
      stubWorkspace({ sessionIds: [SessionId('gone'), SessionId('other')], detached }),
      stubWorkspace({ sessionIds: [SessionId('other')], detached }),
    )
    await materializeSession(ctx.sessionPersistence, meta('gone', '/work'))
    const dir = sessionDir(root, '/work', SessionId('gone'))
    await expect(stat(dir)).resolves.toBeDefined()
    const server = await startServer(webServer.routes[0]!.handler)
    try {
      const response = await server.request('POST', JSON.stringify({ sessionId: 'gone' }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ deleted: 'gone' })
    } finally {
      await server.close()
      unfollow()
    }
    await expect(stat(dir)).rejects.toThrow()
    expect(cache.dropped).toEqual([SessionId('gone')])
    expect(detached).toEqual([SessionId('gone')])
    expect(registry.unarchived).toEqual([SessionId('gone')])
    expect(removed).toEqual([SessionId('gone')])
  })

  it('工件已不存在的会话仍收敛清理记账', async () => {
    registry.archived.push(SessionId('ghost'))
    const removed: SessionId[] = []
    const unfollow = ctx.on('api-session/removed', (sessionId) => { removed.push(sessionId) })
    const server = await startServer(webServer.routes[0]!.handler)
    try {
      const response = await server.request('POST', JSON.stringify({ sessionId: 'ghost' }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ deleted: 'ghost' })
    } finally {
      await server.close()
      unfollow()
    }
    expect(registry.unarchived).toEqual([SessionId('ghost')])
    // 收敛路径同样是成功的删除：客户端列表也要即时移除。
    expect(removed).toEqual([SessionId('ghost')])
  })

  it('未物化的 pending 会话：写 claim 持有期间以 409 拒绝，释放后删除成功', async () => {
    registry.archived.push(SessionId('pending-id'))
    const handle = await ctx.sessionPersistence.create(meta('pending-id', '/work'))
    const removed: SessionId[] = []
    const unfollow = ctx.on('api-session/removed', (sessionId) => { removed.push(sessionId) })
    const server = await startServer(webServer.routes[0]!.handler)
    try {
      try {
        const busy = await server.request('POST', JSON.stringify({ sessionId: 'pending-id' }))
        expect(busy.status).toBe(409)
        const body = (await busy.json()) as { error: string; code: string }
        expect(body.error).toContain('active write handle')
        expect(body.code).toBe('session-in-use')
        // 拒绝时不触碰任何记账：归档集保持原样，等待释放后重试。
        expect(registry.unarchived).toEqual([])
        // 拒绝路径不广播移除：客户端条目保留，与磁盘状态一致。
        expect(removed).toEqual([])
      } finally {
        await handle.close()
      }
      const retried = await server.request('POST', JSON.stringify({ sessionId: 'pending-id' }))
      expect(retried.status).toBe(200)
      expect(await retried.json()).toEqual({ deleted: 'pending-id' })
    } finally {
      await server.close()
      unfollow()
    }
    expect(registry.unarchived).toEqual([SessionId('pending-id')])
    expect(removed).toEqual([SessionId('pending-id')])
  })

  it('物化会话被写句柄持有（模拟 live agent）：409 拒绝且工件与记账全部不动', async () => {
    const cache = new RecordingProjectionCache(ctx)
    registry.archived.push(SessionId('held'))
    await materializeSession(ctx.sessionPersistence, meta('held', '/work'))
    const dir = sessionDir(root, '/work', SessionId('held'))
    // open write 复现员工端 live agent 持有写句柄的真实形态：会话已物化、
    // 磁盘工件存在、进程内写句柄活跃。
    const handle = await ctx.sessionPersistence.open(SessionId('held'), 'write')
    const server = await startServer(webServer.routes[0]!.handler)
    try {
      const busy = await server.request('POST', JSON.stringify({ sessionId: 'held' }))
      expect(busy.status).toBe(409)
      const body = (await busy.json()) as { code: unknown }
      expect(body).toMatchObject({ code: 'session-in-use' })
    } finally {
      await server.close()
      await handle.close()
    }
    // 防半删：拒绝时磁盘工件仍在，投影缓存与归档集均未清理。
    await expect(stat(dir)).resolves.toBeDefined()
    expect(cache.dropped).toEqual([])
    expect(registry.unarchived).toEqual([])
    // 句柄释放后重试即成功（等价于重启应用后的重试路径）。
    const server2 = await startServer(webServer.routes[0]!.handler)
    try {
      const retried = await server2.request('POST', JSON.stringify({ sessionId: 'held' }))
      expect(retried.status).toBe(200)
      expect(await retried.json()).toEqual({ deleted: 'held' })
    } finally {
      await server2.close()
    }
    await expect(stat(dir)).rejects.toThrow()
    expect(cache.dropped).toEqual([SessionId('held')])
    expect(registry.unarchived).toEqual([SessionId('held')])
  })

  it('目录逃逸出持久化根时以 500 拒绝且不触碰真实目录', async () => {
    registry.archived.push(SessionId('escape'))
    await materializeSession(ctx.sessionPersistence, meta('escape', '/work'))
    const dir = sessionDir(root, '/work', SessionId('escape'))
    escapeState.active = true
    const server = await startServer(webServer.routes[0]!.handler)
    try {
      const response = await server.request('POST', JSON.stringify({ sessionId: 'escape' }))
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error: string }
      expect(body.error).toContain('escaped the persistence root')
    } finally {
      await server.close()
    }
    await expect(stat(dir)).resolves.toBeDefined()
    expect(registry.unarchived).toEqual([])
  })

  it('workspace detach 失败时报错且不再解除归档', async () => {
    const cache = new RecordingProjectionCache(ctx)
    registry.archived.push(SessionId('detach-fail'))
    registry.workspaces.push(
      stubWorkspace({ sessionIds: [SessionId('detach-fail')], detached: [], rejection: new Error('boom') }),
    )
    const server = await startServer(webServer.routes[0]!.handler)
    try {
      const response = await server.request('POST', JSON.stringify({ sessionId: 'detach-fail' }))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'boom' })
    } finally {
      await server.close()
    }
    expect(cache.dropped).toEqual([SessionId('detach-fail')])
    expect(registry.unarchived).toEqual([])
  })

  it('非 Error 的失败值按字符串透传', async () => {
    registry.archived.push(SessionId('detach-fail'))
    registry.workspaces.push(
      stubWorkspace({ sessionIds: [SessionId('detach-fail')], detached: [], rejection: 'raw' }),
    )
    const server = await startServer(webServer.routes[0]!.handler)
    try {
      const response = await server.request('POST', JSON.stringify({ sessionId: 'detach-fail' }))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'raw' })
    } finally {
      await server.close()
    }
    expect(registry.unarchived).toEqual([])
  })
})

describe('persistenceRoot 探测', () => {
  it.each([
    { label: '后端不暴露 config', config: undefined, message: 'does not expose its configuration' },
    { label: 'config 为字符串', config: 'jsonl', message: 'carries no root' },
    { label: 'config 为 null', config: null, message: 'carries no root' },
    { label: 'config 为空对象', config: {}, message: 'carries no root' },
    { label: 'root 非字符串', config: { root: 42 }, message: 'root is not a non-empty string' },
    { label: 'root 为空字符串', config: { root: '' }, message: 'root is not a non-empty string' },
  ])('$label 时以 500 拒绝', async ({ config, message }) => {
    const ctx = new Context()
    const { webServer, registry } = mount(ctx)
    registry.archived.push(SessionId('probe-target'))
    const persistence = config === undefined ? new ConfiglessPersistence(ctx) : new ProbePersistence(ctx)
    // instanceof 收窄后才能给 ProbePersistence.config 赋值；configless 分支无需赋值。
    if (persistence instanceof ProbePersistence) persistence.config = config
    const server = await startServer(webServer.routes[0]!.handler)
    try {
      const response = await server.request('POST', JSON.stringify({ sessionId: 'probe-target' }))
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error: string }
      expect(body.error).toContain(message)
      expect(registry.unarchived).toEqual([])
    } finally {
      await server.close()
      await ctx.fiber.dispose()
    }
  })
})
