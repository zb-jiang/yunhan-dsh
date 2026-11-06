import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, registerPptRoutes, type PptRpcDeps } from '../src/rpc.ts'
import type { Context } from '@deepseek-ai/cordis'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-rpc-'))
  roots.push(dir)
  return dir
}

/** 造出厂/新增各一套合法模板与一个上传件。 */
function makeFixture(): { builtinRoot: string; stylesRoot: string; uploadsDir: string; skillDir: string } {
  const root = scratch()
  const builtinRoot = join(root, 'builtin')
  const stylesRoot = join(root, 'styles')
  const uploadsDir = join(root, 'uploads')
  const skillDir = join(root, 'skill')
  mkdirSync(join(builtinRoot, 'corp', 'preview'), { recursive: true })
  writeFileSync(join(builtinRoot, 'corp', 'template.json'), JSON.stringify({ name: 'corp', category: 'business' }), 'utf8')
  writeFileSync(join(builtinRoot, 'corp', 'spec.md'), 'spec', 'utf8')
  writeFileSync(join(builtinRoot, 'corp', 'preview', 'page-01.jpg'), 'jpg-bytes', 'utf8')
  mkdirSync(join(stylesRoot, 'mine', 'preview'), { recursive: true })
  writeFileSync(join(stylesRoot, 'mine', 'template.json'), JSON.stringify({ name: 'mine', category: 'business' }), 'utf8')
  writeFileSync(join(stylesRoot, 'mine', 'design_spec.md'), 'style spec', 'utf8')
  writeFileSync(join(stylesRoot, 'mine', 'preview', 'page-01.jpg'), 'jpg-bytes', 'utf8')
  return { builtinRoot, stylesRoot, uploadsDir, skillDir }
}

function makeDeps(fixture?: Partial<PptRpcDeps>): PptRpcDeps {
  const paths = makeFixture()
  return {
    builtinRoot: paths.builtinRoot,
    stylesRoot: paths.stylesRoot,
    uploadsDir: paths.uploadsDir,
    skillDir: paths.skillDir,
    readSettings: () => ({ imageBackend: '', imageApiKey: '', imageBaseUrl: '', imageModel: '' }),
    writeSettings: () => {},
    commandRunner: async (_command, args) => args[0] === '--version'
      ? { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'not installed' },
    ...fixture,
  }
}

/** 路由处理函数签名(registerPptRoutes 挂进 webServer 的形态)。 */
type PptRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** 请求桩的可覆写字段。 */
interface StubRequestOptions {
  method?: string | undefined
  url?: string | undefined
  headers?: Record<string, string> | undefined
  body?: Buffer | undefined
}

/** 请求桩:EventEmitter + 可覆写的方法/url/头;destroy 可观测。 */
function stubRequest(options: StubRequestOptions): IncomingMessage & { destroyed: boolean } {
  const req = new EventEmitter() as IncomingMessage & { destroyed: boolean }
  req.destroyed = false
  req.method = options.method ?? 'GET'
  req.url = options.url ?? '/status'
  req.headers = options.headers ?? {}
  req.destroy = () => { req.destroyed = true; return req }
  if (options.body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', options.body)
      req.emit('end')
    })
  }
  return req
}

/** 响应桩:记录 writeHead/end/destroy。 */
function stubResponse(): ServerResponse & { statusCode?: number; headers?: Record<string, string>; chunks: Buffer[]; ended: boolean } {
  const res = new EventEmitter() as ServerResponse & {
    statusCode?: number
    headers?: Record<string, string>
    chunks: Buffer[]
    ended: boolean
  }
  res.chunks = []
  res.ended = false
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    res.statusCode = status
    if (headers !== undefined) res.headers = headers
    Object.defineProperty(res, 'headersSent', { value: true, configurable: true })
    return res
  }) as typeof res.writeHead
  res.end = ((chunk?: Buffer | string) => {
    if (chunk !== undefined) res.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    res.ended = true
    return res
  }) as typeof res.end
  res.destroy = () => { res.ended = true; res.destroyed = true; return res }
  return res
}

/**
 * 测试桩只实现被测函数触碰的 Context 成员;object 入参保证单一断言可收窄,
 * 避免引入基线禁令的 `as unknown`。
 */
function stubContext(stub: object): Context {
  return stub as Context
}

function handlerOf(deps: PptRpcDeps): PptRouteHandler {
  const routes: { handler: PptRouteHandler }[] = []
  const ctx = stubContext({
    webServer: {
      register: (route: { handler: PptRouteHandler }) => {
        routes.push(route)
        return () => {}
      },
    },
  })
  registerPptRoutes(ctx, deps)
  const handler = routes[0]?.handler
  if (handler === undefined) throw new Error('expected /api/ppt route')
  return handler
}

/** call 的返回:状态码 + 响应体文本。 */
interface CallResult {
  status?: number | undefined
  body: string
}

async function call(handler: PptRouteHandler, req: IncomingMessage, res: ServerResponse): Promise<CallResult> {
  const pending = handler(req, res)
  if (req.listenerCount('data') > 0 && 'headers' in req && (req as { headers: Record<string, string> }).headers['content-length'] === undefined) {
    req.emit('data', Buffer.alloc(0))
    req.emit('end')
  }
  await pending
  const stub = res as ServerResponse & { chunks: Buffer[] }
  return { status: (res as { statusCode?: number }).statusCode, body: Buffer.concat(stub.chunks).toString('utf8') }
}

/** 造一个合法的提炼产物工作空间(design_spec.md 带合规 frontmatter)。 */
function makeWorkspace(slug = 'distilled'): string {
  const workspace = scratch()
  mkdirSync(join(workspace, 'ppt-template', 'preview'), { recursive: true })
  writeFileSync(join(workspace, 'ppt-template', 'template.json'), JSON.stringify({ name: '提炼', category: 'business' }), 'utf8')
  writeFileSync(join(workspace, 'ppt-template', 'design_spec.md'), `---\nstyle_id: ${slug}\nkind: style\nsummary: 一句话\nkeywords: [a, b, c]\n---\n正文`, 'utf8')
  writeFileSync(join(workspace, 'ppt-template', 'preview', 'page-01.jpg'), 'jpg', 'utf8')
  return workspace
}

describe('rpc routes', () => {
  it('GET /status 返回健康载荷', async () => {
    const handler = handlerOf(makeDeps())
    const res = stubResponse()
    const { status, body } = await call(handler, stubRequest({ url: '/status' }), res)
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ ok: true, plugin: 'ppt' })
  })

  it('未知路由回 404', async () => {
    const handler = handlerOf(makeDeps())
    const res = stubResponse()
    const { status } = await call(handler, stubRequest({ method: 'POST', url: '/nope' }), res)
    expect(status).toBe(404)
  })

  it('GET /templates 清单:出厂在前、新增在后 + previewUrl 模板 + 上限', async () => {
    const handler = handlerOf(makeDeps())
    const res = stubResponse()
    const { status, body } = await call(handler, stubRequest({ url: '/templates' }), res)
    expect(status).toBe(200)
    const payload = JSON.parse(body) as {
      maxCustomTemplates: number
      templates: { id: string; origin: string; previewUrlTemplate: string }[]
    }
    expect(payload.maxCustomTemplates).toBe(10)
    expect(payload.templates.map(item => item.id)).toEqual(['corp', 'mine'])
    expect(payload.templates.map(item => item.origin)).toEqual(['factory', 'added'])
    expect(payload.templates[1]?.previewUrlTemplate).toBe('/api/ppt/templates/mine/pages/{page}')
    expect(JSON.stringify(payload.templates)).not.toContain('specPath')
  })

  it('GET /templates/:id/pages/:n 返回页图;缺页/非法页/非法 id 各回对应状态', async () => {
    const handler = handlerOf(makeDeps())
    const ok = stubResponse()
    const okResult = await call(handler, stubRequest({ url: '/templates/corp/pages/1' }), ok)
    expect(okResult.status).toBe(200)
    expect(okResult.body).toBe('jpg-bytes')

    const missing = stubResponse()
    expect((await call(handler, stubRequest({ url: '/templates/corp/pages/2' }), missing)).status).toBe(404)
    const badPage = stubResponse()
    expect((await call(handler, stubRequest({ url: '/templates/corp/pages/0' }), badPage)).status).toBe(400)
    const badId = stubResponse()
    expect((await call(handler, stubRequest({ url: '/templates/nope/pages/1' }), badId)).status).toBe(404)
    const traversal = stubResponse()
    expect((await call(handler, stubRequest({ url: '/templates/.hidden/pages/1' }), traversal)).status).toBe(404)
  })

  it('DELETE /templates/:id 删新增;出厂 403;未知 404', async () => {
    const handler = handlerOf(makeDeps())
    const res = stubResponse()
    expect((await call(handler, stubRequest({ method: 'DELETE', url: '/templates/mine' }), res)).status).toBe(200)
    const refused = stubResponse()
    expect((await call(handler, stubRequest({ method: 'DELETE', url: '/templates/corp' }), refused)).status).toBe(403)
    const missing = stubResponse()
    expect((await call(handler, stubRequest({ method: 'DELETE', url: '/templates/gone' }), missing)).status).toBe(404)
  })

  it('POST /uploads 收原始字节落盘并回带表单参数的提炼指令', async () => {
    const deps = makeDeps()
    const handler = handlerOf(deps)
    const res = stubResponse()
    const query = new URLSearchParams({ slug: 'distilled', name: '提炼模板', category: 'business', filename: '课程二_参考.pptx' }).toString()
    const { status, body } = await call(
      handler,
      stubRequest({
        method: 'POST',
        url: `/uploads?${query}`,
        headers: { 'content-length': '9' },
        body: Buffer.from('ref-bytes'),
      }),
      res,
    )
    expect(status).toBe(200)
    const payload = JSON.parse(body) as { uploadPath: string; prompt: string }
    expect(payload.uploadPath.endsWith('.pptx')).toBe(true)
    expect(readFileSync(payload.uploadPath, 'utf8')).toBe('ref-bytes')
    expect(payload.prompt).toContain('templates/styles/README.md')
    expect(payload.prompt).toContain('style_id: distilled')
    expect(payload.prompt).toContain('提炼模板')
  })

  it('POST /uploads 接受 .pdf 参考文件并按扩展名落盘', async () => {
    const handler = handlerOf(makeDeps())
    const res = stubResponse()
    const query = new URLSearchParams({ slug: 'distilled', name: 'n', category: 'business', filename: 'ref.pdf' }).toString()
    const { status, body } = await call(
      handler,
      stubRequest({ method: 'POST', url: `/uploads?${query}`, headers: { 'content-length': '5' }, body: Buffer.from('pdf-1') }),
      res,
    )
    expect(status).toBe(200)
    const pdfPayload = JSON.parse(body) as { uploadPath: string }
    expect(pdfPayload.uploadPath.endsWith('.pdf')).toBe(true)
  })

  it('POST /uploads 缺 filename、非 .pptx/.pdf、非法 slug/名称/分类各回 400', async () => {
    const handler = handlerOf(makeDeps())
    const noFilename = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/uploads?slug=abc&name=n&category=business' }), noFilename)).status).toBe(400)
    const wrongExt = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/uploads?slug=abc&name=n&category=business&filename=a.docx' }), wrongExt)).status).toBe(400)
    const badSlug = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/uploads?slug=AB&name=n&category=business&filename=a.pptx' }), badSlug)).status).toBe(400)
    const badName = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/uploads?slug=abc&name=&category=business&filename=a.pptx' }), badName)).status).toBe(400)
    const badCategory = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/uploads?slug=abc&name=n&category=other&filename=a.pptx' }), badCategory)).status).toBe(400)
  })

  it('POST /uploads 超限:声明超长 413 且不读体;流式超长 413 且销毁连接', async () => {
    const handler = handlerOf(makeDeps())
    const declared = stubResponse()
    const declaredReq = stubRequest({ method: 'POST', url: '/uploads?slug=abc&name=n&category=business&filename=a.pptx', headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) } })
    expect((await call(handler, declaredReq, declared)).status).toBe(413)
    expect(declaredReq.destroyed).toBe(false)

    const streamed = stubResponse()
    const streamedReq = stubRequest({ method: 'POST', url: '/uploads?slug=abc&name=n&category=business&filename=a.pptx' })
    const pending = handler(streamedReq, streamed)
    streamedReq.emit('data', Buffer.alloc(MAX_UPLOAD_BYTES + 1))
    await pending
    expect(streamed.statusCode).toBe(413)
    expect(streamedReq.destroyed).toBe(true)
  })

  it('POST /templates/import 登记为新增 style 并同步 skill 树;坏产物 422;撞名/满额 409', async () => {
    const deps = makeDeps()
    const handler = handlerOf(deps)
    const workspace = makeWorkspace()

    const res = stubResponse()
    const ok = await call(handler, stubRequest({ method: 'POST', url: '/templates/import', headers: { 'content-length': '64' }, body: Buffer.from(JSON.stringify({ workspace })) }), res)
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ kind: 'imported', id: 'distilled' })
    expect(readFileSync(join(deps.skillDir, 'templates', 'styles', 'distilled', 'templates', 'design_spec.md'), 'utf8')).toContain('style_id: distilled')

    const noWorkspace = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/templates/import' }), noWorkspace)).status).toBe(400)

    const badRoot = scratch()
    mkdirSync(join(badRoot, 'ppt-template'), { recursive: true })
    const bad = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/templates/import', headers: { 'content-length': '80' }, body: Buffer.from(JSON.stringify({ workspace: badRoot })) }), bad)).status).toBe(422)

    const conflict = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/templates/import', headers: { 'content-length': '64' }, body: Buffer.from(JSON.stringify({ workspace })) }), conflict)).status).toBe(409)

    for (let i = 0; i < 9; i += 1) {
      mkdirSync(join(deps.stylesRoot, `filler${i}`, 'preview'), { recursive: true })
      writeFileSync(join(deps.stylesRoot, `filler${i}`, 'template.json'), JSON.stringify({ name: `t${i}`, category: 'business' }), 'utf8')
      writeFileSync(join(deps.stylesRoot, `filler${i}`, 'design_spec.md'), 's', 'utf8')
    }
    const other = makeWorkspace('another')
    const full = stubResponse()
    expect((await call(handler, stubRequest({ method: 'POST', url: '/templates/import', headers: { 'content-length': '64' }, body: Buffer.from(JSON.stringify({ workspace: other })) }), full)).status).toBe(409)
  })

  it('GET/PUT /settings:GET 不回明文,PUT 归一校验', async () => {
    let stored = { imageBackend: 'openai', imageApiKey: 'secret', imageBaseUrl: '', imageModel: '' }
    const deps = makeDeps({
      readSettings: () => stored,
      writeSettings: (next) => { stored = next },
    })
    const handler = handlerOf(deps)
    const get = stubResponse()
    const getResult = await call(handler, stubRequest({ url: '/settings' }), get)
    expect(getResult.status).toBe(200)
    const settings = JSON.parse(getResult.body) as {
      configured: boolean
      imageBackend: string
      imageBaseUrl: string
      imageModel: string
      knownBackends: string[]
    }
    expect(settings.configured).toBe(true)
    expect(settings.imageBackend).toBe('openai')
    expect(settings.imageBaseUrl).toBe('')
    expect(settings.imageModel).toBe('')
    expect(Array.isArray(settings.knownBackends)).toBe(true)
    expect(getResult.body).not.toContain('secret')

    const put = stubResponse()
    const putResult = await call(
      handler,
      stubRequest({ method: 'PUT', url: '/settings', headers: { 'content-length': '96' }, body: Buffer.from(JSON.stringify({ imageBackend: 'gemini', imageApiKey: 'k2', imageBaseUrl: 'https://b', imageModel: 'm' })) }),
      put,
    )
    expect(putResult.status).toBe(200)
    expect(stored.imageBackend).toBe('gemini')
    const putPayload = JSON.parse(putResult.body) as { configured: boolean }
    expect(putPayload.configured).toBe(true)

    // GET 摘要不含明文 Key:空串 Key 表示保留已保存值,其余字段照常更新。
    const keepKey = stubResponse()
    const keepResult = await call(
      handler,
      stubRequest({ method: 'PUT', url: '/settings', headers: { 'content-length': '80' }, body: Buffer.from(JSON.stringify({ imageBackend: 'qwen', imageApiKey: '', imageBaseUrl: '', imageModel: 'qmax' })) }),
      keepKey,
    )
    expect(keepResult.status).toBe(200)
    expect(stored).toEqual({ imageBackend: 'qwen', imageApiKey: 'k2', imageBaseUrl: '', imageModel: 'qmax' })

    const bad = stubResponse()
    expect((await call(handler, stubRequest({ method: 'PUT', url: '/settings', headers: { 'content-length': '2' }, body: Buffer.from('[]') }), bad)).status).toBe(400)
    const badField = stubResponse()
    expect((await call(handler, stubRequest({ method: 'PUT', url: '/settings', headers: { 'content-length': '20' }, body: Buffer.from(JSON.stringify({ imageBackend: 1, imageApiKey: 'k', imageBaseUrl: '', imageModel: '' })) }), badField)).status).toBe(400)
  })

  it('GET /python-status 透传检测结果', async () => {
    const handler = handlerOf(makeDeps())
    const res = stubResponse()
    const { status, body } = await call(handler, stubRequest({ url: '/python-status' }), res)
    expect(status).toBe(200)
    const payload = JSON.parse(body) as { python: { available: boolean; pythonCmd: string }; ready: boolean }
    expect(payload.python.available).toBe(true)
    expect(payload.ready).toBe(false)
  })

  it('意外异常回 500;响应头已发出时销毁连接', async () => {
    const deps = makeDeps({ readSettings: () => { throw new Error('disk gone') } })
    const handler = handlerOf(deps)
    const res = stubResponse()
    expect((await call(handler, stubRequest({ url: '/settings' }), res)).status).toBe(500)

    const crashed = stubResponse()
    const sentRes = stubResponse()
    Object.defineProperty(sentRes, 'headersSent', { value: true, configurable: true })
    sentRes.destroy = (() => {
      ;(sentRes as { destroyed?: boolean }).destroyed = true
      return sentRes
    })
    const pending = handler(stubRequest({ url: '/settings' }), sentRes)
    await pending
    expect((sentRes as { destroyed?: boolean }).destroyed).toBe(true)
    expect(crashed.ended).toBe(false)
  })
})
