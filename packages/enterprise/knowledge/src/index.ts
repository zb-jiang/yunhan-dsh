/**
 * Enterprise knowledge base access on the employee side (design 2026-09-11 §6)
 * and on the unattended backend profile (2026-10 service-key integration).
 *
 * Two surfaces over the same web-console REST:
 *
 * 1. Local webserver proxy: browser surfaces (ui-enterprise KB selector,
 *    workspace upload) reach web-console `/api/kb/*` and `/api/apps/*` only
 *    through the local DSH webserver — never directly — with the signed-in
 *    employee's Supabase JWT attached from `ctx.currentUser.getToken()`.
 *
 * 2. Model-facing tools `kb_search` / `kb_read` / `kb_list` registered on
 *    `ctx.tools`, so the todo-session AI can retrieve application knowledge on
 *    demand. Tool calls and results go through the normal registry pipeline,
 *    which logs them as session events (model-visible ⟺ logged). Auth is
 *    resolved per call: the employee JWT when a login identity exists
 *    (enterprise profile), otherwise the configured service key (backend
 *    profile has no login) with tool paths rewritten to the service-key
 *    allowlist endpoints `/api/backend/kb/*`.
 *
 * @module @deepseek-ai/dsh-knowledge
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { proxyRequest, validateBaseUrl } from '@deepseek-ai/dsh-web-console-proxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-user-identity-context'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'knowledge'

/**
 * 等待本地 webserver 与工具注册表就绪后才挂载。
 *
 * <p>不含 `currentUser`:backend profile 无登录身份插件,若列入 inject 该插件
 * 将永不就绪。登录态改为工具调用时懒读取(见 apply),enterprise profile 下
 * JWT 优先,backend profile 下回退服务密钥。
 */
export const inject = ['webServer', 'tools']

/** kb_read 全文返回上限默认值(字符;超出截断并注明)。 */
const DEFAULT_READ_MAX_CHARS = 40_000

/** kb_search 默认返回条数。 */
const DEFAULT_TOP_K = 8

/** 插件配置,全部来自 enterprise/backend profile 的 cordis.yml config 段。 */
export interface Config {
  /** web-console 基地址(协议+主机+端口,无路径);volatile:设置面板可改,即时生效。 */
  webConsoleBaseUrl: Volatile<string>
  /** kb_read 返回全文的最大字符数,超出截断并在结果中注明。 */
  readMaxChars: number
  /**
   * 服务密钥(X-Service-Key):backend profile 无人值守模式的 web-console 认证
   * 凭证,须与 web-console {@code dsh.service-key} 一致。enterprise profile 有
   * 登录 JWT,保持空串即可;两处都为空时工具调用报错。
   */
  serviceKey: string
}

export const Config = z.object({
  webConsoleBaseUrl: z.string().required().volatile(),
  readMaxChars: z.number().default(DEFAULT_READ_MAX_CHARS),
  serviceKey: z.string().default(''),
})

/**
 * 已解析的运行选项(apply 阶段完成校验与默认值合并)。
 *
 * <p>token/serviceKey 与 web-console 基地址取值函数注入而非内联,便于测试桩
 * 替换登录态与 volatile 基地址(设置面板修改后无需重载即生效)。
 */
export interface KnowledgeOptions {
  /** 当前 web-console 基地址(无尾斜杠;每次调用读取 volatile 最新值)。 */
  readonly webConsoleBaseUrl: () => string
  /** kb_read 全文返回上限(字符)。 */
  readonly readMaxChars: number
  /** 当前登录员工的 Supabase JWT;未登录(backend profile)为 undefined。 */
  readonly token: () => string | undefined
  /** 服务密钥;enterprise profile(登录态优先)为空串。 */
  readonly serviceKey: () => string
}

/** 代理路由:本地前缀 → web-console 真实前缀(浏览器只经本地 webserver)。 */
const PROXY_ROUTES: ReadonlyArray<{ readonly local: string; readonly upstream: string }> = [
  { local: '/api/enterprise/kb', upstream: '/api/kb' },
  { local: '/api/enterprise/apps', upstream: '/api/apps' },
]

/** web-console {@code ApiResponse} 信封(成功时 data 必有值)。 */
interface ApiEnvelope<T> {
  success?: boolean
  data?: T
  error?: { message?: string }
}

/** web-console {@code KbFolderDto}(本插件只消费 id、name 与 path)。 */
interface KbFolderDto {
  id: string
  name: string
  path: string
}

/** web-console {@code KbDocumentDto}(kb_list 消费的展示字段)。 */
interface KbDocumentDto {
  id: string
  name: string
  folderId: string | null
  sizeBytes: number
  parseStatus: string
  textExcerpt: string
}

/**
 * web-console {@code KbSearchHitDto}(kb_search 混合检索端点,文档级命中;三路
 * 候选统一按文档聚合,同文档只出现一条,snippet 为该文档的最优命中摘录)。
 */
interface KbSearchHit {
  docId: string
  docName: string
  folderId: string | null
  snippet: string
  score: number
}

/** web-console {@code KbDocumentTextDto}(kb_read 端点)。 */
interface KbDocumentTextDto {
  id: string
  kbId: string
  name: string
  textContent: string | null
  parseStatus: string
}

/**
 * 解析一次调用的认证方式与工具路径前缀。
 *
 * <p>登录 JWT 优先(enterprise profile,路径维持 `/api/kb/*`,web-console 做
 * 员工成员校验);未登录回退服务密钥(backend profile 无人值守,路径重写为
 * `/api/backend/kb/*` 白名单端点,服务身份代表应用本身、只读);两者皆无时
 * 抛错(错误消息面向模型呈现)。
 */
function resolveAuth(options: KnowledgeOptions): {
  headers: Record<string, string>
  /** 工具调用使用的 web-console 路径前缀。 */
  pathPrefix: '/api/kb' | '/api/backend/kb'
} {
  const token = options.token()
  if (token !== undefined) {
    return { headers: { authorization: `Bearer ${token}` }, pathPrefix: '/api/kb' }
  }
  const serviceKey = options.serviceKey()
  if (serviceKey !== '') {
    return { headers: { 'x-service-key': serviceKey }, pathPrefix: '/api/backend/kb' }
  }
  throw new Error('未登录且未配置服务密钥,无法访问企业知识库')
}

/**
 * 调 web-console 知识库 REST 并解 {@code ApiResponse} 信封。
 *
 * <p>工具路径以员工端前缀 `/api/kb/*` 书写;服务密钥模式下由这里统一重写为
 * `/api/backend/kb/*`(端点形态与员工端一一对应),调用方无需感知认证模式。
 *
 * @param options - 运行选项
 * @param path - 以 / 开头的绝对路径(不含 base)
 * @returns 信封 data
 * @throws Error 未登录且无服务密钥 / 网络不可达 / 响应非 JSON / 信封失败(错误消息面向模型呈现)
 */
async function requestJson<T>(options: KnowledgeOptions, path: string): Promise<T> {
  const auth = resolveAuth(options)
  const upstreamPath = path.startsWith('/api/kb/')
    ? `${auth.pathPrefix}${path.slice('/api/kb'.length)}`
    : path
  // volatile 配置:每次调用读取当前值,设置面板修改后无需重载即生效
  const webConsoleBaseUrl = options.webConsoleBaseUrl().replace(/\/+$/, '')
  if (validateBaseUrl(webConsoleBaseUrl) !== undefined) {
    throw new Error(`knowledge: webConsoleBaseUrl 配置无效: ${webConsoleBaseUrl}`)
  }
  let resp: Response
  try {
    resp = await fetch(new URL(upstreamPath, webConsoleBaseUrl), { headers: auth.headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`web-console 不可达(${webConsoleBaseUrl}): ${message}`)
  }
  let body: ApiEnvelope<T>
  try {
    body = await resp.json() as ApiEnvelope<T>
  } catch (error) {
    /* v8 ignore next 2 -- resp.json() only ever throws SyntaxError/TypeError,
    both Error instances; String(error) is unreachable defensive formatting. */
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`web-console 响应不是 JSON(HTTP ${resp.status}): ${message}`)
  }
  if (!resp.ok || body.success !== true || body.data === undefined) {
    throw new Error(`web-console 知识库请求失败(HTTP ${resp.status}): ${body.error?.message ?? '未知错误'}`)
  }
  return body.data
}

/** 归一化 folderPath:补前导 /、去尾斜杠;空串与 / 都表示根。 */
function normalizeFolderPath(folderPath: string): string {
  const withLeading = folderPath.startsWith('/') ? folderPath : `/${folderPath}`
  return withLeading.replace(/\/+$/, '') || '/'
}

/**
 * 解析 folderPath → 文件夹 id(工具入参是 path,web-console 端点是 folderId)。
 *
 * @param options - 运行选项
 * @param kbId - 知识库 id
 * @param folderPath - 物化路径(如 /财务/报销)
 * @returns 文件夹 id;根(/)返回 undefined(由调用方按全库处理)
 * @throws Error 文件夹不存在(路径拼错时 fail loud,模型可改用 kb_list 浏览)
 */
async function resolveFolder(
  options: KnowledgeOptions,
  kbId: string,
  folderPath: string,
): Promise<string | undefined> {
  const normalized = normalizeFolderPath(folderPath)
  if (normalized === '/') {
    return undefined
  }
  const folders = await requestJson<KbFolderDto[]>(options, `/api/kb/${kbId}/folders`)
  const folder = folders.find(candidate => normalizeFolderPath(candidate.path) === normalized)
  if (folder === undefined) {
    throw new Error(`知识库文件夹不存在: ${normalized}`)
  }
  return folder.id
}

/** folderId → path 的索引(文档列表结果回填 folderPath 展示用)。 */
function folderPathById(folders: readonly KbFolderDto[]): Map<string, string> {
  return new Map(folders.map(folder => [folder.id, folder.path]))
}

/**
 * 注册代理路由与 kb_search / kb_read / kb_list 工具。
 *
 * <p>登录身份(`currentUser` 服务)不在 inject 中,经 `ctx.get` 无注入要求读取
 * (直接访问 `ctx.currentUser` 在 cordis 下会抛 "without inject"):enterprise
 * profile 下 JWT 优先;backend profile 无该服务,读取为 undefined,工具调用回退
 * {@code config.serviceKey}(路径重写为服务身份白名单端点,见 resolveAuth)。
 * webConsoleBaseUrl 为 volatile 配置:每次请求读取当前值,设置面板修改后
 * 无需重载即生效(值无效时该次请求报错,不阻断后续);readMaxChars 必须为
 * 正有限数。工具经 {@code ctx.tools.register} 注册,随调用方 fiber 生命周期
 * 自动反注册。
 *
 * @param ctx - 携带 `webServer` / `tools` 的 Cordis 上下文(登录身份可选)。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isFinite(config.readMaxChars) || config.readMaxChars <= 0) {
    throw new Error(`knowledge: readMaxChars 必须为正有限数(当前 ${config.readMaxChars})`)
  }
  const options: KnowledgeOptions = {
    webConsoleBaseUrl: () => config.webConsoleBaseUrl.get(),
    readMaxChars: config.readMaxChars,
    // 每次调用实时读取:apply 时该服务可能尚未激活,捕获快照会错过;服务缺席
    // (backend profile)返回 undefined 回退服务密钥。
    token: () => ctx.get('currentUser')?.getToken(),
    serviceKey: () => config.serviceKey,
  }
  for (const { local, upstream } of PROXY_ROUTES) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: local,
          // 转发器由 @deepseek-ai/dsh-web-console-proxy 共享;baseUrl/token 与
          // 工具面同源,volatile 基地址与登录态每次转发实时读取。
          handler: (req, res) =>
            proxyRequest(
              {
                baseUrl: options.webConsoleBaseUrl,
                token: options.token,
                unauthorizedMessage: '未登录,无法访问企业知识库',
              },
              local,
              upstream,
              req,
              res,
            ),
        }),
      `knowledge: ${local} prefix route`,
    )
  }

  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: 'Hybrid search over the enterprise knowledge base: vector similarity, keyword (trigram) and '
      + 'full-text (jieba) candidates fused with Reciprocal Rank Fusion into document-level hits, so paraphrased '
      + 'queries also match. Keep the query short: distill the information need into 2-4 core keywords (the '
      + 'keyword and full-text routes match contiguous substrings or whole tokens only, so long sentences miss '
      + 'there); split a broad need into several focused searches instead of one long sentence. Documents still '
      + 'being parsed (OCR/extraction) are never returned; get the kbId from '
      + 'the session context or the injected document list, then read full text of a hit with kb_read(docId).',
    parameters: {
      kbId: { type: 'string', required: true, description: 'Knowledge base id (kbId).' },
      query: { type: 'string', required: true, description: 'Query text: prefer 2-4 distilled core keywords over verbatim long sentences; run multiple focused searches if needed.' },
      folderPath: { type: 'string', description: 'Optional folder path (e.g. /finance/reimburse) scoping the search; omit for the whole knowledge base.' },
      topK: { type: 'integer', description: `Maximum number of results (default ${DEFAULT_TOP_K}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                docId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                folderPath: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.results.length === 0
            ? '知识库检索:无命中。'
            : `知识库检索 ${value.results.length} 条命中:\n${
              value.results
                .map(r => `- ${r.name} (docId: ${r.docId}, 路径: ${r.folderPath}, 相关度: ${r.score.toFixed(4)})${r.snippet === '' ? '' : `\n  摘要: ${r.snippet}`}`)
                .join('\n')
            }`,
        },
      ],
    },
    async execute(args) {
      // folderPath 缺省按根路径解析:resolveFolder 对 '/' 直接返回 undefined(不发请求)。
      const folderId = await resolveFolder(options, args.kbId, args.folderPath ?? '/')
      const params = new URLSearchParams({ query: args.query })
      if (folderId !== undefined) {
        params.set('folderId', folderId)
      }
      if (args.topK !== undefined) {
        params.set('topK', String(args.topK))
      }
      const [hits, folders] = await Promise.all([
        requestJson<KbSearchHit[]>(options, `/api/kb/${args.kbId}/search?${params}`),
        requestJson<KbFolderDto[]>(options, `/api/kb/${args.kbId}/folders`),
      ])
      const pathById = folderPathById(folders)
      return {
        results: hits.map(hit => ({
          docId: hit.docId,
          name: hit.docName,
          folderPath: hit.folderId === null ? '/' : (pathById.get(hit.folderId) ?? '/'),
          snippet: hit.snippet,
          score: hit.score,
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: '知识库检索', kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_read',
    description: 'Read the extracted full text of one knowledge base document by its docId (returned by kb_search '
      + 'or the injected document list). The result also carries the owning knowledge base id (kbId), '
      + 'which kb_search and kb_list take as their kbId argument. '
      + 'Text longer than the configured limit is truncated and flagged.',
    parameters: {
      docId: { type: 'string', required: true, description: 'Document id (docId).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          kbId: { type: 'string', required: true },
          parseStatus: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          // 全文必须进 render:模型可见 ⟺ 已记录,模型只能看到 render 输出。
          // kbId 也进 render:模型从 docId 反查知识库、衔接 kb_search/kb_list 的唯一来源。
          text: value.parseStatus !== 'ready'
            ? `文档「${value.name}」解析状态:${value.parseStatus},暂无全文。(所属知识库 kbId: ${value.kbId})`
            : value.truncated
              ? `知识库文档「${value.name}」全文(超出上限,已截断为前 ${value.text.length} 字符):\n\n${value.text}\n\n(所属知识库 kbId: ${value.kbId})`
              : `知识库文档「${value.name}」全文:\n\n${value.text}\n\n(所属知识库 kbId: ${value.kbId})`,
        },
      ],
    },
    async execute(args) {
      const doc = await requestJson<KbDocumentTextDto>(options, `/api/kb/documents/${args.docId}/text`)
      if (doc.parseStatus !== 'ready') {
        return { name: doc.name, kbId: doc.kbId, parseStatus: doc.parseStatus, text: '', truncated: false }
      }
      const full = doc.textContent ?? ''
      if (full.length <= options.readMaxChars) {
        return { name: doc.name, kbId: doc.kbId, parseStatus: doc.parseStatus, text: full, truncated: false }
      }
      return { name: doc.name, kbId: doc.kbId, parseStatus: doc.parseStatus, text: full.slice(0, options.readMaxChars), truncated: true }
    },
    presentCall: args => ({ card: 'generic', title: '读取知识库文档', kind: 'read', rawInput: args.docId }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_list',
    description: 'List folders and documents of one knowledge base (whole tree by default, or the subtree under a '
      + 'folder path) to browse what is available before searching or reading. Documents still parsing show their status.',
    parameters: {
      kbId: { type: 'string', required: true, description: 'Knowledge base id (kbId).' },
      folderPath: { type: 'string', description: 'Optional folder path (e.g. /finance) whose subtree is listed; omit for the whole knowledge base.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          folders: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
              },
            },
          },
          documents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                docId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                folderPath: { type: 'string', required: true },
                sizeBytes: { type: 'integer', required: true },
                parseStatus: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `知识库清单:${value.folders.length} 个文件夹,${value.documents.length} 个文档。`,
            ...value.folders.map(f => `- [目录] ${f.path}`),
            ...value.documents.map(d => `- ${d.name} (docId: ${d.docId}, 路径: ${d.folderPath}, 解析: ${d.parseStatus})`),
          ].join('\n'),
        },
      ],
    },
    async execute(args) {
      // folderPath 缺省按根路径解析:resolveFolder 对 '/' 直接返回 undefined(不发请求)。
      const folderId = await resolveFolder(options, args.kbId, args.folderPath ?? '/')
      const params = new URLSearchParams({ recursive: 'true' })
      if (folderId !== undefined) {
        params.set('folderId', folderId)
      }
      const [folders, docs] = await Promise.all([
        requestJson<KbFolderDto[]>(options, `/api/kb/${args.kbId}/folders`),
        requestJson<KbDocumentDto[]>(options, `/api/kb/${args.kbId}/documents?${params}`),
      ])
      const normalized = args.folderPath === undefined ? '/' : normalizeFolderPath(args.folderPath)
      const scopedFolders = normalized === '/'
        ? folders
        : folders.filter(
          folder => folder.path === normalized || folder.path.startsWith(`${normalized}/`),
        )
      const pathById = folderPathById(folders)
      return {
        folders: scopedFolders.map(folder => ({ name: folder.name, path: folder.path })),
        documents: docs.map(doc => ({
          docId: doc.id,
          name: doc.name,
          folderPath: doc.folderId === null ? '/' : (pathById.get(doc.folderId) ?? '/'),
          sizeBytes: doc.sizeBytes,
          parseStatus: doc.parseStatus,
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: '浏览知识库清单', kind: 'other', rawInput: args.folderPath ?? args.kbId }),
  }))
}
