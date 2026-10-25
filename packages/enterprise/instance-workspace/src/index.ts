/**
 * Model-facing tools over the process-instance cloud workspace (design
 * docs/plans/2026-10-14-instance-workspace-design.md §5.1/§6.2): every node
 * of a flow instance — employee todo sessions, DSH backend tasks, engine
 * delegates — shares one cloud file space served by web-console.
 *
 * Two auth modes resolved per call (see {@link resolveAuth}):
 *
 * 1. Employee face (enterprise profile, login identity present): tools and the
 *    local prefix proxy `/api/enterprise/workspace` both go through the shared
 *    web-console-proxy forwarder to web-console `/api/workspace/*` with the
 *    signed-in employee's JWT (membership checked by web-console). The plugin
 *    also owns the session-context report route (session → processInstanceId),
 *    the pull-to-local route (the browser cannot write the local disk; Node
 *    pulls cloud contents into the session cwd), and the per-turn pre-step
 *    injection of the `<instance_workspace>` block.
 *
 * 2. Service-key face (backend profile, no login identity): tools are written
 *    against the employee-face paths and resolveAuth rewrites them to the
 *    service-key allowlist endpoints `/api/backend/instances/*` with the
 *    configured `X-Service-Key` header (same shape as the knowledge plugin).
 *
 * Tool calls and results go through the normal registry pipeline, which logs
 * them as session events (model-visible ⟺ logged).
 *
 * Tool visibility is governed by `config.toolMount`: `global` registers the
 * six workspace_* tools on the root registry (backend profile; every session
 * sees them), `boundSessions` injects them per agent into the agent-scoped
 * registry only after that session reports its process-instance binding via
 * the session-context route (enterprise employee face; unbound conversations
 * carry no workspace tools).
 *
 * @module @deepseek-ai/dsh-instance-workspace
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, resolve } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { proxyRequest, validateBaseUrl } from '@deepseek-ai/dsh-web-console-proxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-user-identity-context'

import { INSTANCE_WORKSPACE_SECTION, renderInstanceWorkspaceContextText } from './text.ts'
export { INSTANCE_WORKSPACE_SECTION, renderInstanceWorkspaceContextText } from './text.ts'
export type { InstanceWorkspaceBlockData } from './text.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'instance-workspace'

/** Service Definition:webserver(前缀代理与上报路由)、工具注册表、pre-step 事件。 */
export const inject = ['webServer', 'tools', 'agents']

/** 前缀代理路由:本地前缀 → web-console 员工面前缀 `/api/workspace`(浏览器侧栏与 Node 侧工具共用)。 */
const WORKSPACE_PROXY_ROUTE = '/api/enterprise/workspace'

/** 会话绑定上报端点(exact 路由;优先于同前缀的代理路由,照 kb-context 惯例)。 */
const SESSION_CONTEXT_ROUTE = '/api/enterprise/workspace/session-context'

/** 拉取到本地端点(exact 路由):浏览器无法写本地磁盘,员工端经本端点让 Node 侧
 * 把实例空间文件内容拉到会话工作目录内的落盘路径(下载目标或预览缓存)。 */
const PULL_ROUTE = '/api/enterprise/workspace/pull'

/** workspace_read 返回内容上限默认值(字节;超出截断并注明)。 */
const DEFAULT_READ_MAX_BYTES = 256 * 1024

/** workspace_upload 本地文件读取上限默认值(字节;与 web-console max-file-mb 默认 64MB 对齐)。 */
const DEFAULT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024

/** 插件配置,全部来自 backend profile 的 cordis.yml config 段。 */
export interface Config {
  /** web-console 基地址(协议+主机+端口,无路径);volatile:设置面板可改,即时生效。 */
  webConsoleBaseUrl: Volatile<string>
  /** workspace_read 返回内容上限(字节),超出截断并在结果中注明。 */
  readMaxBytes: number
  /** workspace_upload 本地文件读取上限(字节),超限拒绝上传。 */
  uploadMaxBytes: number
  /**
   * 服务密钥(X-Service-Key):backend profile 无人值守模式的 web-console 认证
   * 凭证,须与 web-console {@code dsh.service-key} 一致;enterprise profile 有
   * 登录身份,JWT 优先,此项保持空串。两者皆无时工具调用报错。
   */
  serviceKey: string
  /** 覆盖本地落盘根(workspace_upload/workspace_download);缺省用进程工作目录。 */
  localRoot?: string
  /**
   * 工具挂载模式,必填(错配 fail loud):`global` 把六个 workspace_* 工具
   * 注册在根工具注册表(backend profile,所有会话可见,行为与历史版本一致);
   * `boundSessions` 不全局注册,仅在会话经 session-context 路由上报流程实例
   * 绑定后,向该会话 agent 的 scoped 注册表逐个注入(enterprise 员工端,
   * 未绑定实例的会话模型工具目录里没有 workspace_*)。
   */
  toolMount: 'global' | 'boundSessions'
}

export const Config = z.object({
  webConsoleBaseUrl: z.string().required().volatile(),
  readMaxBytes: z.number().default(DEFAULT_READ_MAX_BYTES),
  uploadMaxBytes: z.number().default(DEFAULT_UPLOAD_MAX_BYTES),
  serviceKey: z.string().default(''),
  localRoot: z.string(),
  // schemastery 无 enum 构造器:'global' | 'boundSessions' 的白名单校验在 apply 开头 fail loud。
  toolMount: z.string().required(),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Instance cloud-workspace tooling attribution; readers preserve the content without this producer.
     * @persistenceAttribution
     */
    'instance-workspace': { kind: 'instance-workspace' } & ContextFormed
  }
}

/**
 * 已解析的运行选项(apply 阶段完成校验与默认值合并)。
 *
 * <p>取值函数注入而非内联,便于测试桩替换 volatile 基地址、登录态与本地
 * 落盘根。
 */
export interface InstanceWorkspaceOptions {
  /** 当前 web-console 基地址(无尾斜杠;每次调用读取 volatile 最新值)。 */
  readonly webConsoleBaseUrl: () => string
  /** workspace_read 返回内容上限(字节)。 */
  readonly readMaxBytes: number
  /** workspace_upload 本地文件读取上限(字节)。 */
  readonly uploadMaxBytes: number
  /** 当前登录员工的 JWT;未登录(backend profile)为 undefined。 */
  readonly token: () => string | undefined
  /** 服务密钥。 */
  readonly serviceKey: () => string
  /** 本地 webserver 监听端口(JWT 模式的工具请求经环回地址转发)。 */
  readonly localPort: () => number
  /** 本地落盘根(workspace_upload/workspace_download 的回退根;会话工作目录优先)。 */
  readonly cwd: () => string
}

/** web-console {@code ApiResponse} 信封(成功时 data 必有值)。 */
interface ApiEnvelope<T> {
  success?: boolean
  data?: T
  error?: { message?: string }
}

/** web-console {@code InstanceWorkspaceFileDto}(工具消费字段)。 */
interface WorkspaceFileDto {
  relPath: string
  sizeBytes: number
  contentType: string | null
  uploadedByLabel: string | null
  sourceTaskId: string | null
  createdAt: string
  updatedAt: string
  diskMissing: boolean
}

/**
 * 解析一次调用的认证方式、上游基地址与工具路径前缀。
 *
 * <p>登录 JWT 优先(enterprise profile):工具请求走本地 webserver 前缀代理
 * `/api/enterprise/workspace/*`,由共享转发器附 JWT 转发到 web-console
 * `/api/workspace/*`(成员校验在上游);未登录回退服务密钥(backend profile
 * 无人值守,直连 web-console,路径重写为 `/api/backend/instances/*` 白名单
 * 端点);两者皆无时抛错(错误消息面向模型呈现)。
 */
function resolveAuth(options: InstanceWorkspaceOptions): {
  /** 上游基地址;JWT 模式为本地 webserver 环回地址。 */
  base: string
  headers: Record<string, string>
  /** 工具路径重写目标前缀。 */
  pathPrefix: '/api/enterprise/workspace/instances' | '/api/backend/instances'
} {
  const token = options.token()
  if (token !== undefined) {
    return {
      base: `http://127.0.0.1:${options.localPort()}`,
      headers: {},
      pathPrefix: '/api/enterprise/workspace/instances',
    }
  }
  const serviceKey = options.serviceKey()
  if (serviceKey !== '') {
    return { base: baseUrlOf(options), headers: { 'x-service-key': serviceKey }, pathPrefix: '/api/backend/instances' }
  }
  throw new Error('未登录且未配置服务密钥,无法访问实例云工作空间')
}

/** 工具侧书写的员工面路径重写为当前认证模式的前缀。 */
function rewritePath(auth: { pathPrefix: string }, path: string): string {
  return path.startsWith('/api/workspace/instances/')
    ? `${auth.pathPrefix}${path.slice('/api/workspace/instances'.length)}`
    : path
}

/** relPath 逐段 URL 编码(中文/空格安全;`/` 保留为分隔符)。 */
function encodeRelPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/')
}

/** 读取当前 volatile 基地址(去尾斜杠),无效时抛错(错误消息面向模型呈现)。 */
function baseUrlOf(options: InstanceWorkspaceOptions): string {
  const webConsoleBaseUrl = options.webConsoleBaseUrl().replace(/\/+$/, '')
  if (validateBaseUrl(webConsoleBaseUrl) !== undefined) {
    throw new Error(`instance-workspace: webConsoleBaseUrl 配置无效: ${webConsoleBaseUrl}`)
  }
  return webConsoleBaseUrl
}

/** 解 {@code ApiResponse} 信封;失败时透出上游错误消息。 */
async function parseEnvelope<T>(resp: Response): Promise<T> {
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
    throw new Error(`web-console 实例空间请求失败(HTTP ${resp.status}): ${body.error?.message ?? '未知错误'}`)
  }
  return body.data
}

/** {@link fetchUpstream} 的初始化参数;headers 只收 plain record(本包调用方均为 JSON 请求,用不到 HeadersInit 的数组形态)。 */
interface UpstreamInit {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
}

/** fetch 包装:网络失败统一转为面向模型的可读错误。 */
async function fetchUpstream(options: InstanceWorkspaceOptions, path: string, init: UpstreamInit): Promise<Response> {
  const auth = resolveAuth(options)
  try {
    return await fetch(new URL(rewritePath(auth, path), auth.base), { ...init, headers: { ...auth.headers, ...init.headers } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`web-console 不可达(${auth.base}): ${message}`)
  }
}

/**
 * 调 web-console 实例空间 REST 并解 {@code ApiResponse} 信封。
 *
 * @param options - 运行选项
 * @param path - 以 /api/workspace/instances/ 开头的员工面路径(不含 base)
 * @returns 信封 data
 * @throws Error 未登录且未配置服务密钥 / 基地址无效 / 网络不可达 / 响应非 JSON / 信封失败
 */
async function requestJson<T>(options: InstanceWorkspaceOptions, path: string): Promise<T> {
  const resp = await fetchUpstream(options, path, { method: 'GET' })
  return parseEnvelope<T>(resp)
}

/** POST JSON 体并解信封(写文本文件端点)。 */
async function requestPostJson<T>(options: InstanceWorkspaceOptions, path: string, body: unknown): Promise<T> {
  const resp = await fetchUpstream(options, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseEnvelope<T>(resp)
}

/** POST multipart 表单并解信封(上传端点;fetch 为 FormData 自动补 content-type 边界)。 */
async function requestUpload<T>(options: InstanceWorkspaceOptions, path: string, form: FormData): Promise<T> {
  const resp = await fetchUpstream(options, path, { method: 'POST', body: form })
  return parseEnvelope<T>(resp)
}

/** DELETE 并解信封(删除端点;ApiResponse.ok(null) 的 data 为 null,视为成功)。 */
async function requestDelete(options: InstanceWorkspaceOptions, path: string): Promise<void> {
  const resp = await fetchUpstream(options, path, { method: 'DELETE' })
  await parseEnvelope<null>(resp)
}

/**
 * 下载端点返回原始字节流(非信封);失败响应尝试透出上游错误摘要。
 */
async function requestBytes(
  options: InstanceWorkspaceOptions,
  path: string,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const resp = await fetchUpstream(options, path, { method: 'GET' })
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300)
    throw new Error(`web-console 实例空间请求失败(HTTP ${resp.status}): ${detail || '未知错误'}`)
  }
  return { bytes: Buffer.from(await resp.arrayBuffer()), contentType: resp.headers.get('content-type') }
}

/**
 * 校验工具入参可安全落为本地落盘根下的相对路径:拒绝空串、绝对路径、
 * 盘符、反斜杠与空/`.`/`..` 段,防止越出本地工作区。
 */
function assertLocalRelative(relPath: string): string {
  if (relPath === '' || relPath.startsWith('/') || relPath.includes('\\') || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`非法相对路径: ${relPath}`)
  }
  if (relPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`非法相对路径: ${relPath}`)
  }
  return relPath
}

/** session-context 上报路由的 JSON 应答辅助函数。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/** 读取并缓冲整个请求体(session-context 上报是有限 JSON 体)。 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * workspace_upload / workspace_download 的本地落盘根:绑定会话的工作目录
 * 优先(员工端待办会话),未绑定或无会话上下文时回退配置根。
 */
function localBaseDir(options: InstanceWorkspaceOptions, exec: ToolRunContext): string {
  return exec.agent?.session.header.cwd ?? options.cwd()
}

/**
 * 注册代理路由、session-context 上报路由、每回合注入监听与六个 workspace_* 工具
 * (挂载时机由 {@link Config.toolMount} 决定)。
 *
 * <p>登录身份(`currentUser` 服务)不在 inject 中,经 `ctx.get` 无注入要求读取
 * (直接访问 `ctx.currentUser` 在 cordis 下会抛 "without inject"):enterprise
 * profile 下 JWT 优先(工具请求与浏览器代理都经本地前缀路由转发),backend
 * profile 无该服务,读取为 undefined,工具调用回退 {@code config.serviceKey}
 * (路径重写为服务身份白名单端点,见 {@link resolveAuth})。webConsoleBaseUrl
 * 为 volatile 配置:每次调用读取当前值,设置面板修改后无需重载即生效;
 * readMaxBytes / uploadMaxBytes 必须为正有限数。
 *
 * <p>伪造 session-context 上报无法越权:无绑定的会话只是拿不到注入提示与
 * boundSessions 工具注入,工具调用始终由 web-console 按登录身份(成员校验)或
 * 服务密钥(白名单端点)把关,注入块里也没有任何凭证。
 *
 * @param ctx - 携带 `webServer`、`tools`、`agents` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [['readMaxBytes', config.readMaxBytes], ['uploadMaxBytes', config.uploadMaxBytes]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`instance-workspace: ${field} 必须为正有限数(当前 ${String(value)})`)
    }
  }
  // zod 侧 toolMount 仅是 string(schemastery 无 enum):白名单校验必须在运行时
  // 保留,经 string 宽类型比较,避免 TS 收窄把它判成字面量自比较。
  const toolMount: string = config.toolMount
  if (toolMount !== 'global' && toolMount !== 'boundSessions') {
    throw new Error(`instance-workspace: toolMount 必须是 'global' 或 'boundSessions'(当前 ${toolMount})`)
  }
  const options: InstanceWorkspaceOptions = {
    webConsoleBaseUrl: () => config.webConsoleBaseUrl.get(),
    readMaxBytes: config.readMaxBytes,
    uploadMaxBytes: config.uploadMaxBytes,
    // 每次调用实时读取:apply 时该服务可能尚未激活,捕获快照会错过;服务缺席
    // (backend profile)返回 undefined 回退服务密钥。
    token: () => ctx.get('currentUser')?.getToken(),
    serviceKey: () => config.serviceKey,
    localPort: () => {
      // 端口未绑定(服务未就绪)是时序问题,fail loud 而非静默指向错误地址。
      const port = ctx.webServer.port
      if (port === undefined) throw new Error('instance-workspace: webserver 端口不可用，无法构造本地回环地址')
      return port
    },
    cwd: () => config.localRoot !== undefined && config.localRoot !== '' ? config.localRoot : process.cwd(),
  }

  /** sessionId → processInstanceId(幂等登记,重复上报覆盖);webserver 重启后
   * 由客户端下一次上报自愈。 */
  const sessionWorkspaces = new Map<string, string>()

  /** 六个 workspace_* 工具定义;挂载时机由 {@link Config.toolMount} 决定(见
   * apply 末尾的 global 注册分支与 boundSessions 注入器)。 */
  const workspaceTools: ToolDefinition[] = []

  /** 已注入 workspace_* 工具的 agent(boundSessions 模式幂等去重;agent 与其
   * scoped 注册表同生命周期,WeakSet 不延长其存活)。 */
  const injectedAgents = new WeakSet<Agent>()

  /**
   * 向单个 agent 注入 workspace_* 工具(boundSessions 模式):仅当该会话已上报
   * 流程实例绑定时,向 agent 的 scoped 注册表逐个注册;global 模式下工具常驻根
   * 注册表,直接跳过。WeakSet 幂等,重复调用(POST 主路径与 agent/created 兜底
   * 监听双入口)只注册一次。
   */
  const injectIntoAgent = (agent: Agent): void => {
    if (config.toolMount !== 'boundSessions' || injectedAgents.has(agent)) return
    if (sessionWorkspaces.get(agent.session.id) === undefined) return
    injectedAgents.add(agent)
    for (const tool of workspaceTools) agent.ctx.tools.register(tool)
  }

  // boundSessions 兜底时序:会话绑定上报早于 agent 创建时,POST 主路径解析不到
  // agent,由创建事件补注入;agent/created 为 serial 事件,root 监听听全部 agent。
  if (config.toolMount === 'boundSessions') {
    ctx.on('agent/created', ({ agent }) => { injectIntoAgent(agent) })
  }

  // 浏览器侧栏与员工端工具共用的前缀代理:转发器由 @deepseek-ai/dsh-web-console-proxy
  // 共享;baseUrl/token 与工具面同源,volatile 基地址与登录态每次转发实时读取。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: WORKSPACE_PROXY_ROUTE,
        handler: (req, res) =>
          proxyRequest(
            {
              baseUrl: options.webConsoleBaseUrl,
              token: options.token,
              unauthorizedMessage: '未登录,无法访问实例云工作空间',
            },
            WORKSPACE_PROXY_ROUTE,
            '/api/workspace',
            req,
            res,
          ),
      }),
    `instance-workspace: ${WORKSPACE_PROXY_ROUTE} prefix route`,
  )

  // 会话绑定上报(exact 路由,优先于同前缀的代理路由):员工端 createTaskSession
  // 成功后 POST { sessionId, processInstanceId },幂等登记。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SESSION_CONTEXT_ROUTE,
        handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          if (options.token() === undefined) {
            sendJson(res, 401, { error: '未登录,无法上报会话实例绑定' })
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse((await readBody(req)).toString('utf8')) as unknown
          } catch {
            sendJson(res, 400, { error: '请求体不是 JSON' })
            return
          }
          const sessionId = (parsed as { sessionId?: unknown } | null)?.sessionId
          const processInstanceId = (parsed as { processInstanceId?: unknown } | null)?.processInstanceId
          if (typeof sessionId !== 'string' || sessionId === '') {
            sendJson(res, 400, { error: 'sessionId 必须是非空字符串' })
            return
          }
          if (typeof processInstanceId !== 'string' || processInstanceId === '') {
            sendJson(res, 400, { error: 'processInstanceId 必须是非空字符串' })
            return
          }
          sessionWorkspaces.set(sessionId, processInstanceId)
          // boundSessions 模式主路径:agent 已存在时立即注入(早于创建时由
          // agent/created 兜底监听补上);global 模式下此调用为跳过。
          const agent = ctx.agents.get(brandString<SessionId>(sessionId))
          if (agent !== undefined) injectIntoAgent(agent)
          res.writeHead(204)
          res.end()
        },
      }),
    `instance-workspace: ${SESSION_CONTEXT_ROUTE} session report route`,
  )

  // 拉取到本地(exact 路由):员工端 UI 的「下载到本地/预览」无法直接写浏览器
  // 磁盘,经本端点让 Node 侧代理拉取 web-console 内容并落会话 cwd 内的安全相对
  // 路径。target 'cwd' 写目标 relPath(已存在且未 overwrite 时 409,由客户端
  // 二次确认后重发);target 'cache' 写预览缓存 .dsh/instance-workspace-cache/
  // {instanceId}/relPath(始终覆盖)。cwd 按 sessionId 从 agents 服务解析,解析
  // 不到 fail loud(400):静默回退进程 cwd 会把文件散落到错误位置。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PULL_ROUTE,
        handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          if (options.token() === undefined) {
            sendJson(res, 401, { error: '未登录,无法拉取实例空间文件' })
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse((await readBody(req)).toString('utf8')) as unknown
          } catch {
            sendJson(res, 400, { error: '请求体不是 JSON' })
            return
          }
          const body = parsed as {
            sessionId?: unknown
            instanceId?: unknown
            relPath?: unknown
            target?: unknown
            overwrite?: unknown
          } | null
          const sessionId = body?.sessionId
          const instanceId = body?.instanceId
          if (typeof sessionId !== 'string' || sessionId === '' || typeof instanceId !== 'string' || instanceId === '') {
            sendJson(res, 400, { error: 'sessionId 与 instanceId 必须是非空字符串' })
            return
          }
          const target = body?.target
          if (target !== 'cwd' && target !== 'cache') {
            sendJson(res, 400, { error: "target 必须是 'cwd' 或 'cache'" })
            return
          }
          let safeRelPath: string
          try {
            safeRelPath = assertLocalRelative(typeof body?.relPath === 'string' ? body.relPath : '')
          } catch {
            sendJson(res, 400, { error: 'relPath 必须是安全的相对路径(不得含 ..、绝对路径或反斜杠)' })
            return
          }
          const cwd = ctx.agents.get(brandString<SessionId>(sessionId))?.session.header.cwd
          if (cwd === undefined) {
            sendJson(res, 400, { error: `无法解析会话工作目录(会话不存在或未启动): ${sessionId}` })
            return
          }
          const absolute = target === 'cwd'
            ? resolve(cwd, safeRelPath)
            : resolve(cwd, '.dsh', 'instance-workspace-cache', instanceId, safeRelPath)
          if (target === 'cwd' && body?.overwrite !== true) {
            const existing = await stat(absolute).catch(() => undefined)
            if (existing !== undefined) {
              sendJson(res, 409, { existed: true })
              return
            }
          }
          const { bytes } = await requestBytes(
            options,
            `/api/workspace/instances/${encodeURIComponent(instanceId)}/files/content/${encodeRelPath(safeRelPath)}`,
          )
          if (bytes.length > options.uploadMaxBytes) {
            sendJson(res, 413, { error: `文件大小 ${bytes.length} 字节超过拉取上限 ${options.uploadMaxBytes} 字节` })
            return
          }
          await mkdir(dirname(absolute), { recursive: true })
          await writeFile(absolute, bytes)
          sendJson(res, 200, { localPath: absolute })
        },
      }),
    `instance-workspace: ${PULL_ROUTE} pull route`,
  )

  // 每回合 step 1 向绑定会话追加 <instance_workspace> 提示块;未绑定、未登录
  // 或非首轮不注入。
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1) return decision
    const processInstanceId = sessionWorkspaces.get(agent.session.id)
    if (processInstanceId === undefined || processInstanceId === '') return decision
    if (options.token() === undefined) return decision
    const text = renderInstanceWorkspaceContextText({ processInstanceId, taskId: null })
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'instance-workspace',
            form: 'snapshot',
            sections: [{ name: INSTANCE_WORKSPACE_SECTION, text }],
          },
        }),
      ],
    }
  }, { prepend: true })

  workspaceTools.push(defineTool({
    name: 'workspace_list',
    description: 'List all files of one process-instance cloud workspace (shared in real time by every node '
      + 'of the flow instance). Get the instanceId from the injected instance-workspace context.',
    parameters: {
      instanceId: { type: 'string', required: true, description: 'Process instance id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                relPath: { type: 'string', required: true },
                sizeBytes: { type: 'integer', required: true },
                diskMissing: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.files.length === 0
            ? '实例空间:暂无文件。'
            : `实例空间 ${value.files.length} 个文件:\n${
              value.files
                .map(f => `- ${f.relPath} (${f.sizeBytes} 字节)${f.diskMissing ? ' [磁盘缺失]' : ''}`)
                .join('\n')
            }`,
        },
      ],
    },
    async execute(args) {
      const files = await requestJson<WorkspaceFileDto[]>(
        options,
        `/api/workspace/instances/${encodeURIComponent(args.instanceId)}/files`,
      )
      return {
        files: files.map(file => ({
          relPath: file.relPath,
          sizeBytes: file.sizeBytes,
          diskMissing: file.diskMissing,
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: '列出实例空间文件', kind: 'other', rawInput: args.instanceId }),
  }))

  workspaceTools.push(defineTool({
    name: 'workspace_read',
    description: 'Read one text file from the instance cloud workspace by its relPath (as returned by '
      + 'workspace_list). Content beyond the configured byte limit is truncated and flagged; use '
      + 'workspace_download when the full file is needed.',
    parameters: {
      instanceId: { type: 'string', required: true, description: 'Process instance id.' },
      path: { type: 'string', required: true, description: 'File relPath inside the instance workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          totalBytes: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          // 全文必须进 render:模型可见 ⟺ 已记录,模型只能看到 render 输出。
          text: value.truncated
            ? `实例空间文件「${value.path}」内容(共 ${value.totalBytes} 字节,超出上限已截断为前 ${options.readMaxBytes} 字节):\n\n${value.content}\n\n(内容已截断;完整文件请用 workspace_download)`
            : `实例空间文件「${value.path}」内容(${value.totalBytes} 字节):\n\n${value.content}`,
        },
      ],
    },
    async execute(args) {
      const { bytes } = await requestBytes(
        options,
        `/api/workspace/instances/${encodeURIComponent(args.instanceId)}/files/content/${encodeRelPath(args.path)}`,
      )
      const truncated = bytes.length > options.readMaxBytes
      const content = new TextDecoder('utf-8').decode(truncated ? bytes.subarray(0, options.readMaxBytes) : bytes)
      return { path: args.path, totalBytes: bytes.length, truncated, content }
    },
    presentCall: args => ({ card: 'generic', title: '读取实例空间文件', kind: 'read', rawInput: args.path }),
  }))

  workspaceTools.push(defineTool({
    name: 'workspace_write',
    description: 'Write or overwrite one UTF-8 text file in the instance cloud workspace; an existing file at '
      + 'the same relPath is replaced. Pass the taskId from the injected context so the write is attributed to '
      + 'the current node.',
    parameters: {
      instanceId: { type: 'string', required: true, description: 'Process instance id.' },
      path: { type: 'string', required: true, description: 'Target relPath inside the instance workspace.' },
      content: { type: 'string', required: true, description: 'UTF-8 text content (empty string writes a 0-byte file).' },
      taskId: { type: 'string', description: 'Current node id from the injected context; recorded as the source task.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relPath: { type: 'string', required: true },
          sizeBytes: { type: 'integer', required: true },
          sourceTaskId: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已写入实例空间文件「${value.relPath}」(${value.sizeBytes} 字节${value.sourceTaskId !== undefined ? `,来源节点 ${value.sourceTaskId}` : ''})。`,
        },
      ],
    },
    async execute(args) {
      const dto = await requestPostJson<WorkspaceFileDto>(
        options,
        `/api/workspace/instances/${encodeURIComponent(args.instanceId)}/files/text`,
        { path: args.path, content: args.content, sourceTaskId: args.taskId ?? null },
      )
      return {
        relPath: dto.relPath,
        sizeBytes: dto.sizeBytes,
        ...(dto.sourceTaskId === null ? {} : { sourceTaskId: dto.sourceTaskId }),
      }
    },
    presentCall: args => ({ card: 'generic', title: '写入实例空间文件', kind: 'other', rawInput: args.path }),
  }))

  workspaceTools.push(defineTool({
    name: 'workspace_upload',
    description: 'Upload a local file into the instance cloud workspace. localPath resolves against the session '
      + 'working directory; path is the target cloud relPath (an existing file there is replaced). Pass the '
      + 'taskId from the injected context so the upload is attributed to the current node.',
    parameters: {
      instanceId: { type: 'string', required: true, description: 'Process instance id.' },
      localPath: { type: 'string', required: true, description: 'Local file path, relative to the session working directory.' },
      path: { type: 'string', required: true, description: 'Target relPath inside the instance workspace.' },
      taskId: { type: 'string', description: 'Current node id from the injected context; recorded as the source task.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relPath: { type: 'string', required: true },
          sizeBytes: { type: 'integer', required: true },
          sourceTaskId: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已上传本地文件到实例空间「${value.relPath}」(${value.sizeBytes} 字节${value.sourceTaskId !== undefined ? `,来源节点 ${value.sourceTaskId}` : ''})。`,
        },
      ],
    },
    async execute(args, exec) {
      const absolute = resolve(localBaseDir(options, exec), assertLocalRelative(args.localPath))
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        throw new Error(`本地文件不存在: ${absolute}`)
      }
      if (info.size > options.uploadMaxBytes) {
        throw new Error(`本地文件超过上传上限: ${info.size} > ${options.uploadMaxBytes} 字节`)
      }
      const form = new FormData()
      form.append('path', args.path)
      form.append('file', new Blob([await readFile(absolute)]), basename(args.path))
      const dto = await requestUpload<WorkspaceFileDto>(
        options,
        `/api/workspace/instances/${encodeURIComponent(args.instanceId)}/files`,
        form,
      )
      return {
        relPath: dto.relPath,
        sizeBytes: dto.sizeBytes,
        ...(dto.sourceTaskId === null ? {} : { sourceTaskId: dto.sourceTaskId }),
      }
    },
    presentCall: args => ({ card: 'generic', title: '上传到实例空间', kind: 'other', rawInput: args.localPath }),
  }))

  workspaceTools.push(defineTool({
    name: 'workspace_download',
    description: 'Download one instance-workspace file (by its relPath) into the session working directory at '
      + 'the same relPath. Fails when a local file of the same name already exists — pick another target via '
      + 'workspace_write semantics or delete the local file first.',
    parameters: {
      instanceId: { type: 'string', required: true, description: 'Process instance id.' },
      path: { type: 'string', required: true, description: 'File relPath inside the instance workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          absolutePath: { type: 'string', required: true },
          sizeBytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已下载实例空间文件「${value.path}」到本地工作区 ${value.absolutePath}(${value.sizeBytes} 字节)。`,
        },
      ],
    },
    async execute(args, exec) {
      const absolute = resolve(localBaseDir(options, exec), assertLocalRelative(args.path))
      const existing = await stat(absolute).catch(() => undefined)
      if (existing !== undefined) {
        throw new Error(`本地同名文件已存在,拒绝覆盖: ${absolute}。请改用其他文件名,或先删除本地文件。`)
      }
      const { bytes } = await requestBytes(
        options,
        `/api/workspace/instances/${encodeURIComponent(args.instanceId)}/files/content/${encodeRelPath(args.path)}`,
      )
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, bytes)
      return { path: args.path, absolutePath: absolute, sizeBytes: bytes.length }
    },
    presentCall: args => ({ card: 'generic', title: '下载实例空间文件', kind: 'read', rawInput: args.path }),
  }))

  workspaceTools.push(defineTool({
    name: 'workspace_delete',
    description: 'Delete one file from the instance cloud workspace (hard delete, audited). Deletion is final; '
      + 'there is no trash or versioning.',
    parameters: {
      instanceId: { type: 'string', required: true, description: 'Process instance id.' },
      path: { type: 'string', required: true, description: 'File relPath inside the instance workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已删除实例空间文件「${value.path}」。` },
      ],
    },
    async execute(args) {
      await requestDelete(
        options,
        `/api/workspace/instances/${encodeURIComponent(args.instanceId)}/files/content/${encodeRelPath(args.path)}`,
      )
      return { path: args.path }
    },
    presentCall: args => ({ card: 'generic', title: '删除实例空间文件', kind: 'other', rawInput: args.path }),
  }))

  // global 挂载:六个工具注册进根注册表(backend profile,所有会话可见,与历史
  // 版本行为一致);boundSessions 模式不在此注册,由注入器按会话绑定逐 agent 挂载。
  if (config.toolMount === 'global') {
    for (const tool of workspaceTools) ctx.tools.register(tool)
  }
}
