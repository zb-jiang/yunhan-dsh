import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import * as instanceWorkspace from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { INSTANCE_WORKSPACE_SECTION, renderInstanceWorkspaceContextText } from '../src/text.ts'

const { apply } = instanceWorkspace

const SIGNAL = new AbortController().signal

/** 构造 JSON Response。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 测试直调的工具面:execute / output.render / presentCall。 */
interface StubTool {
  readonly name: string
  readonly execute: (args: never, exec: unknown) => Promise<unknown>
  readonly output: { render: (args: never, value: never) => unknown[] }
  readonly presentCall: (args: never) => unknown
}

/** tools 注册表桩:记录注册的工具定义,返回空 disposer。 */
function stubTools() {
  const registered: StubTool[] = []
  return {
    registered,
    register: (definition: unknown) => {
      registered.push(definition as StubTool)
      return () => {}
    },
  }
}

/** proxyRequest 转发给 fetch 的初始化参数。 */
interface StubFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: unknown
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

/** 本地落盘根(localRoot 覆盖进程 cwd)。 */
async function stubLocalRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'instance-workspace-'))
}

/** 最小 currentUser 桩:只暴露 getToken;token 可变,模拟登出。 */
function stubCurrentUser(token: string | undefined) {
  const state = { token }
  return {
    state,
    getToken: () => state.token,
  }
}

/** webServer 桩:记录注册的路由并暴露监听端口,测试直调 handler。 */
type StubRoute = {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function stubWebServer(port = 3080) {
  const routes: StubRoute[] = []
  return {
    port,
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

const volatileOf = <T>(value: T): { get: () => T } => ({ get: () => value })

/** web-console InstanceWorkspaceFileDto 样例。 */
const FILE_DTO = {
  relPath: 'a.txt',
  sizeBytes: 3,
  contentType: 'text/plain',
  uploadedByLabel: 'dsh-service',
  sourceTaskId: null,
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
  diskMissing: false,
}

const CONFIG = {
  // 尾斜杠由插件在请求期去尾;断言里的上游地址是无尾斜杠形态。
  webConsoleBaseUrl: volatileOf('http://console:8080/'),
  readMaxBytes: 100,
  uploadMaxBytes: 1024,
  serviceKey: 'sk-1',
  // 存量用例的默认挂载:global 与历史行为一致;boundSessions 用例单独覆盖。
  // satisfies 收住字面量类型(无标注时 toolMount 宽化为 string,不满足 Config)。
  toolMount: 'global',
} satisfies Config

describe('instance-workspace', () => {
  let ctx: Context
  let localRoot: string

  const mount = (
    fetchMock: ReturnType<typeof stubFetch> = stubFetch([]),
    serviceKey = 'sk-1',
    options: { token?: string | undefined } = {},
  ) => {
    vi.stubGlobal('fetch', fetchMock)
    const tools = stubTools()
    const webServer = stubWebServer()
    ctx.provide('tools', tools as never)
    ctx.provide('webServer', webServer as never)
    if (options.token !== undefined) {
      ctx.provide('currentUser', stubCurrentUser(options.token) as never)
    }
    apply(ctx, { ...CONFIG, serviceKey, localRoot })
    return { tools, fetchMock, webServer }
  }

  const toolOf = (tools: ReturnType<typeof stubTools>, toolName: string): StubTool => {
    const found = tools.registered.find(candidate => candidate.name === toolName)
    if (found === undefined) throw new Error(`tool ${toolName} not registered`)
    return found
  }

  const execute = (tool: StubTool, args: unknown) =>
    tool.execute(args as never, { signal: new AbortController().signal })

  beforeEach(async () => {
    ctx = new Context()
    localRoot = await stubLocalRoot()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('toolMount global:apply 注册六个 workspace_* 工具到根注册表', () => {
    const { tools } = mount()
    expect(tools.registered.map(tool => tool.name).sort()).toEqual([
      'workspace_delete',
      'workspace_download',
      'workspace_list',
      'workspace_read',
      'workspace_upload',
      'workspace_write',
    ])
  })

  it('apply 校验配置:readMaxBytes / uploadMaxBytes 非法立即抛错(misconfiguration fails loud)', () => {
    vi.stubGlobal('fetch', stubFetch([]))
    ctx.provide('tools', stubTools() as never)
    expect(() => { apply(ctx, { ...CONFIG, localRoot, readMaxBytes: 0 }) }).toThrow('readMaxBytes')
    expect(() => { apply(ctx, { ...CONFIG, localRoot, readMaxBytes: Number.NaN }) }).toThrow('readMaxBytes')
    expect(() => { apply(ctx, { ...CONFIG, localRoot, readMaxBytes: Number.POSITIVE_INFINITY }) }).toThrow('readMaxBytes')
    expect(() => { apply(ctx, { ...CONFIG, localRoot, uploadMaxBytes: 0 }) }).toThrow('uploadMaxBytes')
    expect(() => { apply(ctx, { ...CONFIG, localRoot, uploadMaxBytes: -1 }) }).toThrow('uploadMaxBytes')
    // 错配 yml 值在类型面不合法、运行时真实存在:窄断言模拟 wire 输入。
    expect(() => { apply(ctx, { ...CONFIG, localRoot, toolMount: 'elsewhere' as Config['toolMount'] }) }).toThrow('toolMount')
    expect(() => { apply(ctx, { ...CONFIG, localRoot, toolMount: '' as Config['toolMount'] }) }).toThrow('toolMount')
  })

  it('服务密钥缺失:工具调用报错(认证 fail loud)', async () => {
    const { tools } = mount(undefined, '')
    await expect(execute(toolOf(tools, 'workspace_list'), { instanceId: 'i-1' }))
      .rejects.toThrow('未登录且未配置服务密钥')
  })

  it('workspace_list:GET 重写为服务面端点并带 x-service-key 头,映射紧凑清单,render/presentCall 可用', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/backend/instances/i-1/files',
      response: () => jsonResponse(200, { success: true, data: [FILE_DTO, { ...FILE_DTO, relPath: '丢失.txt', diskMissing: true }] }),
    }])
    const { tools } = mount(fetchMock)
    const list = toolOf(tools, 'workspace_list')
    const result = await execute(list, { instanceId: 'i-1' }) as { files: { relPath: string; sizeBytes: number; diskMissing: boolean }[] }
    expect(result.files).toEqual([
      { relPath: 'a.txt', sizeBytes: 3, diskMissing: false },
      { relPath: '丢失.txt', sizeBytes: 3, diskMissing: true },
    ])
    const [input, init] = fetchMock.mock.calls[0]!
    expect(String(input)).toBe('http://console:8080/api/backend/instances/i-1/files')
    expect(init?.method).toBe('GET')
    expect(init?.headers).toEqual({ 'x-service-key': 'sk-1' })
    expect(list.output.render(undefined as never, result as never)).toEqual([
      {
        type: 'text',
        text: '实例空间 2 个文件:\n- a.txt (3 字节)\n- 丢失.txt (3 字节) [磁盘缺失]',
      },
    ])
    expect(list.presentCall({ instanceId: 'i-1' } as never)).toEqual({
      card: 'generic', title: '列出实例空间文件', kind: 'other', rawInput: 'i-1',
    })
  })

  it('workspace_list:空清单 render 提示暂无文件', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(200, { success: true, data: [] }),
    }])
    const { tools } = mount(fetchMock)
    const list = toolOf(tools, 'workspace_list')
    const result = await execute(list, { instanceId: 'i-1' }) as { files: unknown[] }
    expect(result.files).toEqual([])
    expect(list.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '实例空间:暂无文件。' },
    ])
  })

  it('workspace_read:全文返回且 render 携带全文', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/backend/instances/i-1/files/content/a.txt',
      response: () => new Response('x'.repeat(50), { status: 200 }),
    }])
    const { tools } = mount(fetchMock)
    const read = toolOf(tools, 'workspace_read')
    const result = await execute(read, { instanceId: 'i-1', path: 'a.txt' }) as { path: string; totalBytes: number; truncated: boolean; content: string }
    expect(result).toEqual({ path: 'a.txt', totalBytes: 50, truncated: false, content: 'x'.repeat(50) })
    expect(read.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: `实例空间文件「a.txt」内容(50 字节):\n\n${'x'.repeat(50)}` },
    ])
    expect(read.presentCall({ instanceId: 'i-1', path: 'a.txt' } as never)).toEqual({
      card: 'generic', title: '读取实例空间文件', kind: 'read', rawInput: 'a.txt',
    })
  })

  it('workspace_read:超限截断并注明,render 提示用 workspace_download 取全文', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => new Response('x'.repeat(150), { status: 200 }),
    }])
    const { tools } = mount(fetchMock)
    const read = toolOf(tools, 'workspace_read')
    const result = await execute(read, { instanceId: 'i-1', path: 'big.txt' }) as { totalBytes: number; truncated: boolean; content: string }
    expect(result.totalBytes).toBe(150)
    expect(result.truncated).toBe(true)
    expect(result.content).toBe('x'.repeat(100))
    expect(read.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: expect.stringContaining('超出上限已截断为前 100 字节') as string },
    ])
  })

  it('workspace_read:中文路径逐段 URL 编码', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/backend/instances/i-1/files/content/%E6%8A%A5%E5%91%8A.txt',
      response: () => new Response('ok', { status: 200 }),
    }])
    const { tools } = mount(fetchMock)
    await execute(toolOf(tools, 'workspace_read'), { instanceId: 'i-1', path: '报告.txt' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('workspace_write:POST text 端点,taskId 映射 sourceTaskId,render 记来源节点', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/backend/instances/i-1/files/text',
      response: () => jsonResponse(200, { success: true, data: { ...FILE_DTO, sizeBytes: 2, sourceTaskId: 'task-1' } }),
    }])
    const { tools } = mount(fetchMock)
    const write = toolOf(tools, 'workspace_write')
    const result = await execute(write, { instanceId: 'i-1', path: 'hello.txt', content: 'hi', taskId: 'task-1' }) as { relPath: string; sizeBytes: number; sourceTaskId: string }
    expect(result).toEqual({ relPath: 'a.txt', sizeBytes: 2, sourceTaskId: 'task-1' })
    const [input, init] = fetchMock.mock.calls[0]!
    expect(String(input)).toBe('http://console:8080/api/backend/instances/i-1/files/text')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ path: 'hello.txt', content: 'hi', sourceTaskId: 'task-1' })
    expect(write.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '已写入实例空间文件「a.txt」(2 字节,来源节点 task-1)。' },
    ])
  })

  it('workspace_write:无 taskId 时 sourceTaskId 为 null,render 不记来源节点', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(200, { success: true, data: { ...FILE_DTO, sizeBytes: 0, sourceTaskId: null } }),
    }])
    const { tools } = mount(fetchMock)
    const write = toolOf(tools, 'workspace_write')
    const result = await execute(write, { instanceId: 'i-1', path: 'hello.txt', content: '' }) as { sourceTaskId: string | undefined }
    expect(result.sourceTaskId).toBeUndefined()
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ path: 'hello.txt', content: '', sourceTaskId: null })
    expect(write.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '已写入实例空间文件「a.txt」(0 字节)。' },
    ])
  })

  it('workspace_upload:读本地文件走 multipart 上传,form 携带 path 与 file', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/backend/instances/i-1/files',
      response: () => jsonResponse(200, { success: true, data: { ...FILE_DTO, relPath: 'docs/a.txt', sourceTaskId: 'task-1' } }),
    }])
    const { tools } = mount(fetchMock)
    await writeFile(join(localRoot, 'a.txt'), 'hi')
    const upload = toolOf(tools, 'workspace_upload')
    const result = await execute(upload, { instanceId: 'i-1', localPath: 'a.txt', path: 'docs/a.txt', taskId: 'task-1' }) as { relPath: string; sizeBytes: number; sourceTaskId: string }
    expect(result).toEqual({ relPath: 'docs/a.txt', sizeBytes: 3, sourceTaskId: 'task-1' })
    const [input, init] = fetchMock.mock.calls[0]!
    expect(String(input)).toBe('http://console:8080/api/backend/instances/i-1/files')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'x-service-key': 'sk-1' })
    const form = init?.body as FormData
    expect(form.get('path')).toBe('docs/a.txt')
    expect((form.get('file') as File).name).toBe('a.txt')
    expect(await (form.get('file') as File).text()).toBe('hi')
  })

  it('workspace_upload:本地文件缺失与超上限均报错且不发请求', async () => {
    const fetchMock = stubFetch([])
    const { tools } = mount(fetchMock)
    const upload = toolOf(tools, 'workspace_upload')
    await expect(execute(upload, { instanceId: 'i-1', localPath: 'no-such.txt', path: 'x.txt' }))
      .rejects.toThrow('本地文件不存在')
    await writeFile(join(localRoot, 'big.bin'), 'x'.repeat(2048))
    await expect(execute(upload, { instanceId: 'i-1', localPath: 'big.bin', path: 'x.bin' }))
      .rejects.toThrow('超过上传上限')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('workspace_download:落本地落盘根同 relPath(含子目录),render 记绝对路径', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/backend/instances/i-1/files/content/sub/%E6%96%B0%E6%96%87%E4%BB%B6.txt',
      response: () => new Response('cloud-body', { status: 200 }),
    }])
    const { tools } = mount(fetchMock)
    const download = toolOf(tools, 'workspace_download')
    const result = await execute(download, { instanceId: 'i-1', path: 'sub/新文件.txt' }) as { path: string; absolutePath: string; sizeBytes: number }
    expect(result.sizeBytes).toBe(10)
    expect(result.absolutePath).toBe(join(localRoot, 'sub', '新文件.txt'))
    expect(await readFile(join(localRoot, 'sub', '新文件.txt'), 'utf8')).toBe('cloud-body')
    expect(download.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: expect.stringContaining(`到本地工作区 ${join(localRoot, 'sub', '新文件.txt')}`) as string },
    ])
  })

  it('workspace_download:本地同名文件已存在报冲突,路径越界拒绝', async () => {
    const fetchMock = stubFetch([])
    const { tools } = mount(fetchMock)
    const download = toolOf(tools, 'workspace_download')
    await writeFile(join(localRoot, 'exists.txt'), 'local')
    await expect(execute(download, { instanceId: 'i-1', path: 'exists.txt' }))
      .rejects.toThrow('本地同名文件已存在')
    await expect(execute(download, { instanceId: 'i-1', path: '../evil.txt' }))
      .rejects.toThrow('非法相对路径')
    await expect(execute(download, { instanceId: 'i-1', path: 'a//b.txt' }))
      .rejects.toThrow('非法相对路径')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('workspace_delete:DELETE 重写服务面端点并解信封', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/backend/instances/i-1/files/content/b.txt',
      response: () => jsonResponse(200, { success: true, data: null }),
    }])
    const { tools } = mount(fetchMock)
    const del = toolOf(tools, 'workspace_delete')
    const result = await execute(del, { instanceId: 'i-1', path: 'b.txt' }) as { path: string }
    expect(result).toEqual({ path: 'b.txt' })
    const [input, init] = fetchMock.mock.calls[0]!
    expect(String(input)).toBe('http://console:8080/api/backend/instances/i-1/files/content/b.txt')
    expect(init?.method).toBe('DELETE')
    expect(del.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '已删除实例空间文件「b.txt」。' },
    ])
  })

  it('上游错误:信封失败透出错误消息,网络不可达转可读错误', async () => {
    const envelopeFail = stubFetch([{
      match: () => true,
      response: () => jsonResponse(404, { success: false, error: { message: '实例不存在' } }),
    }])
    const { tools } = mount(envelopeFail)
    await expect(execute(toolOf(tools, 'workspace_list'), { instanceId: 'i-1' }))
      .rejects.toThrow('实例不存在')

    const unreachable = stubFetch([{ match: () => true, response: () => { throw new Error('ECONNREFUSED') } }])
    vi.stubGlobal('fetch', unreachable)
    const tools2 = stubTools()
    const ctx2 = new Context()
    ctx2.provide('tools', tools2 as never)
    ctx2.provide('webServer', stubWebServer() as never)
    apply(ctx2, { ...CONFIG, localRoot, serviceKey: 'sk-1' })
    await expect(execute(toolOf(tools2, 'workspace_list'), { instanceId: 'i-1' }))
      .rejects.toThrow('web-console 不可达')
  })

  it('webConsoleBaseUrl 非法:apply 照常注册,工具调用期报错(volatile 请求期校验)', async () => {
    vi.stubGlobal('fetch', stubFetch([]))
    const tools = stubTools()
    ctx.provide('tools', tools as never)
    ctx.provide('webServer', stubWebServer() as never)
    apply(ctx, { ...CONFIG, localRoot, webConsoleBaseUrl: volatileOf('not-a-url') })
    expect(tools.registered).toHaveLength(6)
    await expect(execute(toolOf(tools, 'workspace_list'), { instanceId: 'i-1' }))
      .rejects.toThrow('webConsoleBaseUrl 配置无效')
  })

  it('JWT 模式:登录态优先于服务密钥,工具请求走本地环回前缀代理且不带凭证头', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://127.0.0.1:3080/api/enterprise/workspace/instances/i-1/files',
      response: () => jsonResponse(200, { success: true, data: [FILE_DTO] }),
    }])
    // token 与 serviceKey 同时存在:登录态优先,不经服务密钥直连 web-console
    const { tools } = mount(fetchMock, 'sk-1', { token: 'jwt-e' })
    const list = toolOf(tools, 'workspace_list')
    const result = await execute(list, { instanceId: 'i-1' }) as { files: unknown[] }
    expect(result.files).toHaveLength(1)
    const [input, init] = fetchMock.mock.calls[0]!
    expect(String(input)).toBe('http://127.0.0.1:3080/api/enterprise/workspace/instances/i-1/files')
    expect(init?.headers).toEqual({})
  })

  it('会话工作目录优先:download 落到会话 cwd 而非配置根', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => new Response('cloud-body', { status: 200 }),
    }])
    const { tools } = mount(fetchMock)
    const sessionDir = await mkdtemp(join(tmpdir(), 'instance-workspace-session-'))
    const download = toolOf(tools, 'workspace_download')
    const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: sessionDir } } } }
    const result = await download.execute({ instanceId: 'i-1', path: 'out.txt' } as never, exec) as { absolutePath: string }
    expect(result.absolutePath).toBe(join(sessionDir, 'out.txt'))
    expect(await readFile(join(sessionDir, 'out.txt'), 'utf8')).toBe('cloud-body')
    await expect(readFile(join(localRoot, 'out.txt'), 'utf8')).rejects.toThrow()
  })
})

describe('员工面会话绑定与每回合注入', () => {
  let ctx: Context
  let localRoot: string

  const mountWithRegistry = async (
    options: { token?: string | undefined; toolMount?: 'global' | 'boundSessions' } = {},
  ) => {
    vi.stubGlobal('fetch', stubFetch([]))
    await ctx.plugin(AgentRegistry)
    const tools = stubTools()
    ctx.provide('tools', tools as never)
    const webServer = stubWebServer()
    ctx.provide('webServer', webServer as never)
    const user = stubCurrentUser('token' in options ? options.token : 'jwt-e')
    ctx.provide('currentUser', user as never)
    apply(ctx, {
      ...CONFIG,
      serviceKey: '',
      localRoot,
      ...(options.toolMount === undefined ? {} : { toolMount: options.toolMount }),
    })
    return { webServer, user, tools }
  }

  const report = async (webServer: ReturnType<typeof stubWebServer>, body: unknown) => {
    const route = webServer.routes.find(
      candidate => candidate.kind === 'exact' && candidate.path === '/api/enterprise/workspace/session-context',
    )
    if (route === undefined) throw new Error('report route not registered')
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const res = stubResponse()
    await route.handler(
      stubRequest('POST', '/api/enterprise/workspace/session-context', payload) as never,
      res as never,
    )
    return res
  }

  /** agent 桩:scoped ctx 提供 tools 注册桩(boundSessions 注入断言用),id 与
   * session id 对齐(POST 主路径经 ctx.agents.get(sessionId) 解析)。 */
  function sessionAgent(session: Session, scopedTools = stubTools()): Agent {
    const scopedCtx = new Context()
    scopedCtx.provide('tools', scopedTools as never)
    return {
      id: session.id,
      options: {},
      session,
      inbox: { nextTurn: [], nextStep: [] } as never,
      status: 'running',
      ctx: scopedCtx,
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => { throw new Error('instance-workspace must append directly to the open step') },
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

  function workspaceTexts(session: Session): string[] {
    const texts: string[] = []
    for (const event of session.snapshotEvents()) {
      if (event.type === 'user/message' && event.data.source.kind === 'instance-workspace') {
        texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
      }
    }
    return texts
  }

  async function fire(
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
      { messages: [proposed], turn, step, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
    )
    if (decision.kind === 'enter') {
      for (const message of decision.messages) {
        if (message === proposed) continue
        agent.session.append('user/message', message, { surfaceOp: 'append' })
      }
    }
  }

  beforeEach(async () => {
    ctx = new Context()
    localRoot = await stubLocalRoot()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('注册 prefix 代理、exact 上报与 exact pull 三条路由', async () => {
    const { webServer } = await mountWithRegistry()
    expect(webServer.routes.map(route => [route.kind, route.path])).toEqual([
      ['prefix', '/api/enterprise/workspace'],
      ['exact', '/api/enterprise/workspace/session-context'],
      ['exact', '/api/enterprise/workspace/pull'],
    ])
  })

  it('session-context:未登录 401,不落任何绑定', async () => {
    const { webServer } = await mountWithRegistry({ token: undefined })
    const res = await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })
    expect(res.status).toBe(401)
  })

  it('session-context:合法上报 204,幂等覆盖(重复上报后注入用新实例)', async () => {
    const { webServer } = await mountWithRegistry()
    expect((await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })).status).toBe(204)
    expect((await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })).status).toBe(204)
    expect((await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-2' })).status).toBe(204)

    const session = Session.create(SessionId('s-1'))
    openMessageTurn(session, 1)
    await fire(sessionAgent(session), 1, 1)
    expect(workspaceTexts(session)).toEqual([
      renderInstanceWorkspaceContextText({ processInstanceId: 'pi-2', taskId: null }),
    ])
  })

  it('session-context:畸形体 400(非 JSON / 缺字段 / 空字段)', async () => {
    const { webServer } = await mountWithRegistry()
    expect((await report(webServer, 'not json')).status).toBe(400)
    expect((await report(webServer, { processInstanceId: 'pi-1' })).status).toBe(400)
    expect((await report(webServer, { sessionId: '', processInstanceId: 'pi-1' })).status).toBe(400)
    expect((await report(webServer, { sessionId: 's-1' })).status).toBe(400)
    expect((await report(webServer, { sessionId: 's-1', processInstanceId: '' })).status).toBe(400)
  })

  it('pre-step:绑定会话首个 step 注入 <instance_workspace> 块,taskId 为 (无)', async () => {
    const { webServer } = await mountWithRegistry()
    await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })
    const session = Session.create(SessionId('s-1'))
    openMessageTurn(session, 1)

    await fire(sessionAgent(session), 1, 1)

    const expected = renderInstanceWorkspaceContextText({ processInstanceId: 'pi-1', taskId: null })
    expect(expected).toContain('instanceId: pi-1')
    expect(expected).toContain('taskId: (无)')
    expect(workspaceTexts(session)).toEqual([expected])
    const event = session.snapshotEvents().at(-1)
    expect(event?.type).toBe('user/message')
    if (event?.type !== 'user/message') throw new Error('missing instance-workspace block')
    expect(event.data.source).toEqual({
      kind: 'instance-workspace',
      form: 'snapshot',
      sections: [{ name: INSTANCE_WORKSPACE_SECTION, text: expected }],
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('pre-step:无绑定的会话不注入,后续 step 也不注入', async () => {
    const { webServer } = await mountWithRegistry()
    await report(webServer, { sessionId: 's-other', processInstanceId: 'pi-1' })
    const session = Session.create(SessionId('s-unbound'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    await fire(agent, 1, 1)
    await fire(agent, 1, 2)

    expect(workspaceTexts(session)).toEqual([])
  })

  it('pre-step:登出后即使有绑定也不注入', async () => {
    const { webServer, user } = await mountWithRegistry()
    await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })
    user.state.token = undefined
    const session = Session.create(SessionId('s-1'))
    openMessageTurn(session, 1)

    await fire(sessionAgent(session), 1, 1)

    expect(workspaceTexts(session)).toEqual([])
  })

  it('toolMount boundSessions:根注册表不注册 workspace_* 工具', async () => {
    const { tools } = await mountWithRegistry({ toolMount: 'boundSessions' })
    expect(tools.registered).toHaveLength(0)
  })

  it('toolMount boundSessions:agent 先创建、后上报,POST 上报时立即注入(主路径)', async () => {
    const { webServer } = await mountWithRegistry({ toolMount: 'boundSessions' })
    const scoped = stubTools()
    const session = Session.create(SessionId('s-1'))
    const agent = sessionAgent(session, scoped)
    await ctx.agents.register(agent)
    // 创建时尚未绑定:agent/created 兜底监听跳过,scoped 注册表为空。
    expect(scoped.registered).toHaveLength(0)

    expect((await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })).status).toBe(204)
    expect(scoped.registered.map(tool => tool.name).sort()).toEqual([
      'workspace_delete',
      'workspace_download',
      'workspace_list',
      'workspace_read',
      'workspace_upload',
      'workspace_write',
    ])
  })

  it('toolMount boundSessions:上报先于创建,agent/created 兜底注入;未绑定会话不注入', async () => {
    const { webServer } = await mountWithRegistry({ toolMount: 'boundSessions' })
    await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })

    const boundTools = stubTools()
    const bound = sessionAgent(Session.create(SessionId('s-1')), boundTools)
    await ctx.agents.register(bound)
    expect(boundTools.registered.map(tool => tool.name).sort()).toEqual([
      'workspace_delete',
      'workspace_download',
      'workspace_list',
      'workspace_read',
      'workspace_upload',
      'workspace_write',
    ])

    const unboundTools = stubTools()
    const unbound = sessionAgent(Session.create(SessionId('s-unbound')), unboundTools)
    await ctx.agents.register(unbound)
    expect(unboundTools.registered).toHaveLength(0)
  })

  it('toolMount boundSessions:重复上报与二次注入幂等(WeakSet 去重,不重复注册)', async () => {
    const { webServer } = await mountWithRegistry({ toolMount: 'boundSessions' })
    const scoped = stubTools()
    const agent = sessionAgent(Session.create(SessionId('s-1')), scoped)
    await ctx.agents.register(agent)

    await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })
    await report(webServer, { sessionId: 's-1', processInstanceId: 'pi-1' })
    expect(scoped.registered).toHaveLength(6)
    expect(new Set(scoped.registered.map(tool => tool.name)).size).toBe(6)
  })
})

describe('员工面 pull 端点', () => {
  let ctx: Context
  let localRoot: string
  let sessionDir: string

  /** pull 路由桩 agent:pull 端点只读 session.header.cwd 这一处。 */
  const stubAgent = (cwd: string | undefined) => ({ session: { header: { cwd } } })

  const mountPull = (
    fetchMock: ReturnType<typeof stubFetch>,
    agent: unknown,
    options: { token?: string | undefined } = {},
  ) => {
    vi.stubGlobal('fetch', fetchMock)
    const webServer = stubWebServer()
    ctx.provide('tools', stubTools() as never)
    ctx.provide('webServer', webServer as never)
    ctx.provide('currentUser', stubCurrentUser('token' in options ? options.token : 'jwt-e') as never)
    ctx.provide('agents', { get: () => agent } as never)
    apply(ctx, { ...CONFIG, serviceKey: '', localRoot })
    return webServer
  }

  const pull = async (webServer: ReturnType<typeof stubWebServer>, body: unknown) => {
    const route = webServer.routes.find(
      candidate => candidate.kind === 'exact' && candidate.path === '/api/enterprise/workspace/pull',
    )
    if (route === undefined) throw new Error('pull route not registered')
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const res = stubResponse()
    await route.handler(
      stubRequest('POST', '/api/enterprise/workspace/pull', payload) as never,
      res as never,
    )
    return res
  }

  beforeEach(async () => {
    ctx = new Context()
    localRoot = await stubLocalRoot()
    sessionDir = await mkdtemp(join(tmpdir(), 'instance-workspace-pull-'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未登录 401', async () => {
    const webServer = mountPull(stubFetch([]), stubAgent(sessionDir), { token: undefined })
    const res = await pull(webServer, { sessionId: 's-1', instanceId: 'i-1', relPath: 'a.txt', target: 'cwd' })
    expect(res.status).toBe(401)
  })

  it('畸形体 400(非 JSON / 缺字段 / target 非法 / relPath 越界)', async () => {
    const webServer = mountPull(stubFetch([]), stubAgent(sessionDir))
    expect((await pull(webServer, 'not json')).status).toBe(400)
    expect((await pull(webServer, { sessionId: 's-1', relPath: 'a.txt', target: 'cwd' })).status).toBe(400)
    expect((await pull(webServer, { sessionId: 's-1', instanceId: 'i-1', relPath: 'a.txt', target: 'elsewhere' })).status).toBe(400)
    expect((await pull(webServer, { sessionId: 's-1', instanceId: 'i-1', relPath: '../evil.txt', target: 'cwd' })).status).toBe(400)
    expect((await pull(webServer, { sessionId: 's-1', instanceId: 'i-1', target: 'cwd' })).status).toBe(400)
  })

  it('cwd 解析不到 400 fail loud', async () => {
    const webServer = mountPull(stubFetch([]), undefined)
    const res = await pull(webServer, { sessionId: 's-ghost', instanceId: 'i-1', relPath: 'a.txt', target: 'cwd' })
    expect(res.status).toBe(400)
    expect((JSON.parse(res.body) as { error: string }).error).toContain('无法解析会话工作目录')
  })

  it('target=cwd 成功:落到会话 cwd 同 relPath,返回 localPath', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://127.0.0.1:3080/api/enterprise/workspace/instances/i-1/files/content/a.txt',
      response: () => new Response('cloud-body', { status: 200 }),
    }])
    const webServer = mountPull(fetchMock, stubAgent(sessionDir))
    const res = await pull(webServer, { sessionId: 's-1', instanceId: 'i-1', relPath: 'a.txt', target: 'cwd' })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ localPath: join(sessionDir, 'a.txt') })
    expect(await readFile(join(sessionDir, 'a.txt'), 'utf8')).toBe('cloud-body')
  })

  it('target=cwd 同名已存在 409 且不下载,overwrite=true 覆盖成功', async () => {
    await writeFile(join(sessionDir, 'a.txt'), 'local')
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => new Response('cloud-body', { status: 200 }),
    }])
    const webServer = mountPull(fetchMock, stubAgent(sessionDir))
    const body = { sessionId: 's-1', instanceId: 'i-1', relPath: 'a.txt', target: 'cwd' }
    const conflict = await pull(webServer, body)
    expect(conflict.status).toBe(409)
    expect(JSON.parse(conflict.body)).toEqual({ existed: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(join(sessionDir, 'a.txt'), 'utf8')).toBe('local')
    const ok = await pull(webServer, { ...body, overwrite: true })
    expect(ok.status).toBe(200)
    expect(await readFile(join(sessionDir, 'a.txt'), 'utf8')).toBe('cloud-body')
  })

  it('target=cache:落 .dsh/instance-workspace-cache/{instanceId}/relPath 且直接覆盖', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => new Response('cached-body', { status: 200 }),
    }])
    const webServer = mountPull(fetchMock, stubAgent(sessionDir))
    const cachePath = join(sessionDir, '.dsh', 'instance-workspace-cache', 'i-1', 'a.txt')
    await mkdir(join(sessionDir, '.dsh', 'instance-workspace-cache', 'i-1'), { recursive: true })
    await writeFile(cachePath, 'stale')
    const res = await pull(webServer, { sessionId: 's-1', instanceId: 'i-1', relPath: 'a.txt', target: 'cache' })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ localPath: cachePath })
    expect(await readFile(cachePath, 'utf8')).toBe('cached-body')
  })

  it('内容超过拉取上限 413 且不落盘', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => new Response('x'.repeat(2048), { status: 200 }),
    }])
    const webServer = mountPull(fetchMock, stubAgent(sessionDir))
    const res = await pull(webServer, { sessionId: 's-1', instanceId: 'i-1', relPath: 'big.bin', target: 'cwd' })
    expect(res.status).toBe(413)
    await expect(readFile(join(sessionDir, 'big.bin'), 'utf8')).rejects.toThrow()
  })
})
