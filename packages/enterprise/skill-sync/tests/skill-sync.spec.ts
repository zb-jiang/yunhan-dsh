import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { CurrentUserService } from '@deepseek-ai/dsh-user-identity-context'
import * as skillSync from '../src/index.ts'

const { apply, SkillSyncService } = skillSync

/** 生成分发 zip(根即 SKILL.md,与 SkillHub 服务端打包一致)。 */
function skillZip(markdown: string): Uint8Array<ArrayBuffer> {
  return zipSync({ 'SKILL.md': strToU8(markdown) })
}

/** 构造 JSON Response。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 最小 currentUser 桩:只暴露 getToken。 */
function stubCurrentUser(token: string | undefined) {
  return { getToken: () => token } as unknown as CurrentUserService
}

/** skills 注册表桩:立即调用 create 构造真实 provider,记录 control 与 disposer。 */
function stubSkills() {
  const registered: { control: SkillProviderControl; disposed: boolean }[] = []
  return {
    registered,
    registerProvider: (create: (control: SkillProviderControl) => unknown) => {
      const control: SkillProviderControl = {
        signal: new AbortController().signal,
        invalidate: vi.fn(),
      }
      const entry = { control, disposed: false }
      registered.push(entry)
      create(control)
      return () => { entry.disposed = true }
    },
  }
}

/** 按前缀分发的 fetch 桩。 */
function stubFetch(routes: { match: (url: string) => boolean; response: () => Response }[]) {
  return vi.fn(async (input: URL | string) => {
    const url = String(input)
    for (const route of routes) {
      if (route.match(url)) return route.response()
    }
    return jsonResponse(404, { error: `unexpected fetch ${url}` })
  })
}

/** 最小 webServer 桩:记录注册的路由,测试直调 handler。 */
type StubRoute = {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
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

/**
 * 端点请求桩:Emitter 形状,模拟 paused 流语义——`sendBody` 只缓冲,
 * 请求体与 data/end 监听器谁先就绪都可能(治理路由先过异步 JWT 闸门再读
 * body,ensure 无闸门在 handler 同步阶段就读),两侧就绪后才经微任务回放,
 * 模拟真实 IncomingMessage 在监听前缓冲于流内部不丢失的交付行为。
 */
function stubRequest(method: string | undefined, url: string | undefined): EventEmitter & {
  method?: string | undefined
  url?: string | undefined
  headers: Record<string, string>
  destroy: () => void
  sendBody: (body: Buffer | undefined) => void
} {
  const req = new EventEmitter() as EventEmitter & {
    method?: string | undefined
    url?: string | undefined
    headers: Record<string, string>
    destroy: () => void
    sendBody: (body: Buffer | undefined) => void
  }
  req.method = method
  req.url = url
  req.headers = {}
  req.destroy = () => {}
  let buffered: Buffer | undefined
  let flushed = false
  const maybeFlush = () => {
    if (flushed || buffered === undefined) return
    // 监听器与请求体谁先就绪都可能:治理路由先过异步 JWT 闸门再挂监听,
    // ensure 无闸门在 handler 同步阶段就挂监听;两侧就绪后经微任务回放
    if (req.listenerCount('data') === 0 && req.listenerCount('end') === 0) return
    flushed = true
    queueMicrotask(() => {
      if (buffered !== undefined) req.emit('data', buffered)
      req.emit('end')
    })
  }
  req.sendBody = (body) => {
    buffered = body
    maybeFlush()
  }
  req.on('newListener', (event) => {
    if (event === 'data' || event === 'end') maybeFlush()
  })
  return req
}

/** 端点响应桩:记录状态码与响应体。 */
function stubResponse() {
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead: (status: number) => {
      res.status = status
      res.headersSent = true
    },
    end: (chunk?: string) => {
      res.body += chunk ?? ''
    },
  }
  return res
}

/** 构造测试用 volatile 配置引用(插件运行时仅调用 get())。 */
const volatileOf = <T>(value: T): { get: () => T } => ({ get: () => value })

const CONFIG_DEFAULTS = {
  flowableBaseUrl: volatileOf('http://flowable:8090'),
  skillhubBaseUrl: volatileOf('http://skillhub:8095'),
  skillhubToken: volatileOf('hub-token'),
  marketNamespace: volatileOf(''),
  intervalMs: volatileOf(60_000),
}

describe('skill-sync', () => {
  let ctx: Context
  let skillRoot: string
  let skillDir: string
  /** 员工抽屉目录:治理端点(install/import/uninstall/catalog 扫描)的落盘范围。 */
  let userDir: string
  let config: skillSync.Config

  const mount = (token: string | undefined, fetchMock?: ReturnType<typeof stubFetch>) => {
    // 挂载即跑首轮同步:无专属桩时默认 404,避免测试真实出站请求
    vi.stubGlobal('fetch', fetchMock ?? stubFetch([]))
    const skills = stubSkills()
    const webServer = stubWebServer()
    ctx.provide('skills', skills as never)
    ctx.provide('currentUser', stubCurrentUser(token) as never)
    ctx.provide('webServer', webServer as never)
    apply(ctx, config)
    return { skills, webServer }
  }

  beforeEach(async () => {
    ctx = new Context()
    // skillDir 必须是临时根的子目录:state.json 固定落在缓存根的父目录,
    // 若 skillDir 直接是临时目录,state.json 会写到共享的临时根上跨用例残留
    skillRoot = await mkdtemp(join(tmpdir(), 'skill-sync-'))
    skillDir = join(skillRoot, 'skills')
    userDir = join(skillRoot, 'user-skills')
    config = { ...CONFIG_DEFAULTS, skillDir, userSkillDir: userDir }
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    // start() fire-and-forget 的 mkdir 可能与 rm 竞争重建目录(Windows ENOTEMPTY),
    // fs.rm 对 ENOTEMPTY 内置重试,放宽重试上限清理掉迟到的写入
    await rm(skillRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('apply 在缓存根上注册 skill provider、skillSync 服务与即时安装端点', () => {
    const { skills, webServer } = mount('token')
    expect(skills.registered).toHaveLength(1)
    expect(ctx.skillSync).toBeInstanceOf(SkillSyncService)
    expect(webServer.routes).toHaveLength(1)
    expect(webServer.routes[0]?.path).toBe('/api/enterprise/skills')
  })

  it('apply 校验 baseUrl,非法立即抛错(misconfiguration fails loud)', () => {
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('currentUser', stubCurrentUser('token') as never)
    ctx.provide('webServer', stubWebServer() as never)
    expect(() => { apply(ctx, { ...CONFIG_DEFAULTS, skillDir, flowableBaseUrl: volatileOf('not-a-url') }) }).toThrow()
    expect(() => { apply(ctx, { ...CONFIG_DEFAULTS, skillDir, skillhubBaseUrl: volatileOf('nope') }) }).toThrow()
  })

  it('未登录(getToken undefined)时 sync 直接跳过,不出站请求', async () => {
    mount(undefined)
    const fetchMock = stubFetch([])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('apply 未配置合法化:端点为空串时照常挂载,sync 跳过不出站', async () => {
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('currentUser', stubCurrentUser('jwt') as never)
    ctx.provide('webServer', stubWebServer() as never)
    expect(() => { apply(ctx, {
      ...CONFIG_DEFAULTS,
      skillDir,
      flowableBaseUrl: volatileOf(''),
      skillhubBaseUrl: volatileOf(''),
    }) }).not.toThrow()
    const fetchMock = stubFetch([])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sync 拉清单、下载缺失 skill、写 state 并失效注册表', async () => {
    const { skills } = mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url === 'http://flowable:8090/dsh/skills/required',
        response: () => jsonResponse(200, {
          skills: [{ name: 'expense-form', namespace: 'dsh-demo', sources: ['active-task'] }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/dsh-demo/skills'),
        response: () => jsonResponse(200, {
          code: 0,
          data: {
            items: [{ slug: 'expense-form', fingerprint: 'sha256:abc', downloadUrl: '/api/v1/skills/dsh-demo/expense-form/versions/1.0.0/download' }],
            nextCursor: null,
          },
        }),
      },
      {
        match: url => url.includes('/download'),
        response: () => new Response(skillZip('---\nname: expense-form\n---\nbody')),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(join(skillDir, 'expense-form', 'SKILL.md')).toBeTruthy()
    await expect(readFile(join(skillDir, 'expense-form', 'SKILL.md'), 'utf8')).resolves.toContain('expense-form')
    const state = JSON.parse(await readFile(join(skillDir, '..', 'state.json'), 'utf8')) as { skills: Record<string, unknown> }
    expect(state.skills['expense-form']).toEqual({ namespace: 'dsh-demo', fingerprint: 'sha256:abc' })
    expect(skills.registered[0]?.control.invalidate).toHaveBeenCalled()
  })

  it('已安装且 fingerprint 一致的 skill 跳过下载', async () => {
    mount('jwt')
    await writeFile(join(skillDir, '..', 'state.json'), JSON.stringify({
      skills: { 'expense-form': { namespace: 'dsh-demo', fingerprint: 'sha256:abc' } },
    }))
    await mkdir(join(skillDir, 'expense-form'), { recursive: true })
    await writeFile(join(skillDir, 'expense-form', 'SKILL.md'), 'existing')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'expense-form', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => jsonResponse(200, {
          code: 0,
          data: { items: [{ slug: 'expense-form', fingerprint: 'sha256:abc', downloadUrl: '/d' }], nextCursor: null },
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    // 无 download 路由命中即未尝试下载
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/download'))).toBe(true)
    await expect(readFile(join(skillDir, 'expense-form', 'SKILL.md'), 'utf8')).resolves.toBe('existing')
  })

  it('fingerprint 变化触发重新安装(旧目录被替换)', async () => {
    mount('jwt')
    await writeFile(join(skillDir, '..', 'state.json'), JSON.stringify({
      skills: { 'expense-form': { namespace: 'dsh-demo', fingerprint: 'sha256:old' } },
    }))
    await mkdir(join(skillDir, 'expense-form'), { recursive: true })
    await writeFile(join(skillDir, 'expense-form', 'SKILL.md'), 'old')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'expense-form', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => jsonResponse(200, {
          code: 0,
          data: { items: [{ slug: 'expense-form', fingerprint: 'sha256:new', downloadUrl: '/api/v1/s/d' }], nextCursor: null },
        }),
      },
      { match: url => url.includes('/api/v1/s/d'), response: () => new Response(skillZip('---\nname: x\n---\nnew')) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await expect(readFile(join(skillDir, 'expense-form', 'SKILL.md'), 'utf8')).resolves.toContain('new')
  })

  it('401(token 过期)时本轮跳过', async () => {
    mount('stale-jwt')
    const fetchMock = stubFetch([
      { match: url => url.endsWith('/dsh/skills/required'), response: () => jsonResponse(401, {}) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await expect(readdir(skillDir)).resolves.toEqual([])
  })

  it('无 namespace 的清单项跳过,不触碰 SkillHub', async () => {
    mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, { skills: [{ name: 'orphan' }] }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('清单拉取失败时跳过该 namespace 的全部 skill', async () => {
    mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'expense-form', namespace: 'bad-ns' }],
        }),
      },
      { match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/bad-ns'), response: () => jsonResponse(500, {}) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await expect(readdir(skillDir)).resolves.toEqual([])
  })

  it('skill 不在命名空间已发布清单中时跳过安装', async () => {
    mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'ghost', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => jsonResponse(200, { code: 0, data: { items: [], nextCursor: null } }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await expect(readdir(skillDir)).resolves.toEqual([])
  })

  it('zip 条目路径穿越被拒绝且不产生残留目录', async () => {
    mount('jwt')
    const evilZip = zipSync({ '../escape.md': strToU8('x'), 'SKILL.md': strToU8('y') })
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'evil', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => jsonResponse(200, {
          code: 0,
          data: { items: [{ slug: 'evil', fingerprint: 'sha256:1', downloadUrl: '/api/v1/d' }], nextCursor: null },
        }),
      },
      { match: url => url.includes('/api/v1/d'), response: () => new Response(evilZip) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await expect(readdir(skillDir)).resolves.toEqual([])
    expect(join(tmpdir(), 'escape.md')).toBeTruthy()
  })

  it('ensureInstalled 对已就绪清单返回空,缺失时触发同步', async () => {
    mount('jwt')
    await writeFile(join(skillDir, '..', 'state.json'), JSON.stringify({
      skills: { ready: { namespace: 'ns', fingerprint: 'f' } },
    }))
    await mkdir(join(skillDir, 'ready'), { recursive: true })
    await writeFile(join(skillDir, 'ready', 'SKILL.md'), 'ok')
    await expect(ctx.skillSync.ensureInstalled(['ready'])).resolves.toEqual([])
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, { skills: [] }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await expect(ctx.skillSync.ensureInstalled(['ready', 'missing'])).resolves.toEqual(['missing'])
  })

  it('并发 sync 合并为一轮(清单只拉一次)', async () => {
    mount('jwt')
    let requiredCalls = 0
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => {
          requiredCalls += 1
          return jsonResponse(200, { skills: [] })
        },
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await Promise.all([ctx.skillSync.sync(), ctx.skillSync.sync()])
    expect(requiredCalls).toBe(1)
  })

  it('ensure 端点:缺失 skill 触发同步并返回 200 missing 清单', async () => {
    const { webServer } = mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, { skills: [] }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const route = webServer.routes[0]!
    const req = stubRequest('POST', '/api/enterprise/skills/ensure')
    const res = stubResponse()
    const promise = route.handler(req as never, res as never)
    req.emit('data', Buffer.from(JSON.stringify({ names: ['ghost'] })))
    req.emit('end')
    await promise
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ missing: ['ghost'] })
  })

  it('ensure 端点:names 含路径穿越特征返回 400', async () => {
    const { webServer } = mount('jwt')
    const route = webServer.routes[0]!
    const req = stubRequest('POST', '/api/enterprise/skills/ensure')
    const res = stubResponse()
    const promise = route.handler(req as never, res as never)
    req.emit('data', Buffer.from(JSON.stringify({ names: ['../escape'] })))
    req.emit('end')
    await promise
    expect(res.status).toBe(400)
    expect((JSON.parse(res.body) as { error: string }).error).toContain('names')
  })

  it('ensure 端点:非 POST/未知路径返回 404', async () => {
    const { webServer } = mount('jwt')
    const route = webServer.routes[0]!
    const getReq = stubRequest('GET', '/api/enterprise/skills/ensure')
    const getRes = stubResponse()
    await route.handler(getReq as never, getRes as never)
    expect(getRes.status).toBe(404)
    const req = stubRequest('POST', '/api/enterprise/skills/other')
    const res = stubResponse()
    const promise = route.handler(req as never, res as never)
    req.emit('data', Buffer.from('{}'))
    req.emit('end')
    await promise
    expect(res.status).toBe(404)
  })

  it('daemon 定时器按 intervalMs 触发同步,插件卸载后停止', async () => {
    // 用真实短间隔而非 fake timers:fetch 链路(undici)依赖真实宏任务排队,
    // fake timers 会冻结其内部 setImmediate 使同步轮卡死在合并门闩上。
    const fetchMock = stubFetch([
      { match: url => url.endsWith('/dsh/skills/required'), response: () => jsonResponse(200, { skills: [] }) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('currentUser', stubCurrentUser('jwt') as never)
    ctx.provide('webServer', stubWebServer() as never)
    const fiber = await ctx.plugin(skillSync, {
      flowableBaseUrl: 'http://flowable:8090',
      skillhubBaseUrl: 'http://skillhub:8095',
      skillhubToken: 'hub-token',
      marketNamespace: '',
      intervalMs: 20,
      skillDir,
    })
    // 挂载即首轮(start),之后每 20ms 一轮
    await vi.waitFor(() => { expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1) })
    const calls = fetchMock.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls)
    await fiber.dispose()
    const afterDispose = fetchMock.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(fetchMock.mock.calls.length).toBe(afterDispose)
  })

  it('挂载即建流程缓存与员工抽屉目录并立即执行一轮同步(不等第一个 interval)', async () => {
    const fetchMock = stubFetch([
      { match: url => url.endsWith('/dsh/skills/required'), response: () => jsonResponse(200, { skills: [] }) },
    ])
    await rm(skillDir, { recursive: true, force: true })
    await rm(userDir, { recursive: true, force: true })
    mount('jwt', fetchMock)
    // start() fire-and-forget,先轮询等待首轮同步发起,fetch 发起时 mkdir 已完成
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalled() })
    await expect(stat(skillDir)).resolves.toBeTruthy()
    await expect(stat(userDir)).resolves.toBeTruthy()
  })

  it('清单分页:nextCursor 非空时翻页取全量', async () => {
    mount('jwt')
    let page = 0
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'paged', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => {
          page += 1
          return jsonResponse(200, {
            code: 0,
            data: page === 1
              ? { items: [], nextCursor: '1' }
              : { items: [{ slug: 'paged', fingerprint: 'sha256:p', downloadUrl: '/api/v1/p' }], nextCursor: null },
          })
        },
      },
      { match: url => url.includes('/api/v1/p'), response: () => new Response(skillZip('---\nname: paged\n---\n')) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await expect(readFile(join(skillDir, 'paged', 'SKILL.md'), 'utf8')).resolves.toContain('paged')
    expect(page).toBe(2)
  })

  // ---- 技能库治理端点(catalog 匿名可读;install/uninstall/import 匿名可用)----

  /** 覆写共享缓存根的 state.json(治理用例的安装记录前置)。 */
  const writeState = (skills: Record<string, unknown>): Promise<void> =>
    writeFile(join(skillDir, '..', 'state.json'), JSON.stringify({ skills }), 'utf8')

  /** 验签通过的 platformUsers 桩。 */
  const passingPlatformUsers = { getUserByToken: async () => ({ id: 'employee' }) }

  /** 带治理桩挂载:platformUsers 缺省验签通过;服务缺失场景直接用 mount(不 provide)。 */
  const mountGoverned = (fetchMock?: ReturnType<typeof stubFetch>, platformUsers: object = passingPlatformUsers) => {
    ctx.provide('platformUsers', platformUsers as never)
    return mount('jwt', fetchMock)
  }

  /** 直调治理 handler:emit 请求体后等待分发完成,返回记录到的响应;res 可注入覆盖。 */
  const invoke = async (
    webServer: ReturnType<typeof stubWebServer>,
    method: string,
    url: string,
    options: { headers?: Record<string, string>; body?: Buffer; res?: ReturnType<typeof stubResponse> } = {},
  ) => {
    const req = stubRequest(method, url)
    Object.assign(req.headers, options.headers ?? {})
    const res = options.res ?? stubResponse()
    const done = webServer.routes[0]!.handler(req as never, res as never)
    req.sendBody(options.body)
    await done
    return res
  }

  /** 解析治理端点错误响应体的 error 字段。 */
  const errorOf = (res: { body: string }): string => (JSON.parse(res.body) as { error: string }).error

  const bearer = { authorization: 'Bearer jwt' }
  /** manifest 命中路由:单页清单。 */
  const manifestRoute = (items: readonly object[]) => ({
    match: (url: string) => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
    response: () => jsonResponse(200, { code: 0, data: { items: [...items], nextCursor: null } }),
  })

  it('catalog 匿名可读:无 Bearer 头时 200,authenticated=false 且不含 required 条目', async () => {
    const { webServer } = mountGoverned()
    await writeState({
      'flow-a': { namespace: 'dsh-demo', fingerprint: 'f1' },
      'my-b': { namespace: '', fingerprint: '', source: 'upload' },
    })
    await mkdir(join(skillDir, 'flow-a'), { recursive: true })
    await mkdir(join(userDir, 'my-b'), { recursive: true })
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      authenticated: false,
      catalogOpen: false,
      namespaces: [],
      local: [{ name: 'my-b', source: 'upload' }],
    })
  })

  it('匿名可安装市场技能(无 Bearer 头,认证由 skillhubToken 承担)', async () => {
    const fetchMock = stubFetch([
      manifestRoute([{ slug: 'hub-a', fingerprint: 'f1', downloadUrl: '/api/v1/d' }]),
      { match: url => url.includes('/api/v1/d'), response: () => new Response(skillZip('---\nname: hub-a\n---\n')) },
    ])
    const { webServer } = mountGoverned(fetchMock)
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'hub-a' })),
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ alreadyInstalled: false })
  })

  it('匿名可卸载:无 Bearer 头删除抽屉目录(manual 技能无账本记录)', async () => {
    const { webServer } = mountGoverned()
    await mkdir(join(userDir, 'hand-made'), { recursive: true })
    await writeFile(join(userDir, 'hand-made', 'SKILL.md'), '---\nname: hand-made\ndescription: 手工放入\n---\n')
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/uninstall', {
      body: Buffer.from(JSON.stringify({ slug: 'hand-made' })),
    })
    expect(res.status).toBe(200)
    await expect(readdir(userDir)).resolves.toEqual([])
  })

  it('catalog 扫描抽屉:无账本目录显示为 manual 并读 SKILL.md description', async () => {
    const { webServer } = mountGoverned()
    await mkdir(join(userDir, 'hand-made'), { recursive: true })
    await writeFile(join(userDir, 'hand-made', 'SKILL.md'), '---\nname: hand-made\ndescription: 手工放入\n---\n')
    await mkdir(join(userDir, 'broken'), { recursive: true })
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    // 无 SKILL.md 的目录同样按 manual 展示,description 缺省
    expect(body.local).toEqual([
      { name: 'broken', source: 'manual' },
      { name: 'hand-made', source: 'manual', description: '手工放入' },
    ])
  })

  it('catalog:市场条目命中手工放入的抽屉目录时标 installed 且来源为 manual', async () => {
    config.marketNamespace = volatileOf('dsh-demo')
    const { webServer } = mountGoverned(stubFetch([
      manifestRoute([{ slug: 'hand-made', fingerprint: 'f1', downloadUrl: '/api/v1/d' }]),
    ]))
    await mkdir(join(userDir, 'hand-made'), { recursive: true })
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    expect(body.local).toEqual([{ name: 'hand-made', source: 'manual' }])
    expect(body.namespaces[0]?.skills[0]).toMatchObject({ slug: 'hand-made', installed: true, source: 'manual' })
  })

  it('治理端点在 platformUsers 服务缺失时 401', async () => {
    const { webServer } = mount('jwt')
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    expect(res.status).toBe(401)
  })

  it('治理端点在验签失败时 401(细节进日志不进响应)', async () => {
    const { webServer } = mountGoverned(undefined, {
      getUserByToken: async () => { throw new Error('expired') },
    })
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    expect(res.status).toBe(401)
    expect(errorOf(res)).not.toContain('expired')
  })

  it('catalog:市场未开放时只返回本地清单(required 目录在缓存根,员工技能在抽屉,目录缺失条目跳过)', async () => {
    const { webServer } = mountGoverned()
    await writeState({
      'flow-a': { namespace: 'dsh-demo', fingerprint: 'f1' },
      'my-b': { namespace: '', fingerprint: '', source: 'upload', description: '员工上传' },
      'ghost-c': { namespace: 'dsh-demo', fingerprint: 'f2' },
    })
    await mkdir(join(skillDir, 'flow-a'), { recursive: true })
    await mkdir(join(userDir, 'my-b'), { recursive: true })
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      authenticated: true,
      catalogOpen: false,
      namespaces: [],
      local: [
        { name: 'flow-a', source: 'required', namespace: 'dsh-demo' },
        { name: 'my-b', source: 'upload', description: '员工上传' },
      ],
    })
  })

  it('catalog:市场 namespace 拉取失败时组级 error 透传,本地清单照常返回', async () => {
    config.marketNamespace = volatileOf('dsh-demo')
    const fetchMock = stubFetch([
      {
        match: url => url.includes('namespaces/dsh-demo/skills'),
        response: () => jsonResponse(500, { error: 'boom' }),
      },
    ])
    const { webServer } = mountGoverned(fetchMock)
    await writeState({ 'my-b': { namespace: '', fingerprint: '', source: 'upload', description: '员工上传' } })
    await mkdir(join(userDir, 'my-b'), { recursive: true })
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    expect(body.catalogOpen).toBe(true)
    expect(body.namespaces[0]).toMatchObject({ namespace: 'dsh-demo', skills: [] })
    expect(body.namespaces[0]?.error).toContain('SkillHub 命名空间清单返回 500')
    expect(body.local).toEqual([{ name: 'my-b', source: 'upload', description: '员工上传' }])
  })

  it('catalog:namespace 不存在时组级 error 提示检查配置(SkillHub 实际返回 400)', async () => {
    config.marketNamespace = volatileOf('ghost-ns')
    const fetchMock = stubFetch([
      {
        match: url => url.includes('namespaces/ghost-ns/skills'),
        response: () => jsonResponse(400, { error: 'error.namespace.slug.notFound' }),
      },
    ])
    const { webServer } = mountGoverned(fetchMock)
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    expect(body.namespaces[0]).toMatchObject({ namespace: 'ghost-ns', skills: [] })
    expect(body.namespaces[0]?.error).toContain('命名空间 \'ghost-ns\' 在 SkillHub 上不存在')
    expect(body.namespaces[0]?.error).toContain('SKILL_MKTPLAC_NAMESPACE')
  })

  it('catalog:404 同样视为 namespace 不存在(防 SkillHub 侧语义修正)', async () => {
    config.marketNamespace = volatileOf('ghost-ns')
    const { webServer } = mountGoverned(stubFetch([
      {
        match: url => url.includes('namespaces/ghost-ns/skills'),
        response: () => jsonResponse(404, { error: 'not found' }),
      },
    ]))
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    expect(body.namespaces[0]?.error).toContain('在 SkillHub 上不存在')
  })

  it('catalog:namespace 存在但清单为空 → skills 空数组(面板显示空态)', async () => {
    config.marketNamespace = volatileOf('dsh-demo')
    const { webServer } = mountGoverned(stubFetch([manifestRoute([])]))
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    expect(body.catalogOpen).toBe(true)
    expect(body.namespaces).toEqual([{ namespace: 'dsh-demo', skills: [] }])
  })

  it('apply:marketNamespace 逗号分隔列表直接抛错(单一命名空间语义)', () => {
    config.marketNamespace = volatileOf('a,b')
    expect(() => mountGoverned()).toThrow('只接受单一命名空间')
  })

  it('apply:marketNamespace 未配置时回退环境变量 SKILL_MKTPLAC_NAMESPACE', async () => {
    config.marketNamespace = volatileOf('')
    vi.stubEnv('SKILL_MKTPLAC_NAMESPACE', 'env-ns')
    const fetchMock = stubFetch([
      manifestRoute([{ slug: 'hub-a', fingerprint: 'f1', downloadUrl: '/d' }]),
    ])
    const { webServer } = mountGoverned(fetchMock)
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    expect(body.catalogOpen).toBe(true)
    expect(body.namespaces[0]).toMatchObject({ namespace: 'env-ns', skills: [{ slug: 'hub-a' }] })
  })

  it('install:请求体校验(namespace/slug 值域)400', async () => {
    const { webServer } = mountGoverned()
    for (const body of [{}, { slug: 'x' }, { namespace: '', slug: 'x' }, { namespace: 'ns' }, { namespace: 'ns', slug: 123 }, { namespace: 'ns', slug: '../x' }]) {
      const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
        headers: bearer, body: Buffer.from(JSON.stringify(body)),
      })
      expect(res.status).toBe(400)
    }
  })

  it('install:slug 不在已发布清单时 404', async () => {
    const { webServer } = mountGoverned(stubFetch([manifestRoute([])]))
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'ghost' })),
    })
    expect(res.status).toBe(404)
    expect(errorOf(res)).toContain('ghost')
  })

  it('install:required 同名同指纹且目录在 → 幂等,不下载', async () => {
    await writeState({ 'flow-a': { namespace: 'dsh-demo', fingerprint: 'sha256:abc' } })
    await mkdir(join(skillDir, 'flow-a'), { recursive: true })
    const fetchMock = stubFetch([
      manifestRoute([{ slug: 'flow-a', fingerprint: 'sha256:abc', downloadUrl: '/download' }]),
    ])
    const { webServer } = mountGoverned(fetchMock)
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'flow-a' })),
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ alreadyInstalled: true })
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/download'))).toBe(true)
  })

  it('install:required 同名不同指纹 → 409 拒绝市场覆盖', async () => {
    await writeState({ 'flow-a': { namespace: 'dsh-demo', fingerprint: 'sha256:old' } })
    await mkdir(join(skillDir, 'flow-a'), { recursive: true })
    const { webServer } = mountGoverned(stubFetch([
      manifestRoute([{ slug: 'flow-a', fingerprint: 'sha256:new', downloadUrl: '/download' }]),
    ]))
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'flow-a' })),
    })
    expect(res.status).toBe(409)
    expect(errorOf(res)).toContain('流程')
  })

  it('install:非 required 同指纹且目录在 → 幂等', async () => {
    await writeState({ 'my-b': { namespace: 'dsh-demo', fingerprint: 'sha256:abc', source: 'upload' } })
    await mkdir(join(userDir, 'my-b'), { recursive: true })
    const fetchMock = stubFetch([
      manifestRoute([{ slug: 'my-b', fingerprint: 'sha256:abc', downloadUrl: '/download' }]),
    ])
    const { webServer } = mountGoverned(fetchMock)
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'my-b' })),
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ alreadyInstalled: true })
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/download'))).toBe(true)
  })

  it('install:全新安装下载 zip、写 skillhub 来源(带清单 summary 作 description)并失效注册表', async () => {
    const fetchMock = stubFetch([
      manifestRoute([{ slug: 'hub-x', fingerprint: 'sha256:abc', downloadUrl: '/api/v1/d', summary: '公文格式 Pro 描述' }]),
      { match: url => url.includes('/api/v1/d'), response: () => new Response(skillZip('---\nname: hub-x\n---\n')) },
    ])
    const { skills, webServer } = mountGoverned(fetchMock)
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'hub-x' })),
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ alreadyInstalled: false })
    await expect(readFile(join(userDir, 'hub-x', 'SKILL.md'), 'utf8')).resolves.toContain('hub-x')
    const state = JSON.parse(await readFile(join(skillDir, '..', 'state.json'), 'utf8')) as { skills: Record<string, unknown> }
    expect(state.skills['hub-x']).toEqual({ namespace: 'dsh-demo', fingerprint: 'sha256:abc', source: 'skillhub', description: '公文格式 Pro 描述' })
    expect(skills.registered[0]?.control.invalidate).toHaveBeenCalled()
  })

  it('install:抽屉已有同名手工目录(无账本记录)→ 409 请先卸载', async () => {
    await mkdir(join(userDir, 'hub-x'), { recursive: true })
    const { webServer } = mountGoverned(stubFetch([
      manifestRoute([{ slug: 'hub-x', fingerprint: 'sha256:abc', downloadUrl: '/download' }]),
    ]))
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'hub-x' })),
    })
    expect(res.status).toBe(409)
    expect(errorOf(res)).toContain('先卸载')
  })

  it('install:upload 来源同名视为更新,重装为 skillhub 来源', async () => {
    await writeState({ 'my-b': { namespace: '', fingerprint: '', source: 'upload' } })
    await mkdir(join(userDir, 'my-b'), { recursive: true })
    const fetchMock = stubFetch([
      manifestRoute([{ slug: 'my-b', fingerprint: 'sha256:new', downloadUrl: '/download' }]),
      { match: url => url.includes('/download'), response: () => new Response(skillZip('---\nname: my-b\n---\n')) },
    ])
    const { webServer } = mountGoverned(fetchMock)
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'my-b' })),
    })
    expect(res.status).toBe(200)
    const state = JSON.parse(await readFile(join(skillDir, '..', 'state.json'), 'utf8')) as { skills: Record<string, { source?: string }> }
    expect(state.skills['my-b']?.source).toBe('skillhub')
  })

  it('uninstall:无记录且无目录 404(fail loud,不静默成功)', async () => {
    const { webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/uninstall', {
      headers: bearer, body: Buffer.from(JSON.stringify({ slug: 'ghost' })),
    })
    expect(res.status).toBe(404)
  })

  it('uninstall:required 来源 403,目录保留', async () => {
    await writeState({ 'flow-a': { namespace: 'dsh-demo', fingerprint: 'f1' } })
    await mkdir(join(skillDir, 'flow-a'), { recursive: true })
    const { webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/uninstall', {
      headers: bearer, body: Buffer.from(JSON.stringify({ slug: 'flow-a' })),
    })
    expect(res.status).toBe(403)
    expect(errorOf(res)).toContain('流程')
    await expect(stat(join(skillDir, 'flow-a'))).resolves.toBeTruthy()
  })

  it('uninstall:upload 来源成功删除抽屉目录与记录并失效注册表', async () => {
    await writeState({ 'my-b': { namespace: '', fingerprint: '', source: 'upload' } })
    await mkdir(join(userDir, 'my-b'), { recursive: true })
    const { skills, webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/uninstall', {
      headers: bearer, body: Buffer.from(JSON.stringify({ slug: 'my-b' })),
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({})
    await expect(stat(join(userDir, 'my-b'))).rejects.toThrow()
    const state = JSON.parse(await readFile(join(skillDir, '..', 'state.json'), 'utf8')) as { skills: Record<string, unknown> }
    expect(state.skills['my-b']).toBeUndefined()
    expect(skills.registered[0]?.control.invalidate).toHaveBeenCalled()
  })

  it('uninstall:并发调用互斥,第二个按已清理 404', async () => {
    await writeState({ 'my-b': { namespace: '', fingerprint: '', source: 'upload' } })
    await mkdir(join(userDir, 'my-b'), { recursive: true })
    mountGoverned()
    const [first, second] = await Promise.allSettled([
      ctx.skillSync.uninstallSkill('my-b'),
      ctx.skillSync.uninstallSkill('my-b'),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(skillSync.SkillEndpointError)
    expect((second as PromiseRejectedResult).reason).toMatchObject({ status: 404 })
  })

  it('uninstall:slug 值域校验 400', async () => {
    const { webServer } = mountGoverned()
    for (const body of [{}, { slug: '../x' }]) {
      const res = await invoke(webServer, 'POST', '/api/enterprise/skills/uninstall', {
        headers: bearer, body: Buffer.from(JSON.stringify(body)),
      })
      expect(res.status).toBe(400)
    }
  })

  it('import:非 zip 内容 400', async () => {
    const { webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', {
      headers: bearer, body: Buffer.from('not a zip'),
    })
    expect(res.status).toBe(400)
    expect(errorOf(res)).toContain('zip')
  })

  it('import:缺少 SKILL.md 400', async () => {
    const { webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', {
      headers: bearer, body: Buffer.from(zipSync({ 'other.txt': strToU8('x') })),
    })
    expect(res.status).toBe(400)
    expect(errorOf(res)).toContain('SKILL.md')
  })

  it('import:frontmatter 缺失/无 frontmatter/含非法行或空值行/name 非法 → 400', async () => {
    const { webServer } = mountGoverned()
    for (const markdown of [
      '---\ndescription: d\n---\n',
      '---\nname: ../bad\n---\n',
      'not-frontmatter',
      '---\ngarbage line\nname:\n---\n',
    ]) {
      const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', {
        headers: bearer, body: Buffer.from(zipSync({ 'SKILL.md': strToU8(markdown) })),
      })
      expect(res.status).toBe(400)
      expect(errorOf(res)).toContain('name')
    }
  })

  it('import:同名已装 409(账本记录或抽屉手工目录任一命中)', async () => {
    await writeState({ 'my-b': { namespace: '', fingerprint: '', source: 'upload' } })
    await mkdir(join(userDir, 'my-b'), { recursive: true })
    const { webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', {
      headers: bearer,
      body: Buffer.from(zipSync({ 'SKILL.md': strToU8('---\nname: my-b\n---\n') })),
    })
    expect(res.status).toBe(409)
    expect(errorOf(res)).toContain('my-b')
    // 无账本但有手工目录同样 409
    await writeFile(join(skillDir, '..', 'state.json'), JSON.stringify({ skills: {} }), 'utf8')
    const manual = await invoke(webServer, 'POST', '/api/enterprise/skills/import', {
      headers: bearer,
      body: Buffer.from(zipSync({ 'SKILL.md': strToU8('---\nname: my-b\n---\n') })),
    })
    expect(manual.status).toBe(409)
    expect(errorOf(manual)).toContain('先卸载')
  })

  it('import:required 同名 409(流程资产不可覆盖)', async () => {
    await writeState({ 'flow-a': { namespace: 'dsh-demo', fingerprint: 'f1' } })
    await mkdir(join(skillDir, 'flow-a'), { recursive: true })
    const { webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', {
      headers: bearer,
      body: Buffer.from(zipSync({ 'SKILL.md': strToU8('---\nname: flow-a\n---\n') })),
    })
    expect(res.status).toBe(409)
    expect(errorOf(res)).toContain('流程要求')
  })

  it('import:成功导入(落盘抽屉 + 顶层目录归一 + description 记录 + 失效注册表)', async () => {
    const { skills, webServer } = mountGoverned()
    const zip = zipSync({ 'my-b/SKILL.md': strToU8('---\nname: my-b\ndescription: 我的技能\n---\nbody') })
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', { headers: bearer, body: Buffer.from(zip) })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ name: 'my-b' })
    await expect(readFile(join(userDir, 'my-b', 'SKILL.md'), 'utf8')).resolves.toContain('body')
    const state = JSON.parse(await readFile(join(skillDir, '..', 'state.json'), 'utf8')) as { skills: Record<string, { source?: string; description?: string }> }
    expect(state.skills['my-b']).toEqual({ namespace: '', fingerprint: '', source: 'upload', description: '我的技能' })
    expect(skills.registered[0]?.control.invalidate).toHaveBeenCalled()
  })

  it('import:解压后总量超限 413', async () => {
    const { webServer } = mountGoverned()
    const zip = zipSync({ 'SKILL.md': strToU8('---\nname: big\n---\n'), 'pad.bin': new Uint8Array(65 * 1024 * 1024) })
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', { headers: bearer, body: Buffer.from(zip) })
    expect(res.status).toBe(413)
  })

  it('import:请求体超上传上限 413 并断开', async () => {
    const { webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', {
      headers: bearer, body: Buffer.alloc(31 * 1024 * 1024),
    })
    expect(res.status).toBe(413)
  })

  it('治理路由:未知路径 404', async () => {
    const { webServer } = mountGoverned()
    expect((await invoke(webServer, 'POST', '/api/enterprise/skills/catalog', { headers: bearer, body: Buffer.from('{}') })).status).toBe(404)
    expect((await invoke(webServer, 'GET', '/api/enterprise/skills/install', { headers: bearer })).status).toBe(404)
  })

  it('治理路由:method/url 缺省按 GET / 处理(404)', async () => {
    const { webServer } = mountGoverned()
    const res = stubResponse()
    await webServer.routes[0]!.handler(stubRequest(undefined, undefined) as never, res as never)
    expect(res.status).toBe(404)
  })

  it('install:SkillHub 清单非 2xx 空体时端点 500(错误文案无 detail 段)', async () => {
    const { webServer } = mountGoverned(stubFetch([
      { match: url => url.includes('namespaces/dsh-demo/skills'), response: () => new Response('', { status: 502 }) },
    ]))
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'flow-a' })),
    })
    expect(res.status).toBe(500)
    expect(errorOf(res)).toContain('502')
    expect(errorOf(res)).not.toContain(': ')
  })

  it('install:SkillHub 信封异常(code 非 0/缺失)时端点 500', async () => {
    let manifestBody: unknown
    const { webServer } = mountGoverned(stubFetch([
      { match: url => url.includes('namespaces/dsh-demo/skills'), response: () => jsonResponse(200, manifestBody) },
    ]))
    for (const body of [{ code: 1 }, {}]) {
      manifestBody = body
      const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
        headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'flow-a' })),
      })
      expect(res.status).toBe(500)
      expect(errorOf(res)).toContain('信封')
    }
  })

  it('install:SkillHub 信封缺 items 视为空清单 → slug 404', async () => {
    const { webServer } = mountGoverned(stubFetch([
      { match: url => url.includes('namespaces/dsh-demo/skills'), response: () => jsonResponse(200, { code: 0, data: { nextCursor: null } }) },
    ]))
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'flow-a' })),
    })
    expect(res.status).toBe(404)
    expect(errorOf(res)).toContain('flow-a')
  })

  it('install:下载 zip 非 2xx(带/不带 detail)时端点 500', async () => {
    let downloadBody = ''
    const { webServer } = mountGoverned(stubFetch([
      manifestRoute([{ slug: 'flow-a', fingerprint: 'f1', downloadUrl: '/download' }]),
      { match: url => url.includes('/download'), response: () => new Response(downloadBody, { status: 503 }) },
    ]))
    for (const bodyText of ['rate limited', '']) {
      downloadBody = bodyText
      const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
        headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'flow-a' })),
      })
      expect(res.status).toBe(500)
      expect(errorOf(res)).toContain('503')
    }
  })

  it('install:SkillHub 拉清单抛非 Error 值时端点 500(errorText 走 String 化)', async () => {
    const { webServer } = mountGoverned(stubFetch([
      { match: url => url.includes('namespaces/dsh-demo/skills'), response: () => { throw 'boom-string' } },
    ]))
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'flow-a' })),
    })
    expect(res.status).toBe(500)
    expect(errorOf(res)).toBe('boom-string')
  })

  it('install:请求体非 JSON 时 400', async () => {
    const { webServer } = mountGoverned()
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from('not-json{'),
    })
    expect(res.status).toBe(400)
    expect(errorOf(res)).toContain('JSON')
  })

  it('install:响应头已发送后再异常时不再重写响应(防御分支)', async () => {
    const { webServer } = mountGoverned(stubFetch([
      { match: url => url.includes('namespaces/dsh-demo/skills'), response: () => { throw 'boom' } },
    ]))
    const res = stubResponse()
    res.headersSent = true
    const result = await invoke(webServer, 'POST', '/api/enterprise/skills/install', {
      headers: bearer, body: Buffer.from(JSON.stringify({ namespace: 'dsh-demo', slug: 'flow-a' })), res,
    })
    expect(result.status).toBe(0)
    expect(result.body).toBe('')
  })

  it('catalog:市场 namespace 抛非 Error 值时该组携带 String 化 error', async () => {
    config.marketNamespace = volatileOf('bad-ns')
    const { webServer } = mountGoverned(stubFetch([
      { match: url => url.includes('namespaces/bad-ns/skills'), response: () => { throw 'boom' } },
    ]))
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    expect(res.status).toBe(200)
    const catalog = JSON.parse(res.body) as { namespaces: Array<{ error?: string }> }
    expect(catalog.namespaces[0]?.error).toBe('boom')
  })

  it('catalog:state.json 缺失时视为空状态(本地清单为空)', async () => {
    config.marketNamespace = volatileOf('dsh-demo')
    const { webServer } = mountGoverned(stubFetch([
      manifestRoute([
        { slug: 'flow-a', fingerprint: 'f1', downloadUrl: '/d' },
        { slug: 'flow-b', fingerprint: 'f2', downloadUrl: '/d' },
      ]),
    ]))
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    expect(body.catalogOpen).toBe(true)
    expect(body.local).toEqual([])
    const first = body.namespaces[0]?.skills[0]
    expect(first?.slug).toBe('flow-a')
    expect(first?.installed).toBe(false)
    expect(first?.source).toBeUndefined()
  })

  it('catalog:安装记录缺 source 字段时市场组按 required 处理', async () => {
    config.marketNamespace = volatileOf('dsh-demo')
    await writeState({ 'flow-a': { namespace: 'dsh-demo', fingerprint: 'f1' } })
    await mkdir(join(skillDir, 'flow-a'), { recursive: true })
    const { webServer } = mountGoverned(stubFetch([
      manifestRoute([
        { slug: 'flow-a', fingerprint: 'f1', downloadUrl: '/d' },
        { slug: 'flow-b', fingerprint: 'f2', downloadUrl: '/d' },
      ]),
    ]))
    const res = await invoke(webServer, 'GET', '/api/enterprise/skills/catalog', { headers: bearer })
    const body = JSON.parse(res.body) as skillSync.SkillCatalog
    expect(body.local).toEqual([{ name: 'flow-a', source: 'required', namespace: 'dsh-demo' }])
    const skills = body.namespaces[0]?.skills ?? []
    expect(skills[0]?.slug).toBe('flow-a')
    expect(skills[0]?.installed).toBe(true)
    expect(skills[0]?.source).toBe('required')
    expect(skills[1]?.slug).toBe('flow-b')
    expect(skills[1]?.installed).toBe(false)
    expect(skills[1]?.source).toBeUndefined()
  })

  it('import:zip 含目录条目时跳过目录条目', async () => {
    const { webServer } = mountGoverned()
    const zip = zipSync({ 'SKILL.md': strToU8('---\nname: my-b\n---\nbody'), 'sub/': new Uint8Array(0) })
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', { headers: bearer, body: Buffer.from(zip) })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ name: 'my-b' })
    await expect(readFile(join(userDir, 'my-b', 'SKILL.md'), 'utf8')).resolves.toContain('body')
  })

  it('import:顶层散文件与技能目录并存时剥前缀并丢弃散文件', async () => {
    const { webServer } = mountGoverned()
    // 'my-b/' 顶层目录条目自身(zip 工具常见输出)在剥前缀时被丢弃
    const zip = zipSync({
      'my-b/': new Uint8Array(0),
      'my-b/SKILL.md': strToU8('---\nname: my-b\n---\nbody'),
      'loose.txt': strToU8('x'),
    })
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', { headers: bearer, body: Buffer.from(zip) })
    expect(res.status).toBe(200)
    await expect(readFile(join(userDir, 'my-b', 'SKILL.md'), 'utf8')).resolves.toContain('body')
    await expect(stat(join(userDir, 'loose.txt'))).rejects.toThrow()
  })

  it('import:目录内无 SKILL.md 时按原样处理报 400', async () => {
    const { webServer } = mountGoverned()
    const zip = zipSync({ 'my-b/readme.txt': strToU8('x') })
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', { headers: bearer, body: Buffer.from(zip) })
    expect(res.status).toBe(400)
    expect(errorOf(res)).toContain('SKILL.md')
  })

  it('import:多个顶层目录无法归一时按原样处理报 400', async () => {
    const { webServer } = mountGoverned()
    const zip = zipSync({ 'my-b/readme.txt': strToU8('x'), 'other/guide.txt': strToU8('y') })
    const res = await invoke(webServer, 'POST', '/api/enterprise/skills/import', { headers: bearer, body: Buffer.from(zip) })
    expect(res.status).toBe(400)
    expect(errorOf(res)).toContain('SKILL.md')
  })

  it('sync:flowable 返回 500 空体与缺 skills 字段时本轮失败/空清单', async () => {
    mount('jwt')
    let round = 0
    const fetchMock = stubFetch([
      { match: url => url.endsWith('/dsh/skills/required'), response: () => {
        round += 1
        return round === 1 ? new Response('', { status: 500 }) : jsonResponse(200, {})
      } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await ctx.skillSync.sync()
    await expect(readdir(skillDir)).resolves.toEqual([])
  })

  it('sync:同 namespace 多个 skill 只拉一次清单(缓存命中)', async () => {
    mount('jwt')
    let manifestCalls = 0
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, { skills: [{ name: 'a', namespace: 'ns' }, { name: 'b', namespace: 'ns' }] }),
      },
      {
        match: url => url.includes('namespaces/ns/skills'),
        response: () => {
          manifestCalls += 1
          return jsonResponse(200, { code: 0, data: { items: [
            { slug: 'a', fingerprint: 'fa', downloadUrl: '/download-a' },
            { slug: 'b', fingerprint: 'fb', downloadUrl: '/download-b' },
          ], nextCursor: null } })
        },
      },
      { match: url => url.includes('/download-'), response: () => new Response(skillZip('---\nname: x\n---\nbody')) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(manifestCalls).toBe(1)
    await expect(readFile(join(skillDir, 'a', 'SKILL.md'), 'utf8')).resolves.toBeTruthy()
    await expect(readFile(join(skillDir, 'b', 'SKILL.md'), 'utf8')).resolves.toBeTruthy()
  })

  it('start:首轮同步失败不阻塞启动(记日志)', async () => {
    const spy = vi.spyOn(skillSync.SkillSyncService.prototype, 'sync').mockRejectedValueOnce(new Error('first-round'))
    try {
      mount('jwt')
      await vi.waitFor(() => { expect(spy).toHaveBeenCalled() })
    } finally {
      spy.mockRestore()
    }
  })

  it('ensure:触发的同步失败时仍返回缺失清单(降级提示)', async () => {
    const spy = vi.spyOn(skillSync.SkillSyncService.prototype, 'sync')
      .mockRejectedValueOnce(new Error('first-round'))
      .mockRejectedValueOnce(new Error('ensure-round'))
    try {
      const { webServer } = mount('jwt')
      const res = await invoke(webServer, 'POST', '/api/enterprise/skills/ensure', {
        body: Buffer.from(JSON.stringify({ names: ['ghost'] })),
      })
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ missing: ['ghost'] })
    } finally {
      spy.mockRestore()
    }
  })

  it('daemon:周期同步异常被吞(不中断后续轮次)', async () => {
    const fetchMock = stubFetch([
      { match: url => url.endsWith('/dsh/skills/required'), response: () => jsonResponse(200, { skills: [] }) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('currentUser', stubCurrentUser('jwt') as never)
    ctx.provide('webServer', stubWebServer() as never)
    const fiber = await ctx.plugin(skillSync, {
      flowableBaseUrl: 'http://flowable:8090',
      skillhubBaseUrl: 'http://skillhub:8095',
      skillhubToken: 'hub-token',
      marketNamespace: '',
      intervalMs: 20,
      skillDir,
    })
    const spy = vi.spyOn(ctx.skillSync, 'sync').mockRejectedValue(new Error('tick'))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    await fiber.dispose()
    spy.mockRestore()
  })

  it('volatile-update:非法 intervalMs 沿用旧配置,合法值重排定时器', async () => {
    const { webServer } = mount('jwt')
    config.intervalMs = volatileOf(0)
    ctx.emit('loader/volatile-update', [['intervalMs']])
    config.intervalMs = volatileOf(60_000)
    ctx.emit('loader/volatile-update', [['intervalMs']])
    expect(webServer.routes).toHaveLength(1)
  })

  it('platform-user/verified:登录触发同步,异常被吞', async () => {
    // 实例 spy 而非 prototype spy:跨用例残留定时器可能驱动其他实例调 sync,
    // prototype 计数会被污染;实例 spy 只统计本用例挂载的服务
    mount('jwt')
    const spy = vi.spyOn(ctx.skillSync, 'sync').mockRejectedValue(new Error('swallowed'))
    try {
      // spy 安装先于 start 的首轮同步(中间隔着两跳异步 mkdir),计数确定
      await vi.waitFor(() => { expect(spy).toHaveBeenCalledTimes(1) })
      ctx.emit('platform-user/verified', { id: 'employee' } as never, 'jwt')
      await vi.waitFor(() => { expect(spy).toHaveBeenCalledTimes(2) })
    } finally {
      spy.mockRestore()
    }
  })

  it('start:mkdir 失败(缓存根被文件占用)不阻塞挂载,记日志后每轮重试', async () => {
    const occupied = join(skillRoot, 'occupied')
    await writeFile(occupied, 'x')
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('currentUser', stubCurrentUser('jwt') as never)
    ctx.provide('webServer', stubWebServer() as never)
    expect(() => { apply(ctx, { ...CONFIG_DEFAULTS, skillDir: occupied }) }).not.toThrow()
  })

  it('apply:skillDir 未配置时回退 $DSH_HOME/skill-sync/skills', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skill-sync-home-'))
    process.env.DSH_HOME = home
    try {
      ctx.provide('skills', stubSkills() as never)
      ctx.provide('currentUser', stubCurrentUser('jwt') as never)
      ctx.provide('webServer', stubWebServer() as never)
      expect(() => { apply(ctx, { ...CONFIG_DEFAULTS, skillDir: '' }) }).not.toThrow()
      await vi.waitFor(() => { expect(existsSync(join(home, 'skill-sync', 'skills'))).toBe(true) })
    } finally {
      delete process.env.DSH_HOME
      await rm(home, { recursive: true, force: true })
    }
  })
})
