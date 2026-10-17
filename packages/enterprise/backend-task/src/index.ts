/**
 * Server-side unattended DSH backend task runner (design 2026-09-14 §7.1).
 *
 * The DSH backend profile mounts this plugin over dsh-base + webserver. It is
 * the automated counterpart of the employee-side user task: flowable-engine's
 * DshBackendTaskDelegate POSTs
 * `{ prompt, skillRefs, kbId?, kbName?, processInstanceId, taskId }` here
 * (kbId/kbName = the workflow's application knowledge base, resolved by the
 * delegate over the web-console service-key endpoints; absent when the
 * application has no kb or resolution degraded; processInstanceId/taskId bind
 * the task to the instance cloud workspace and the source node), each task runs in
 * its own non-interactive Agent session (one user message to quiescence, final
 * assistant text parsed as JSON), and the delegate polls the task to
 * ready/failed. Two daemons keep the instance integrated with web-console:
 * a registry heartbeat (POST /api/backend-profiles/register) and a skill sync
 * that pulls the skillRefs aggregated for this instance's URL and installs them
 * from SkillHub so task sessions find them preloaded.
 *
 * Task state is an in-process map: a restart loses running tasks and the
 * delegate retries them as failures (design §11 accepted constraint).
 *
 * @module @deepseek-ai/dsh-backend-task
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { renderInstanceWorkspaceContextText } from '@deepseek-ai/dsh-instance-workspace'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { fetchSkillhubManifest, installSkillZip, type SkillHubItem } from '@deepseek-ai/dsh-skill-sync'
import { renderKbContextText } from '@deepseek-ai/dsh-kb-context'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Empty type imports carry the loader Context merge for the settlement await.
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'backend-task'

/** 等待 webserver、Agent 注册表、会话存储、默认模型与 skill 注册表就绪后才挂载。 */
export const inject = ['webServer', 'agents', 'sessions', 'agentDefaultModel', 'skills']

/** skill 同步 daemon 默认间隔:5 分钟。 */
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000

/** 注册心跳 daemon 默认间隔:60 秒(active 判定窗口 5 分钟的三分之一冗余)。 */
const DEFAULT_REGISTER_INTERVAL_MS = 60 * 1000

/** REST 任务端点前缀(flowable delegate 的提交/轮询目标)。 */
const TASK_ROUTE_PREFIX = '/api/backend/tasks'

/** 插件配置,全部来自 enterprise-backend profile 的 cordis.yml config 段。 */
export interface Config {
  /** web-console 基地址(注册心跳与 skill 归属拉取目标)。 */
  webConsoleBaseUrl: string
  /** 本实例对外可达的调用 URL(delegate 按此提交;注册表归属键)。 */
  selfUrl: string
  /** 实例展示名(注册表/设计器下拉显示)。 */
  backendName: string
  /** SkillHub 后端 API 基地址。 */
  skillhubBaseUrl: string
  /** SkillHub 只读分发 token;空串时跳过清单/下载(仅靠已装缓存)。 */
  skillhubToken: string
  /** skill 同步 daemon 间隔毫秒。 */
  syncIntervalMs: number
  /** 注册心跳 daemon 间隔毫秒。 */
  registerIntervalMs: number
  /** 覆盖 skill 缓存目录;缺省用 `$DSH_HOME/backend-task/skills`。 */
  skillDir?: string
}

export const Config: z<Config> = z.object({
  webConsoleBaseUrl: z.string().default('http://127.0.0.1:8080'),
  selfUrl: z.string().default('http://127.0.0.1:3190'),
  backendName: z.string().default('backend-1'),
  skillhubBaseUrl: z.string().default('http://127.0.0.1:8095'),
  skillhubToken: z.string().default(''),
  syncIntervalMs: z.number().default(DEFAULT_SYNC_INTERVAL_MS),
  registerIntervalMs: z.number().default(DEFAULT_REGISTER_INTERVAL_MS),
  skillDir: z.string(),
})

/** 已解析的运行选项(apply 阶段完成校验与默认值合并)。 */
export interface BackendTaskOptions {
  readonly webConsoleBaseUrl: string
  readonly selfUrl: string
  readonly backendName: string
  readonly skillhubBaseUrl: string
  readonly skillhubToken: string
  readonly syncIntervalMs: number
  readonly registerIntervalMs: number
  readonly skillDir: string
}

/** 内存任务表的运行时状态。 */
interface BackendTaskState {
  readonly id: string
  status: 'running' | 'ready' | 'failed'
  result?: unknown
  error?: string
}

/** web-console skill 聚合端点的单条清单项(见 SkillRequirementDto)。 */
interface SkillRequirement {
  namespace: string
  slug: string
}

/** 本地 skill 安装状态:slug → 溯源(fingerprint 用于增量升级检测)。 */
interface SkillInstallState {
  skills: Record<string, { namespace: string; fingerprint: string }>
}

/** JSON 响应辅助函数。 */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/** payload 可选携带的任务知识库(2026-10 集成):kb 上下文注入与 kb_* 工具范围锚点。 */
interface BackendTaskKb {
  readonly kbId: string
  readonly kbName: string
}

/**
 * payload 必填携带的实例上下文(设计 2026-10-14 §6.1):实例空间共享注入与
 * 来源节点审计的锚点;processInstanceId 为空时提交直接 400(fail loud)。
 */
interface BackendTaskInstance {
  readonly processInstanceId: string
  readonly taskId: string | null
}

/** 读取并解析请求体 JSON;坏 JSON 抛错由调用方映射 400。 */
function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('error', reject)
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/**
 * 从 assistant 文本提取首个 `{` 到末个 `}` 之间的 JSON 对象;无花括号或
 * 解析失败返回 undefined(任务按 failed 结算,调用方重试)。
 */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return undefined
  }
}

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(session: Session, firstSeq: SessionLogOffset): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`backend-task summary cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** 会话执行依赖(agent 注册表/会话存储/默认模型),REST handler 直调。 */
interface SessionDeps {
  readonly agents: import('@deepseek-ai/dsh-agent').AgentRegistry
  readonly sessions: import('@deepseek-ai/dsh-session').SessionStore
  readonly defaultModel: import('@deepseek-ai/dsh-agent-default-model').AgentDefaultModelConfig
}

/**
 * 在独立 Agent 会话里跑一个 backend 任务并结算内存任务表。
 *
 * <p>每个任务一个新会话(单条 user message 跑到静默),skillRefs 以提示前缀
 * 注入(预装 skill 已由同步 daemon 放进工作空间,模型用 skill 工具装载);
 * kb 非 undefined 时在其上再注入 kb 上下文块(renderKbContextText,与员工端
 * kb-context 同一格式),模型据此用 kb_search / kb_list / kb_read 调用 knowledge
 * 插件的 kb_* 工具(kbId 同时是工具侧服务密钥访问的范围锚点);实例上下文
 * 必填,注入实例云工作空间块(renderInstanceWorkspaceContextText),模型据此
 * 用 instance-workspace 插件的 workspace_* 工具读写实例共享空间。结算:turn
 * 错误 / 无合法 JSON / 运行异常都置 failed,delegate 侧按重试处理;成功置
 * ready 并携带解析后的 JSON。
 */
async function runBackendTask(
  ctx: Context,
  deps: SessionDeps,
  task: BackendTaskState,
  prompt: string,
  skillRefs: readonly string[],
  kb: BackendTaskKb | undefined,
  instance: BackendTaskInstance,
): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const sections: string[] = []
  if (kb !== undefined) {
    sections.push(renderKbContextText({ kbId: kb.kbId, kbName: kb.kbName }))
  }
  if (skillRefs.length > 0) {
    sections.push(`本任务可使用以下技能(skill): ${skillRefs.join('、')}。需要时先装载对应 skill 再使用。`)
  }
  sections.push(renderInstanceWorkspaceContextText({
    processInstanceId: instance.processInstanceId,
    taskId: instance.taskId,
  }))
  sections.push(prompt)
  const promptText = sections.join('\n\n')
  const selection = deps.defaultModel.currentSelection()
  // oxlint-disable-next-line typescript/unbound-method -- called with its receiver; the rule cannot trace the interface indirection
  const { agent, dispose } = await deps.agents.create({
    sessionId: brandString<SessionId>(`backend-task-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  let outcome: RunOutcome
  try {
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: promptText }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await deps.sessions.flush(agent.session)
    outcome = summarize(agent.session, firstSeq)
  } finally {
    await dispose()
  }
  if (outcome.reason?.kind === 'error') {
    task.status = 'failed'
    task.error = `${outcome.reason.error.code}: ${outcome.reason.error.message}`
    return
  }
  if (outcome.reason !== undefined && outcome.reason.kind !== 'completed') {
    task.status = 'failed'
    task.error = `会话未正常完成(turn/end: ${outcome.reason.kind})`
    return
  }
  const result = extractJson(outcome.text)
  if (result === undefined) {
    task.status = 'failed'
    task.error = '模型输出中不含合法 JSON 对象'
    return
  }
  task.status = 'ready'
  task.result = result
}

/**
 * REST 任务端点分发。
 *
 * <p>`POST /api/backend/tasks` body
 * `{ prompt, skillRefs?, kbId?, kbName?, processInstanceId, taskId? }` →
 * `202 { taskId }`(processInstanceId 必填,taskId 可空);`GET
 * /api/backend/tasks/{taskId}` →
 * `{ taskId, status, result?, error? }`(ready 时 result 为解析后的 JSON 对象)。
 */
async function dispatchTasks(
  ctx: Context,
  deps: SessionDeps,
  tasks: Map<string, BackendTaskState>,
  method: string,
  urlPath: string,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const rest = urlPath.slice(TASK_ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
  if (method === 'POST' && rest === '') {
    let prompt: string
    let skillRefs: readonly string[] = []
    let kb: BackendTaskKb | undefined
    let instance: BackendTaskInstance
    try {
      const parsed = await readJsonBody(req) as {
        prompt?: unknown
        skillRefs?: unknown
        kbId?: unknown
        kbName?: unknown
        processInstanceId?: unknown
        taskId?: unknown
      }
      if (typeof parsed.prompt !== 'string' || parsed.prompt.trim() === '') {
        throw new Error('prompt 必须为非空字符串')
      }
      // 实例上下文必填(设计 2026-10-14 §6.1):旧引擎 payload 未携带时直接 400。
      if (typeof parsed.processInstanceId !== 'string' || parsed.processInstanceId.trim() === '') {
        throw new Error('processInstanceId 必须为非空字符串')
      }
      if (parsed.taskId !== undefined && parsed.taskId !== null
        && (typeof parsed.taskId !== 'string' || parsed.taskId.trim() === '')) {
        throw new Error('taskId 提供时必须为非空字符串')
      }
      if (parsed.skillRefs !== undefined) {
        if (!Array.isArray(parsed.skillRefs)
          || parsed.skillRefs.some((skill: unknown) => typeof skill !== 'string' || skill === '')) {
          throw new Error('skillRefs 必须为字符串数组')
        }
        skillRefs = parsed.skillRefs
      }
      // kb 字段成对携带:kbId 必填且非空,kbName 允许缺省(kb 解析降级时两字段都不出现)
      if (parsed.kbId !== undefined) {
        if (typeof parsed.kbId !== 'string' || parsed.kbId.trim() === '') {
          throw new Error('kbId 必须为非空字符串')
        }
        if (parsed.kbName !== undefined && (typeof parsed.kbName !== 'string' || parsed.kbName.trim() === '')) {
          throw new Error('kbName 提供时必须为非空字符串')
        }
        kb = { kbId: parsed.kbId, kbName: parsed.kbName ?? parsed.kbId }
      } else if (parsed.kbName !== undefined) {
        throw new Error('kbName 不可脱离 kbId 单独出现')
      }
      prompt = parsed.prompt
      instance = {
        processInstanceId: parsed.processInstanceId,
        taskId: parsed.taskId === undefined || parsed.taskId === null ? null : parsed.taskId,
      }
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const task: BackendTaskState = { id: randomUUID(), status: 'running' }
    tasks.set(task.id, task)
    void runBackendTask(ctx, deps, task, prompt, skillRefs, kb, instance)
      .catch((error: unknown) => {
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
      })
    sendJson(res, 202, { taskId: task.id })
    return
  }
  if (method === 'GET' && rest !== '' && !rest.includes('/')) {
    const task = tasks.get(rest)
    if (task === undefined) {
      sendJson(res, 404, { error: `未知任务: ${rest}` })
      return
    }
    sendJson(res, 200, { taskId: task.id, status: task.status, result: task.result, error: task.error })
    return
  }
  sendJson(res, 404, { error: `no route for ${method} ${urlPath}` })
}

/**
 * 向 web-console 注册本实例(心跳);失败记 warn 由下一轮重试。
 */
async function registerOnce(ctx: Context, options: BackendTaskOptions): Promise<void> {
  const defaultModel = ctx.get('agentDefaultModel')
  const llmLabel = defaultModel?.currentSelection().model
  const response = await fetch(`${options.webConsoleBaseUrl}/api/backend-profiles/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: options.selfUrl,
      name: options.backendName,
      llmLabel,
      workspaceLabel: basename(process.cwd()),
    }),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`web-console 注册返回 ${response.status}${detail ? `: ${detail}` : ''}`)
  }
}

/** 目标是否为已存在的目录。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 一轮 skill 同步:从 web-console 注册表聚合端点拉归属本实例 URL 的 skill
 * 清单,按 SkillHub 清单增量安装到缓存目录,有安装动作后失效 skill 注册表。
 * 错误记日志不上抛(daemon 语义)。
 */
async function syncSkillsOnce(
  ctx: Context,
  options: BackendTaskOptions,
  control: () => SkillProviderControl | undefined,
): Promise<void> {
  const statePath = join(dirname(options.skillDir), 'state.json')
  const response = await fetch(
    `${options.webConsoleBaseUrl}/api/backend-profiles/skills?url=${encodeURIComponent(options.selfUrl)}`,
  )
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`web-console skill 聚合返回 ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  const body = await response.json() as { success?: boolean; data?: SkillRequirement[] }
  if (body.success !== true || !Array.isArray(body.data)) {
    throw new Error('web-console skill 聚合响应信封异常')
  }
  let state: SkillInstallState
  try {
    state = JSON.parse(await readFile(statePath, 'utf8')) as SkillInstallState
  } catch {
    state = { skills: {} }
  }
  let changed = false
  // 同一 namespace 的清单只拉一次
  const manifests = new Map<string, Map<string, SkillHubItem>>()
  for (const skill of body.data) {
    let manifest = manifests.get(skill.namespace)
    if (manifest === undefined) {
      manifest = await fetchSkillhubManifest(options.skillhubBaseUrl, options.skillhubToken, skill.namespace)
      manifests.set(skill.namespace, manifest)
    }
    const item = manifest.get(skill.slug)
    if (item === undefined) {
      ctx.logger.warn(`backend-task: skill '${skill.slug}' 不在命名空间 '${skill.namespace}' 已发布清单中`)
      continue
    }
    const installed = state.skills[skill.slug]
    const skillDir = join(options.skillDir, skill.slug)
    if (installed !== undefined && installed.fingerprint === item.fingerprint
      && await isDirectory(skillDir)) {
      continue
    }
    await installSkillZip(options.skillhubBaseUrl, options.skillhubToken, options.skillDir, skill.slug, item)
    state.skills[skill.slug] = { namespace: skill.namespace, fingerprint: item.fingerprint }
    changed = true
  }
  if (changed) {
    await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    control()?.invalidate()
  }
  ctx.logger.info(`backend-task: 本轮归属 skill ${body.data.length} 个`)
}

/**
 * 挂载 backend task 运行器:REST 端点经 webserver 前缀路由,注册与 skill
 * 同步 daemon 定时器随上下文销毁清理,启动各先跑一轮。
 *
 * @param ctx - 携带 webServer/agents/sessions/agentDefaultModel/skills 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const options: BackendTaskOptions = {
    webConsoleBaseUrl: config.webConsoleBaseUrl.replace(/\/+$/, ''),
    selfUrl: config.selfUrl.replace(/\/+$/, ''),
    backendName: config.backendName,
    skillhubBaseUrl: config.skillhubBaseUrl.replace(/\/+$/, ''),
    skillhubToken: config.skillhubToken,
    syncIntervalMs: config.syncIntervalMs,
    registerIntervalMs: config.registerIntervalMs,
    skillDir: config.skillDir !== undefined && config.skillDir !== ''
      ? config.skillDir
      : dshHomePath('backend-task', 'skills'),
  }
  new URL(options.webConsoleBaseUrl)
  new URL(options.selfUrl)
  new URL(options.skillhubBaseUrl)
  for (const [field, value] of [['syncIntervalMs', options.syncIntervalMs], ['registerIntervalMs', options.registerIntervalMs]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`backend-task: ${field} 必须为正有限数,得到 ${String(value)}`)
    }
  }
  const deps: SessionDeps = {
    agents: ctx.agents,
    sessions: ctx.sessions,
    defaultModel: ctx.agentDefaultModel,
  }
  const tasks = new Map<string, BackendTaskState>()
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: TASK_ROUTE_PREFIX,
      handler: (req, res) => {
        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
        dispatchTasks(ctx, deps, tasks, req.method ?? 'GET', urlPath, req, res)
          .catch((error: unknown) => {
            ctx.logger.warn('backend-task: 端点异常', error)
            if (!res.headersSent) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          })
      },
    }),
  'backend-task: /api/backend/tasks prefix route',
  )
  // 注册心跳 daemon:启动先跑一轮,周期续约(active 判定窗口 5 分钟)
  void registerOnce(ctx, options).catch((error: unknown) => { ctx.logger.warn('backend-task: 注册失败', error) })
  const registerTimer = setInterval(() => {
    void registerOnce(ctx, options).catch((error: unknown) => { ctx.logger.warn('backend-task: 注册心跳异常', error) })
  }, options.registerIntervalMs)
  // skill 同步 daemon:mkdir 失败不阻塞启动,记日志后每轮 interval 重试
  let providerControl: SkillProviderControl | undefined
  let provider: FileSystemSkillProvider | undefined
  ctx.effect(
    () => ctx.skills.registerProvider((control) => {
      providerControl = control
      provider = new FileSystemSkillProvider(ctx, control, {
        providerName: 'backend-task',
        includeDefaultRoots: false,
        customSkillDirs: [options.skillDir],
        watch: false,
      })
      return provider
    }),
    'backend-task: cache-root skill provider',
  )
  ctx.effect(() => () => { void provider?.dispose() }, 'backend-task: provider disposal')
  const syncOnce = () =>
    syncSkillsOnce(ctx, options, () => providerControl)
      .catch((error: unknown) => { ctx.logger.warn('backend-task: skill 同步失败', error) })
  void mkdir(options.skillDir, { recursive: true })
    .then(() => syncOnce())
    .catch((error: unknown) => { ctx.logger.warn('backend-task: skill 缓存目录创建失败', error) })
  const syncTimer = setInterval(() => void syncOnce(), options.syncIntervalMs)
  ctx.effect(() => () => {
    clearInterval(registerTimer)
    clearInterval(syncTimer)
  }, 'backend-task: daemon intervals')
}
