/**
 * `/api/ppt` 前缀下的全部 RPC 端点(设计 2026-11-04 §5.2)。
 *
 * 上传不走 multipart:客户端是本插件的 ppt-client,直接以
 * `application/octet-stream` + `x-ppt-filename` 头发原始字节,宿主收满
 * 即存,省掉 multipart 解析依赖。提炼产物登记与设置写入走 JSON。
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { buildExtractionPrompt, importFromWorkspace } from './extraction.ts'
import { pythonStatus, type CommandRunner, type PythonStatus } from './python.ts'
import { publicView, type ImageSettings, type PublicSettings } from './settings.ts'
import { deleteTemplate, listTemplates, resolveTemplateDir, SLUG_PATTERN, TEMPLATE_CATEGORIES, type PptTemplate, type TemplateCategory } from './templates.ts'

/** 建议上传上限 50MB(PRD §4.7);超过直接拒绝,不读体。 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** rpc 依赖面:路径根与可注入的检测执行器,测试用临时目录装配。 */
export interface PptRpcDeps {
  builtinRoot: string
  /** 新增 style 真身根目录(`$DSH_HOME/ppt-templates/styles`)。 */
  stylesRoot: string
  uploadsDir: string
  skillDir: string
  readSettings(): ImageSettings
  writeSettings(settings: ImageSettings): void
  commandRunner: CommandRunner
}

/** rpc 层业务失败(HTTP 状态随附;code 供客户端区分同状态码的不同业务失败)。 */
class RpcError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) })
  res.end(json)
}

/** 读请求体,超过上限即销毁连接并抛 413。 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0')
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new RpcError(413, 'body-too-large', `body exceeds ${maxBytes} bytes`))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        reject(new RpcError(413, 'body-too-large', `body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', (error: unknown) => { reject(error instanceof Error ? error : new Error(String(error))) })
  })
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse((await readBody(req, maxBytes)).toString('utf8'))
  } catch (error) {
    if (error instanceof RpcError) throw error
    throw new RpcError(400, 'invalid-json', `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RpcError(400, 'invalid-json', 'body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** 清单响应项:模板元数据 + 预览页 URL 的构造模板。 */
interface TemplateListItem extends PptTemplate {
  previewUrlTemplate: string
}

/** GET /templates 响应体。 */
interface TemplateListPayload {
  templates: TemplateListItem[]
  maxCustomTemplates: number
}

/** GET /settings 响应体。 */
type SettingsPayload = PublicSettings

/** GET /python-status 响应体。 */
type PythonStatusPayload = PythonStatus

/** POST /uploads 响应体:落盘路径 + 直接可用的提炼指令。 */
interface UploadPayload {
  uploadPath: string
  prompt: string
}

/** 把页号渲染成 `page-NN.jpg` 的零垫文件名。 */
function previewFileName(page: number): string {
  return `page-${String(page).padStart(2, '0')}.jpg`
}

/** 逐段路由;未匹配抛 404。 */
async function route(method: string, segments: string[], req: IncomingMessage, res: ServerResponse, deps: PptRpcDeps): Promise<void> {
  const [head, second, third, fourth] = segments
  if (method === 'GET' && head === 'status' && second === undefined) {
    sendJson(res, 200, { ok: true, plugin: 'ppt' })
    return
  }
  if (method === 'GET' && head === 'templates' && second === undefined) {
    const templates: TemplateListItem[] = listTemplates(deps.builtinRoot, deps.stylesRoot)
      .map(template => ({
        ...template,
        previewUrlTemplate: `/api/ppt/templates/${template.id}/pages/{page}`,
      }))
    const payload: TemplateListPayload = { templates, maxCustomTemplates: 10 }
    sendJson(res, 200, payload)
    return
  }
  if (method === 'GET' && head === 'templates' && second !== undefined && third === 'pages' && fourth !== undefined) {
    const page = Number(fourth)
    if (!Number.isInteger(page) || page < 1) throw new RpcError(400, 'invalid-page', 'page must be a positive integer')
    const dir = resolveTemplateDir(deps.builtinRoot, deps.stylesRoot, second)
    if (dir === undefined) throw new RpcError(404, 'unknown-template', `unknown template: ${second}`)
    const file = join(dir, 'preview', previewFileName(page))
    if (!existsSync(file)) throw new RpcError(404, 'unknown-page', `no preview page ${page} for ${second}`)
    const content = readFileSync(file)
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': content.length })
    res.end(content)
    return
  }
  if (method === 'DELETE' && head === 'templates' && second !== undefined && third === undefined) {
    const outcome = deleteTemplate(deps.builtinRoot, deps.stylesRoot, deps.skillDir, second)
    if (outcome === 'refused') throw new RpcError(403, 'factory-undeletable', 'factory templates cannot be deleted')
    if (outcome === 'missing') throw new RpcError(404, 'unknown-template', `unknown template: ${second}`)
    sendJson(res, 200, { deleted: true })
    return
  }
  if (method === 'POST' && head === 'uploads' && second === undefined) {
    // 表单字段与文件名都走查询串:HTTP header 值仅允许 latin1,中文文件
    // 名放 header 会在客户端 fetch 阶段就抛 Invalid header value。
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const filename = query.get('filename') ?? ''
    const slug = query.get('slug') ?? ''
    const name = query.get('name') ?? ''
    const category = query.get('category') ?? ''
    const extension = ['.pptx', '.pdf'].find(candidate => filename.toLowerCase().endsWith(candidate))
    if (extension === undefined) throw new RpcError(400, 'invalid-filename', 'query param filename must end with .pptx or .pdf')
    if (!SLUG_PATTERN.test(slug)) throw new RpcError(400, 'invalid-slug', 'query param slug must match ^[a-z][a-z0-9-]{2,63}$')
    if (name.trim() === '') throw new RpcError(400, 'invalid-name', 'query param name is required')
    if (!TEMPLATE_CATEGORIES.includes(category as TemplateCategory)) throw new RpcError(400, 'invalid-category', `query param category must be one of: ${TEMPLATE_CATEGORIES.join('/')}`)
    const body = await readBody(req, MAX_UPLOAD_BYTES)
    mkdirSync(deps.uploadsDir, { recursive: true })
    const uploadPath = join(deps.uploadsDir, `${randomUUID()}${extension}`)
    writeFileSync(uploadPath, body)
    const payload: UploadPayload = {
      uploadPath,
      prompt: buildExtractionPrompt(deps.skillDir, uploadPath, { slug, name, category: category as TemplateCategory }),
    }
    sendJson(res, 200, payload)
    return
  }
  if (method === 'POST' && head === 'templates' && second === 'import' && third === undefined) {
    const body = await readJsonBody(req)
    const workspace = body['workspace']
    if (typeof workspace !== 'string' || workspace === '') throw new RpcError(400, 'invalid-workspace', 'workspace is required')
    const outcome = importFromWorkspace(deps.stylesRoot, deps.builtinRoot, deps.skillDir, workspace)
    if (outcome.kind === 'invalid-meta') throw new RpcError(422, 'invalid-meta', 'workspace has no valid ppt-template output')
    if (outcome.kind === 'slug-conflict') throw new RpcError(409, 'slug-conflict', 'template slug already exists')
    if (outcome.kind === 'limit-reached') throw new RpcError(409, 'limit-reached', 'added templates are limited to 10')
    sendJson(res, 200, outcome)
    return
  }
  if (method === 'GET' && head === 'settings' && second === undefined) {
    const payload: SettingsPayload = publicView(deps.readSettings())
    sendJson(res, 200, payload)
    return
  }
  if (method === 'PUT' && head === 'settings' && second === undefined) {
    const body = await readJsonBody(req)
    const str = (value: unknown): string => {
      if (typeof value !== 'string') throw new RpcError(400, 'invalid-settings', 'settings fields must all be strings')
      return value
    }
    const next: ImageSettings = {
      imageBackend: str(body['imageBackend']),
      // GET 摘要不回明文 Key,客户端无法回传旧值:空串表示「保留已保存 Key」,
      // 想清空整个配置走 backend 置空(renderDotEnv 对未配置不写 .env)。
      imageApiKey: str(body['imageApiKey']) === '' ? deps.readSettings().imageApiKey : str(body['imageApiKey']),
      imageBaseUrl: str(body['imageBaseUrl']),
      imageModel: str(body['imageModel']),
    }
    deps.writeSettings(next)
    const payload: SettingsPayload = publicView(next)
    sendJson(res, 200, payload)
    return
  }
  if (method === 'GET' && head === 'python-status' && second === undefined) {
    const payload: PythonStatusPayload = await pythonStatus(deps.commandRunner)
    sendJson(res, 200, payload)
    return
  }
  throw new RpcError(404, 'no-route', `no route: ${method} /api/ppt/${segments.join('/')}`)
}

/**
 * 在宿主 webserver 上注册 `/api/ppt` 前缀路由;handler 内部按方法与
 * 路径段分发,业务失败折算状态码,响应头已发出时只能销毁连接。
 *
 * @param ctx - 已就绪 webServer 的宿主上下文。
 * @param deps - 路径根与设置/检测依赖,由插件入口装配。
 * @returns 路由注销函数,交由 `ctx.effect` 管理。
 */
export function registerPptRoutes(ctx: Context, deps: PptRpcDeps): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/api/ppt',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const segments = url.pathname.replace(/^\/api\/ppt\/?/, '').split('/').filter(segment => segment !== '')
      try {
        await route(req.method ?? 'GET', segments, req, res, deps)
      } catch (error) {
        const status = error instanceof RpcError ? error.status : 500
        const body = error instanceof RpcError
          ? { error: error.message, code: error.code }
          : { error: error instanceof Error ? error.message : String(error) }
        if (!res.headersSent) {
          sendJson(res, status, body)
          return
        }
        res.destroy()
      }
    },
  })
}
