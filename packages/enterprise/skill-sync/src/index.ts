/**
 * Enterprise skill distribution channel (skill-repo-design §4/§6.2/§7).
 *
 * Two directories serve the employee agent, with distinct ownership: the
 * governance vault `$DSH_HOME/skill-sync/skills` holds process-required skills
 * fed by a periodic daemon — it calls flowable-engine `GET /dsh/skills/required`
 * with the signed-in employee's Supabase JWT (`ctx.currentUser.getToken()`),
 * diffs the required list against the local install state, downloads missing or
 * stale skills from SkillHub (namespace list → zip download → fingerprint
 * check), and registers a filesystem skill provider over the vault so
 * `ctx.skills` serves the installed entries. The employee drawer
 * `$DSH_HOME/skills` holds employee-acquired skills — market installs, zip
 * uploads, and hand-copied folders alike — and is already served by the default
 * filesystem provider, so this plugin only scans it for the governance panel.
 * Failures are logged and retried on the next tick; nothing here blocks
 * employee startup (skill-repo-design §6.2 降级).
 *
 * For opening a todo (work item 3) the plugin also serves
 * `POST /api/enterprise/skills/ensure`: the web UI posts the task's
 * `dshMeta.skillRefs` before creating the session and receives the names
 * still missing after an immediate sync round, driving the degraded-continue
 * notice instead of blocking the session (skill-repo-design §7).
 *
 * The plugin is also the single writer behind the employee skill governance
 * panel (design 2026-10-30): under the same `/api/enterprise/skills` prefix it
 * serves the SkillHub market catalog (`GET .../catalog`), market install
 * (`POST .../install`), employee zip upload (`POST .../import`), and uninstall
 * (`POST .../uninstall`) — all drawer-scoped and anonymous-capable, since the
 * drawer is a loopback-local, employee-owned directory; only `required`
 * records stay uninstall-proof via the `state.json` ledger. Every mutating
 * operation shares one in-process write mutex with the daemon round, and the
 * drawer's cache is invalidated after each write.
 *
 * @module @deepseek-ai/dsh-skill-sync
 */

import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { unzipSync } from 'fflate'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import type {} from '@deepseek-ai/dsh-user-identity-context'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-sync'

/** 当前登录员工的 JWT 失效(401);等客户端续期/重新登录后自动恢复,非故障。 */
class SessionExpiredError extends Error {}

/** 治理端点业务错误:status 直接映射 HTTP 状态码,message 面向员工展示。 */
export class SkillEndpointError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SkillEndpointError'
  }
}

/** SkillHub 清单端点返回非 2xx;status 供调用方区分「namespace 不存在」与网络/服务错误。SkillHub 当前对未知 namespace 抛业务校验异常映射为 400(非 404),两者均视为不存在。 */
export class SkillhubManifestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`SkillHub 命名空间清单返回 ${status}${detail === '' ? '' : `: ${detail}`}`)
    this.name = 'SkillhubManifestError'
  }
}

/** 等待 skill 注册表、登录身份存储与本地 webserver 就绪后才挂载。 */
export const inject = ['skills', 'currentUser', 'webServer']

/** SkillHub 命名空间清单单页上限(服务端 CLI 端点上限 100)。 */
const SKILLHUB_PAGE_LIMIT = 100

/** 插件配置,全部来自 enterprise profile 的 cordis.yml config 段。 */
export interface Config {
  /** flowable-engine 基地址(协议+主机+端口,无路径);volatile:设置面板可改,即时生效。 */
  flowableBaseUrl: Volatile<string>
  /** SkillHub 后端 API 基地址(协议+主机+端口,无路径);volatile:设置面板可改,即时生效。 */
  skillhubBaseUrl: Volatile<string>
  /** SkillHub 只读分发 token;空串时跳过清单/下载(仅靠已装缓存);volatile:设置面板可改,即时生效。 */
  skillhubToken: Volatile<string>
  /**
   * 市场目录命名的企业验证开放技能 namespace;空串 = 未配置(回退环境变量
   * `SKILL_MKTPLAC_NAMESPACE`,两者都空 = 市场未开放,面板显示空态);
   * volatile:设置面板可改,即时生效。
   */
  marketNamespace: Volatile<string>
  /** daemon 扫描间隔毫秒;volatile:设置面板可改,变更即重排 daemon 定时器。 */
  intervalMs: Volatile<number>
  /** 流程要求技能的缓存目录(daemon 独占写者);缺省用 `$DSH_HOME/skill-sync/skills`。 */
  skillDir?: string
  /** 员工技能抽屉:市场安装/zip 导入的落盘目录,也是面板目录扫描的治理范围;缺省用 `$DSH_HOME/skills`。 */
  userSkillDir?: string
}

export const Config = z.object({
  flowableBaseUrl: z.string().required().volatile(),
  skillhubBaseUrl: z.string().required().volatile(),
  skillhubToken: z.string().required().volatile(),
  marketNamespace: z.string().required().volatile(),
  intervalMs: z.number().required().volatile(),
  skillDir: z.string(),
  userSkillDir: z.string(),
})

/** `/dsh/skills/required` 的单条清单项。 */
export interface RequiredSkill {
  /** skill 裸名(dsh:skillRef 值)。 */
  name: string
  /** 所属 SkillHub 命名空间;流程定义无法映射应用时缺省。 */
  namespace?: string
}

/** skill 安装来源:`required` 流程要求(daemon/ensure 自动装,不可卸载)、`upload` 员工 zip 上传、`skillhub` 员工从市场安装、`manual` 员工手工放入目录(目录扫描发现,无账本记录)。 */
export type SkillSource = 'required' | 'upload' | 'skillhub' | 'manual'

/** 本地安装状态:skill 名 → 溯源(fingerprint 用于增量升级检测)。 */
interface SkillSyncState {
  skills: Record<string, SkillStateRecord>
}

/** state.json 的单条记录;`source` 缺省视为 `required`(治理面板之前的记录全部是 daemon 装的)。 */
interface SkillStateRecord {
  namespace: string
  fingerprint: string
  /** 安装来源;旧记录无此字段。 */
  source?: SkillSource
  /** `upload`/`skillhub` 来源的描述(SKILL.md frontmatter description,面板卡片展示);其余来源不存。 */
  description?: string
}

/** SkillHub 命名空间清单的单个 skill 条目(CliNamespaceSyncItemResponse)。 */
export interface SkillHubItem {
  slug: string
  fingerprint: string
  downloadUrl: string
  /** 最新发布版本号;市场目录展示用,同步路径不读。 */
  version?: string
  /** SKILL.md frontmatter description;市场目录展示用,同步路径不读。 */
  summary?: string
  /** 最新发布时间;市场目录展示用,同步路径不读。 */
  updatedAt?: string
}

/**
 * 拉取 SkillHub 命名空间的已发布 skill 清单(翻页取全量)。
 *
 * <p>导出供 dsh-backend-task 复用(其同步源是 web-console 注册表聚合而非
 * flowable 待办,但 SkillHub 清单/下载是同一套)。
 *
 * @param skillhubBaseUrl - SkillHub 后端 API 基地址(无尾斜杠)。
 * @param skillhubToken - SkillHub 只读分发 token。
 * @param namespace - 命名空间名。
 * @returns slug → 清单条目的索引。
 */
export async function fetchSkillhubManifest(
  skillhubBaseUrl: string,
  skillhubToken: string,
  namespace: string,
): Promise<Map<string, SkillHubItem>> {
  const index = new Map<string, SkillHubItem>()
  let cursor: string | undefined = '0'
  while (cursor !== undefined && cursor !== '') {
    const response = await fetch(
      `${skillhubBaseUrl}/api/cli/v1/namespaces/${encodeURIComponent(namespace)}/skills`
        + `?cursor=${encodeURIComponent(cursor)}&limit=${SKILLHUB_PAGE_LIMIT}`,
      { headers: { authorization: `Bearer ${skillhubToken}` } },
    )
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new SkillhubManifestError(response.status, detail)
    }
    const body = await response.json() as {
      code?: number
      data?: { items?: SkillHubItem[]; nextCursor?: string | null }
    }
    if (body.code !== 0 || body.data === undefined) {
      throw new Error(`SkillHub 响应信封异常: code=${body.code ?? 'missing'}`)
    }
    for (const item of body.data.items ?? []) {
      index.set(item.slug, item)
    }
    cursor = body.data.nextCursor ?? undefined
  }
  return index
}

/**
 * 下载并安装单个 skill 包:zip 根即 SKILL.md(SkillHub 打包已剥外层目录),
 * 解压到临时目录后原子改名到 `<skillDir>/<name>`。导出供 dsh-backend-task 复用。
 *
 * @param skillhubBaseUrl - SkillHub 后端 API 基地址(无尾斜杠)。
 * @param skillhubToken - SkillHub 只读分发 token。
 * @param skillDir - 缓存根目录(已存在)。
 * @param name - skill 裸名(安装目录名)。
 * @param item - 清单条目(带 downloadUrl)。
 */
export async function installSkillZip(
  skillhubBaseUrl: string,
  skillhubToken: string,
  skillDir: string,
  name: string,
  item: SkillHubItem,
): Promise<void> {
  const downloadUrl = new URL(item.downloadUrl, `${skillhubBaseUrl}/`)
  const response = await fetch(downloadUrl, {
    headers: { authorization: `Bearer ${skillhubToken}` },
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`下载 skill 包返回 ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
  await installZipEntries(skillDir, name, entries)
}

/**
 * 把已解压的 zip 条目安装进缓存根:写入临时目录后原子改名到 `<skillDir>/<name>`
 * (任一条目失败整包回滚)。SkillHub 下载与员工上传两条安装路径共用。
 *
 * @param skillDir - 缓存根目录(已存在)。
 * @param name - skill 裸名(安装目录名)。
 * @param entries - fflate 解压出的条目表(路径 → 内容)。
 */
async function installZipEntries(
  skillDir: string,
  name: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  const tempDir = await mkdtemp(join(skillDir, `.tmp-${name}-`))
  try {
    for (const [entryPath, content] of Object.entries(entries)) {
      if (entryPath === '' || entryPath.endsWith('/')) continue
      const target = safeJoin(tempDir, entryPath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    const dest = join(skillDir, name)
    await rm(dest, { recursive: true, force: true })
    await rename(tempDir, dest)
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

/** 已解析的运行选项(apply 阶段完成校验与默认值合并)。 */
export interface SkillSyncOptions {
  flowableBaseUrl: string
  skillhubBaseUrl: string
  skillhubToken: string
  /** 市场目录 namespace(空 = 管理员未开放,面板显示空态)。 */
  marketNamespace: string
  /** 流程要求技能的缓存目录。 */
  skillDir: string
  /** 员工技能抽屉(市场安装/zip 导入落盘,面板目录扫描范围)。 */
  userSkillDir: string
}

/** 本地已装 skill 清单条目(面板「流程要求/本地技能/市场安装」三组的数据源)。 */
export interface InstalledSkill {
  name: string
  source: SkillSource
  /** 所属 SkillHub 命名空间(市场安装记录;manual/required 无)。 */
  namespace?: string
  /** SKILL.md description(账本记录或目录扫描 frontmatter 解析;缺失不出现)。 */
  description?: string
}

/** 市场目录条目(本地安装状态已合并)。 */
export interface CatalogSkill {
  namespace: string
  slug: string
  fingerprint: string
  downloadUrl: string
  /** 最新发布版本号。 */
  version?: string
  /** SKILL.md frontmatter description。 */
  summary?: string
  /** 最新发布时间。 */
  updatedAt?: string
  /** 本地已安装(state.json 记录且目录存在)。 */
  installed: boolean
  /** 已装时的来源;未装为 undefined。 */
  source?: SkillSource
}

/** `GET /api/enterprise/skills/catalog` 响应。 */
export interface SkillCatalog {
  /** 请求携带有效员工 JWT;false = 匿名浏览(local 不含 required 条目,面板隐藏流程要求组)。 */
  authenticated: boolean
  /** `marketNamespace` 非空;false 时面板显示「管理员未开放技能目录」空态。 */
  catalogOpen: boolean
  /** 每个 namespace 一组;SkillHub 不可达的 namespace 携带 error 且 skills 为空(部分失败语义,可区分网络错误与空目录)。 */
  namespaces: Array<{ namespace: string; error?: string; skills: CatalogSkill[] }>
  /** 本地已装清单:流程要求来自账本∩`skillDir`,其余来自 `userSkillDir` 目录扫描(账本记录补 source,无记录的视为 manual);匿名时不含 required 条目。 */
  local: InstalledSkill[]
}

/**
 * 员工端 skill 分发服务:周期同步 + 即时安装入口(工作项 3 的对接面)。
 *
 * <p>daemon 只在有人登录时干活:未登录(token 缺失)或 token 过期(401)的
 * 一轮直接跳过,下轮重试;单 skill 下载失败记 warn 不中断同轮其他 skill。
 */
export class SkillSyncService extends Service {
  private readonly options: SkillSyncOptions
  private readonly control: () => SkillProviderControl | undefined
  /** 进行中的一轮同步;并发调用合并等待同一轮(端点触发/登录触发/daemon 可同时到达)。 */
  private syncGate: Promise<void> | undefined
  /** 安装/卸载/导入写操作与 daemon 同轮共用的串行化锁(单写者原则的进程内表达)。 */
  private writeGate: Promise<unknown> = Promise.resolve()

  /**
   * 把一个写操作排队到写锁上:与前一个操作(以及 daemon 同轮)严格串行,
   * 结果原样返回,失败不阻断后续排队者。
   */
  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeGate.then(operation, operation)
    this.writeGate = next.catch(() => undefined)
    return next
  }

  /** @param ctx - 携带 `currentUser` 的 Cordis 上下文。 */
  constructor(
    ctx: Context,
    options: SkillSyncOptions,
    control: () => SkillProviderControl | undefined,
  ) {
    super(ctx, 'skillSync')
    this.options = options
    this.control = control
  }

  /**
   * 启动服务:创建流程缓存目录与员工抽屉目录,随后立即跑一轮同步(不等第一个 interval)。
   * 本服务由 apply() 内普通构造挂载(非 class 插件),cordis 不会自动调用
   * `[Service.init]`,故由 apply 显式调用本方法。
   */
  async start(): Promise<void> {
    await mkdir(this.options.skillDir, { recursive: true })
    await mkdir(this.options.userSkillDir, { recursive: true })
    await mkdir(dirname(this.statePath), { recursive: true })
    void this.sync().catch((error: unknown) => { this.ctx.logger.warn('skill-sync 首轮同步失败', error) })
  }

  private get statePath(): string {
    return join(dirname(this.options.skillDir), 'state.json')
  }

  /**
   * 执行一轮同步:拉取当前用户所需清单,下载缺失/过期的 skill 到缓存目录,
   * 有安装动作后失效 skill 注册表缓存。错误记日志不上抛(daemon 语义)。
   * 已有一轮在跑时合并等待,不重复出站。
   */
  async sync(): Promise<void> {
    if (this.syncGate !== undefined) {
      await this.syncGate
      return
    }
    // 同轮整体上写锁:与治理端点的 install/uninstall/import 互斥
    this.syncGate = this.withWriteLock(() => this.runSync())
    try {
      await this.syncGate
    } finally {
      this.syncGate = undefined
    }
  }

  private async runSync(): Promise<void> {
    if (this.options.skillhubBaseUrl === '' || this.options.flowableBaseUrl === '') {
      this.ctx.logger.warn('skill-sync: SKILLHUB_URL/FLOWABLE_ENGINE_URL 未配置,本轮跳过(可在登录页服务配置中设置)')
      return
    }
    const token = this.ctx.currentUser.getToken()
    if (token === undefined) {
      this.ctx.logger.info('skill-sync: 未登录,本轮跳过')
      return
    }
    let required: readonly RequiredSkill[]
    try {
      required = await this.fetchRequired(token)
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        this.ctx.logger.info('skill-sync: 登录 token 已过期或无效,本轮跳过,待下一次身份验证后自动恢复')
        return
      }
      this.ctx.logger.warn('skill-sync: 拉取所需 skill 清单失败', error)
      return
    }
    const state = await this.readState()
    let changed = false
    const installedNames: string[] = []
    // 同一 namespace 的清单只拉一次;按 namespace 分组处理
    const manifests = new Map<string, Map<string, SkillHubItem>>()
    for (const skill of required) {
      if (skill.namespace === undefined || skill.namespace === '') {
        this.ctx.logger.warn(`skill-sync: skill '${skill.name}' 无 namespace,跳过`)
        continue
      }
      let manifest = manifests.get(skill.namespace)
      if (manifest === undefined) {
        try {
          manifest = await fetchSkillhubManifest(this.options.skillhubBaseUrl, this.options.skillhubToken, skill.namespace)
        } catch (error) {
          this.ctx.logger.warn(`skill-sync: 拉取 SkillHub 命名空间 '${skill.namespace}' 清单失败`, error)
          manifests.set(skill.namespace, new Map())
          continue
        }
        manifests.set(skill.namespace, manifest)
      }
      const item = manifest.get(skill.name)
      if (item === undefined) {
        this.ctx.logger.warn(`skill-sync: skill '${skill.name}' 不在命名空间 '${skill.namespace}' 已发布清单中`)
        continue
      }
      const installed = state.skills[skill.name]
      const skillDir = join(this.options.skillDir, skill.name)
      if (installed !== undefined && installed.fingerprint === item.fingerprint
        && await isDirectory(skillDir)) {
        continue
      }
      try {
        await installSkillZip(this.options.skillhubBaseUrl, this.options.skillhubToken,
          this.options.skillDir, skill.name, item)
        state.skills[skill.name] = { namespace: skill.namespace, fingerprint: item.fingerprint }
        changed = true
        installedNames.push(skill.name)
      } catch (error) {
        this.ctx.logger.warn(`skill-sync: 安装 skill '${skill.name}' 失败`, error)
      }
    }
    if (changed) {
      await writeFile(this.statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
      this.control()?.invalidate()
    }
    this.ctx.logger.info(
      `skill-sync: 本轮所需 ${required.length} 个 skill,安装/更新 ${installedNames.length} 个`
        + (installedNames.length > 0 ? `: ${installedNames.join(', ')}` : ''),
    )
  }

  /**
   * 确保指定 skill 已安装;缺失时立即执行一轮同步再复查。
   *
   * @param names - 需要就绪的 skill 裸名(待办 dshMeta.skillRefs)。
   * @returns 仍缺失的 skill 名(同步后依旧不可用,调用方走降级提示)。
   */
  async ensureInstalled(names: readonly string[]): Promise<readonly string[]> {
    const missing = async (list: readonly string[]): Promise<readonly string[]> => {
      const absent: string[] = []
      for (const name of list) {
        if (!(await isDirectory(join(this.options.skillDir, name)))) absent.push(name)
      }
      return absent
    }
    const before = await missing(names)
    if (before.length === 0) return []
    // 同步失败不阻断:已装 skill 依旧可用,缺失项进入返回值走降级提示
    await this.sync().catch((error: unknown) => { this.ctx.logger.warn('skill-sync: ensure 触发的同步失败', error) })
    return await missing(names)
  }

  /**
   * 市场目录:`marketNamespace` 命名空间的 SkillHub 清单与本地安装状态合并;
   * 未配置时 catalogOpen=false。namespace 不存在(404)与网络/服务错误在组级
   * error 文案中区分,面板可分别提示「检查配置」与「稍后重试」。
   *
   * <p>匿名浏览(authenticated=false)时 local 不含 required 条目:匿名请求
   * 没有 JWT,无法确认本地 required 快照仍与流程要求一致,面板据此隐藏
   * 流程要求组。读操作无副作用,市场目录与上传技能照常返回。
   *
   * @param authenticated - 请求是否携带有效员工 JWT(catalog 端点解析)。
   * @returns 目录快照:登录状态、市场开放状态、市场 namespace 清单组(失败
   *   携带 error)与本地已装清单。
   */
  async listCatalog(authenticated: boolean): Promise<SkillCatalog> {
    const state = await this.readState()
    const local: InstalledSkill[] = []
    // 流程要求组:账本 required 记录 ∩ skillDir 目录实况;匿名时整组不发
    for (const [name, record] of Object.entries(state.skills)) {
      if ((record.source ?? 'required') !== 'required' || !authenticated) continue
      if (!(await isDirectory(join(this.options.skillDir, name)))) continue
      const entry: InstalledSkill = { name, source: 'required' }
      if (record.namespace !== '') entry.namespace = record.namespace
      if (record.description !== undefined) entry.description = record.description
      local.push(entry)
    }
    // 员工抽屉组:扫描 userSkillDir,账本记录补来源,无记录视为手工放入
    for (const name of await listSubdirectories(this.options.userSkillDir)) {
      const record = state.skills[name]
      const entry: InstalledSkill = {
        name,
        source: record?.source === 'upload' || record?.source === 'skillhub' ? record.source : 'manual',
      }
      if (record?.source === 'upload' || record?.source === 'skillhub') {
        if (record.namespace !== '') entry.namespace = record.namespace
        if (record.description !== undefined) entry.description = record.description
      } else {
        const description = await readSkillDescription(join(this.options.userSkillDir, name))
        if (description !== undefined) entry.description = description
      }
      local.push(entry)
    }
    if (this.options.marketNamespace === '') {
      return { authenticated, catalogOpen: false, namespaces: [], local }
    }
    const namespace = this.options.marketNamespace
    const localByName = new Map(local.map(entry => [entry.name, entry]))
    const namespaces: SkillCatalog['namespaces'] = []
    try {
      const manifest = await fetchSkillhubManifest(
        this.options.skillhubBaseUrl,
        this.options.skillhubToken,
        namespace,
      )
      namespaces.push({
        namespace,
        skills: [...manifest.values()].map((item) => {
          const existing = localByName.get(item.slug)
          const skill: CatalogSkill = {
            namespace,
            slug: item.slug,
            fingerprint: item.fingerprint,
            downloadUrl: item.downloadUrl,
            installed: existing !== undefined,
          }
          if (item.version !== undefined) skill.version = item.version
          if (item.summary !== undefined) skill.summary = item.summary
          if (item.updatedAt !== undefined) skill.updatedAt = item.updatedAt
          // 来源与本地清单同源:账本 required 记录标 required,抽屉扫描发现(含手工放入)按扫描结果标
          if (existing !== undefined) skill.source = existing.source
          return skill
        }),
      })
    } catch (error) {
      namespaces.push({ namespace, error: catalogErrorText(namespace, error), skills: [] })
    }
    return { authenticated, catalogOpen: true, namespaces, local }
  }

  /**
   * 从市场安装/更新一个 skill(写锁内执行),落盘到 `userSkillDir`。
   *
   * <p>冲突语义:目标与 `required` 来源已装记录重名时,fingerprint 相同且目录
   * 在 → 幂等返回已安装;不同 → 409 拒绝(版本由流程管理,不可市场覆盖)。
   * `userSkillDir` 已有同名目录但无账本记录(手工放入)→ 409 请先卸载。
   * 其余来源(upload/skillhub)重名视为更新(重装即更新)。
   *
   * @param namespace - SkillHub 命名空间。
   * @param slug - skill 裸名(调用方已过 SKILL_NAME_PATTERN 校验)。
   * @returns alreadyInstalled=true 表示幂等命中,未发生下载。
   */
  async installFromSkillhub(namespace: string, slug: string): Promise<{ alreadyInstalled: boolean }> {
    return this.withWriteLock(async () => {
      const manifest = await fetchSkillhubManifest(this.options.skillhubBaseUrl, this.options.skillhubToken, namespace)
      const item = manifest.get(slug)
      if (item === undefined) {
        throw new SkillEndpointError(404, `技能 '${slug}' 不在命名空间 '${namespace}' 的已发布清单中`)
      }
      const state = await this.readState()
      const existing = state.skills[slug]
      if (existing !== undefined && (existing.source ?? 'required') === 'required') {
        // 流程要求来源的目录在 skillDir;同指纹幂等,版本差异拒绝市场覆盖
        if (existing.fingerprint === item.fingerprint && await isDirectory(join(this.options.skillDir, slug))) {
          return { alreadyInstalled: true }
        }
        throw new SkillEndpointError(409, '该技能由流程要求安装，版本由流程管理，不能从市场覆盖')
      }
      const userDirExists = await isDirectory(join(this.options.userSkillDir, slug))
      if (userDirExists && existing === undefined) {
        throw new SkillEndpointError(409, `已存在同名技能 '${slug}'（手工放入），请先卸载后再安装`)
      }
      if (existing !== undefined && existing.fingerprint === item.fingerprint && userDirExists) {
        return { alreadyInstalled: true }
      }
      await installSkillZip(this.options.skillhubBaseUrl, this.options.skillhubToken, this.options.userSkillDir, slug, item)
      const installed: SkillStateRecord = { namespace, fingerprint: item.fingerprint, source: 'skillhub' }
      if (item.summary !== undefined) installed.description = item.summary
      state.skills[slug] = installed
      await writeFile(this.statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
      this.control()?.invalidate()
      return { alreadyInstalled: false }
    })
  }

  /**
   * 卸载一个技能(写锁内执行):删除 `userSkillDir` 下的技能目录及账本记录
   * (如有)。`required` 来源拒绝(版本由流程管理);目录与账本记录都不存在
   * 时 404(fail loud,不静默成功)。
   *
   * @param slug - skill 裸名(调用方已过 SKILL_NAME_PATTERN 校验)。
   */
  async uninstallSkill(slug: string): Promise<void> {
    await this.withWriteLock(async () => {
      const state = await this.readState()
      const record = state.skills[slug]
      if (record !== undefined && (record.source ?? 'required') === 'required') {
        throw new SkillEndpointError(403, '由流程要求安装，不可卸载')
      }
      const dirExisted = await isDirectory(join(this.options.userSkillDir, slug))
      if (record === undefined && !dirExisted) {
        throw new SkillEndpointError(404, '未找到该技能的目录或安装记录')
      }
      await rm(join(this.options.userSkillDir, slug), { recursive: true, force: true })
      if (record !== undefined) {
        // state.skills 为 JSON 持久化的 Record;解构 rest 移除 slug 键
        const { [slug]: _removed, ...remaining } = state.skills
        state.skills = remaining
        await writeFile(this.statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
      }
      this.control()?.invalidate()
    })
  }

  /**
   * 员工 zip 上传导入(写锁内执行),落盘到 `userSkillDir`:解压 → 定位/归一根
   * SKILL.md → 最小 frontmatter 校验(name 必填且过 SKILL_NAME_PATTERN)→
   * 同名已装 409(required 或抽屉目录任一命中)→ 安装并记 `upload` 来源
   * (SKILL.md description 一并记录供面板展示)。
   *
   * @param zipBytes - 请求体原始字节(调用方已限上传大小)。
   * @returns 安装成功的 skill 裸名。
   */
  async importSkillZip(zipBytes: Uint8Array): Promise<{ name: string }> {
    return this.withWriteLock(async () => {
      let entries: Record<string, Uint8Array>
      try {
        entries = unzipSync(zipBytes)
      } catch {
        throw new SkillEndpointError(400, '上传内容不是有效的 zip 包')
      }
      let total = 0
      for (const content of Object.values(entries)) total += content.length
      if (total > MAX_IMPORT_UNCOMPRESSED_BYTES) {
        throw new SkillEndpointError(413, `解压后总量超过上限 ${Math.floor(MAX_IMPORT_UNCOMPRESSED_BYTES / 1048576)} MB`)
      }
      const unpacked = normalizeSkillZipRoot(entries)
      const skillMd = unpacked.entries['SKILL.md']
      if (skillMd === undefined) {
        throw new SkillEndpointError(400, 'zip 中找不到 SKILL.md（须为包含 SKILL.md 的技能文件夹或 zip 包）')
      }
      const frontmatter = parseSkillFrontmatter(new TextDecoder().decode(skillMd))
      if (frontmatter.name === undefined || !SKILL_NAME_PATTERN.test(frontmatter.name)) {
        throw new SkillEndpointError(400, 'SKILL.md frontmatter 缺少合法的 name 字段（须匹配 [A-Za-z0-9][A-Za-z0-9._-]*）')
      }
      const name = frontmatter.name
      const state = await this.readState()
      const record = state.skills[name]
      if ((record?.source ?? 'required') === 'required' && record !== undefined) {
        throw new SkillEndpointError(409, `已存在同名技能 '${name}'（由流程要求安装），不能覆盖`)
      }
      if (await isDirectory(join(this.options.userSkillDir, name))) {
        throw new SkillEndpointError(409, `已存在同名技能 '${name}'，请先卸载后再导入`)
      }
      await installZipEntries(this.options.userSkillDir, name, unpacked.entries)
      const uploaded: SkillStateRecord = { namespace: '', fingerprint: '', source: 'upload' }
      if (frontmatter.description !== undefined) uploaded.description = frontmatter.description
      state.skills[name] = uploaded
      await writeFile(this.statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
      this.control()?.invalidate()
      return { name }
    })
  }

  /**
   * 拉取当前登录用户「现在 + 将来」需要的 skill 清单。
   * @param token - 当前登录员工的 Supabase JWT(currentUser.getToken())。
   * @returns 清单条目;401 视为未登录抛错由调用方跳过本轮。
   */
  private async fetchRequired(token: string): Promise<readonly RequiredSkill[]> {
    const response = await fetch(`${this.options.flowableBaseUrl}/dsh/skills/required`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      throw new SessionExpiredError('登录 token 已过期或无效')
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new Error(`flowable-engine 返回 ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    const body = await response.json() as { skills?: RequiredSkill[] }
    return body.skills ?? []
  }

  /** 读取本地安装状态;文件缺失/损坏视为空状态(全部重装)。 */
  private async readState(): Promise<SkillSyncState> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as SkillSyncState
    } catch {
      return { skills: {} }
    }
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

/** 列出目录的直接子目录名(名称序);目录不存在/不可读视为空。 */
async function listSubdirectories(root: string): Promise<string[]> {
  try {
    const dirents = await readdir(root, { withFileTypes: true })
    return dirents.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name).sort()
  } catch {
    return []
  }
}

/** 读技能目录 SKILL.md frontmatter 的 description(manual 条目展示用);文件缺失/无 frontmatter 返回 undefined。 */
async function readSkillDescription(skillDirectory: string): Promise<string | undefined> {
  try {
    return parseSkillFrontmatter(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).description
  } catch {
    return undefined
  }
}

/**
 * 把 zip 条目名安全映射到解压根目录下;绝对路径或 `..` 段(zip 炸弹/路径
 * 穿越特征)抛错拒绝整个安装。
 */
function safeJoin(root: string, entryPath: string): string {
  const normalized = entryPath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`zip 条目路径不安全: ${entryPath}`)
  }
  return join(root, normalized)
}

/** 员工上传 zip 的请求体上限(解压前)。 */
const MAX_IMPORT_UPLOAD_BYTES = 30 * 1024 * 1024

/** 解压后条目总量的上限(zip 炸弹防护)。 */
const MAX_IMPORT_UNCOMPRESSED_BYTES = 64 * 1024 * 1024

/**
 * 归一 zip 包根:SkillHub 打包 SKILL.md 在根;员工常把技能文件夹整体压包
 * (唯一顶层目录含 SKILL.md)。后者剥掉该前缀;找不到任何 SKILL.md 原样
 * 返回(由调用方报 400)。
 */
function normalizeSkillZipRoot(entries: Record<string, Uint8Array>): { entries: Record<string, Uint8Array> } {
  if (entries['SKILL.md'] !== undefined) return { entries }
  let prefix: string | undefined
  for (const entryPath of Object.keys(entries)) {
    const slash = entryPath.indexOf('/')
    if (slash <= 0) continue
    const top = entryPath.slice(0, slash)
    if (prefix === undefined) prefix = top
    else if (prefix !== top) return { entries }
  }
  if (prefix === undefined) return { entries }
  const stripped: Record<string, Uint8Array> = {}
  let hasSkillMd = false
  for (const [entryPath, content] of Object.entries(entries)) {
    if (!entryPath.startsWith(`${prefix}/`)) continue
    const rest = entryPath.slice(prefix.length + 1)
    if (rest === '') continue
    if (rest === 'SKILL.md') hasSkillMd = true
    stripped[rest] = content
  }
  if (hasSkillMd) return { entries: stripped }
  return { entries }
}

/**
 * 从 SKILL.md 提取 frontmatter 的 name/description(最小行式解析:仅识别
 * `key: value` 与引号包裹值)。导入校验只关心这两个字段;权威解析仍在
 * skill-filesystem 注册表侧。
 */
function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const result: { name?: string; description?: string } = {}
  for (const line of lines.slice(1)) {
    if (line.trim() === '---' || line.trim() === '...') break
    const match = /^(name|description):\s*(.*)$/.exec(line)
    if (match === null) continue
    // 组 2 (`.*`) 恒参与匹配,断言收窄 noUncheckedIndexedAccess 推断的 undefined
    const value = (match[2] as string).trim().replace(/^["']|["']$/g, '')
    if (value === '') continue
    if (match[1] === 'name') result.name = value
    else result.description = value
  }
  return result
}

/** 即时安装端点的前缀(与 /api/enterprise/auth 平行的 enterprise 命名区)。 */
const SKILL_ROUTE_PREFIX = '/api/enterprise/skills'

/** skill 裸名值域:拒绝路径分隔符与穿越段(names 直接拼缓存目录路径)。 */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** JSON 响应辅助函数。 */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/** 错误 → 面向响应/日志的文本:Error 取 message,其余(非 Error rejection)String 化。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 市场目录组级错误文案:SkillHub 对未知 namespace 返回 400(业务校验异常
 * 映射,非 404);本调用点请求参数固定,400 唯一来源即 namespace 不存在,
 * 与 404 一并明示检查配置,其余状态透传原始原因。
 */
function catalogErrorText(namespace: string, error: unknown): string {
  if (error instanceof SkillhubManifestError && (error.status === 400 || error.status === 404)) {
    return `命名空间 '${namespace}' 在 SkillHub 上不存在,请检查 SKILL_MKTPLAC_NAMESPACE 配置`
  }
  return errorText(error)
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
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- JSON.parse 仅抛 SyntaxError(Error 子类)
        reject(error)
      }
    })
  })
}

/** 读取请求体原始字节;累计超过 maxBytes 即断开并以 413 拒绝(防大包占内存)。 */
function readBytesBody(req: import('node:http').IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        req.destroy()
        reject(new SkillEndpointError(413, `上传内容超过上限 ${Math.floor(maxBytes / 1048576)} MB`))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => { resolve(new Uint8Array(Buffer.concat(chunks))) })
  })
}

/** 读取 Bearer 令牌;缺失或格式不符为 undefined(catalog 端点据此区分匿名)。 */
function readBearerToken(req: import('node:http').IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length)
  return token === '' ? undefined : token
}

/**
 * 治理端点登录闸门:经 platform-user seam 对员工 JWT 做 JWKS 本地验签 +
 * 治理记录读取,失败一律 401(校验细节进日志不进响应)。platform-user
 * 服务缺失(误配置)同样 401。
 */
async function requireEmployeeJwt(ctx: Context, token: string | undefined): Promise<void> {
  if (token === undefined) {
    throw new SkillEndpointError(401, '缺少 Authorization: Bearer 登录凭证')
  }
  const platformUsers = ctx.get('platformUsers')
  if (platformUsers === undefined) {
    throw new SkillEndpointError(401, '登录凭证校验服务不可用')
  }
  await platformUsers.getUserByToken(token).catch((error: unknown) => {
    ctx.logger.warn('skill-sync: 治理端点 JWT 校验失败', error)
    throw new SkillEndpointError(401, '登录凭证无效或已过期')
  })
}

/**
 * 即时安装端点(`POST /api/enterprise/skills/ensure`)处理器:请求体
 * `{ names: string[] }`,响应 `{ missing: string[] }`(同步后仍不可用的
 * skill 裸名,调用方走降级提示)。names 元素超出 skill 裸名值域时 400。
 * 待办场景的既有语义:无 JWT 闸门(依赖 loopback 面)。
 */
async function dispatchEnsure(
  service: SkillSyncService,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  let names: readonly string[]
  try {
    const parsed = await readJsonBody(req) as { names?: unknown }
    if (!Array.isArray(parsed.names)
      || parsed.names.some(name => typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name))) {
      throw new Error('names 必须为 skill 裸名数组(每项匹配 [A-Za-z0-9][A-Za-z0-9._-]*)')
    }
    names = parsed.names
  } catch (error) {
    sendJson(res, 400, { error: errorText(error) })
    return
  }
  const missing = await service.ensureInstalled(names)
  sendJson(res, 200, { missing })
}

/**
 * `/api/enterprise/skills` 前缀的治理路由分发:
 *
 * | 端点 | 方法 | 请求体 | 响应 |
 * |---|---|---|---|
 * | `ensure` | POST | `{ names }` | `{ missing }`(无 JWT 闸门,见 dispatchEnsure) |
 * | `catalog` | GET | - | `SkillCatalog`(匿名可读,见下) |
 * | `install` | POST | `{ namespace, slug }` | `{ alreadyInstalled }`(匿名可装) |
 * | `uninstall` | POST | `{ slug }` | `{}`(匿名可卸) |
 * | `import` | POST | zip 原始字节 | `{ name }`(匿名可导入) |
 *
 * 认证模型:安装的认证由服务器配置的 `skillhubToken` 承担,zip 导入与卸载是
 * 员工抽屉目录上的本机 loopback 操作,三者均与员工登录无关,不设 JWT 闸门
 * (`required` 的卸载保护由服务层账本判定,不靠 JWT)。ensure 无 JWT 闸门
 * (依赖 loopback 面)。catalog 允许匿名浏览:无 token 视为匿名(响应
 * authenticated=false,local 不含 required 条目),携带 token 则照常校验——
 * 无效凭证 401 而非降级匿名(fail loud)。`SkillEndpointError` 映射自带
 * 状态码,其余异常按 500 报告。
 */
async function dispatchSkillRoute(
  service: SkillSyncService,
  ctx: Context,
  method: string,
  urlPath: string,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const segments = urlPath.slice(SKILL_ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
  if (method === 'POST' && segments === 'ensure') {
    await dispatchEnsure(service, req, res)
    return
  }
  switch (`${method} ${segments}`) {
    case 'GET catalog':
    case 'POST install':
    case 'POST uninstall':
    case 'POST import':
      break
    default:
      sendJson(res, 404, { error: `no route for ${method} ${urlPath}` })
      return
  }
  const token = readBearerToken(req)
  if (segments === 'catalog') {
    const authenticated = token !== undefined
    if (authenticated) await requireEmployeeJwt(ctx, token)
    sendJson(res, 200, await service.listCatalog(authenticated))
    return
  }
  if (segments === 'import') {
    sendJson(res, 200, await service.importSkillZip(await readBytesBody(req, MAX_IMPORT_UPLOAD_BYTES)))
    return
  }
  if (segments === 'install') {
    let installBody: Record<string, unknown>
    try {
      installBody = await readJsonBody(req) as Record<string, unknown>
    } catch (error) {
      sendJson(res, 400, { error: errorText(error) })
      return
    }
    const { namespace, slug } = installBody
    if (typeof namespace !== 'string' || namespace === ''
      || typeof slug !== 'string' || !SKILL_NAME_PATTERN.test(slug)) {
      sendJson(res, 400, { error: 'namespace 必须为非空字符串,slug 必须为 skill 裸名([A-Za-z0-9][A-Za-z0-9._-]*)' })
      return
    }
    sendJson(res, 200, await service.installFromSkillhub(namespace, slug))
    return
  }
  // 剩余唯一路由:POST uninstall(匿名可卸:员工抽屉是本机自治目录,
  // required 保护由服务层 state 判定,不靠 JWT)
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req) as Record<string, unknown>
  } catch (error) {
    sendJson(res, 400, { error: errorText(error) })
    return
  }
  const { slug } = body
  if (typeof slug !== 'string' || !SKILL_NAME_PATTERN.test(slug)) {
    sendJson(res, 400, { error: 'slug 必须为 skill 裸名([A-Za-z0-9][A-Za-z0-9._-]*)' })
    return
  }
  await service.uninstallSkill(slug)
  sendJson(res, 200, {})
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Enterprise skill distribution: periodic sync plus on-demand install. */
    skillSync: SkillSyncService
  }
}

/**
 * 挂载 skill-sync:缓存目录上的 filesystem provider 注册进 `ctx.skills`
 * (不含默认根,不 watch——安装后由本插件主动 invalidate),`ctx.skillSync`
 * 服务提供周期同步与即时安装;daemon 定时器随上下文销毁清理。
 *
 * @param ctx - 携带 `skills` 与 `currentUser` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  // volatile 配置:端点持有为可变对象,loader/volatile-update 到达时原位更新,
  // 服务内每轮 sync 读到的都是当前值;intervalMs 变更额外重排 daemon 定时器。
  const endpoints: SkillSyncOptions = {
    flowableBaseUrl: '',
    skillhubBaseUrl: '',
    skillhubToken: '',
    marketNamespace: '',
    skillDir: '',
    userSkillDir: '',
  }
  let timer: ReturnType<typeof setInterval> | undefined
  const applySnapshot = (): number => {
    const flowableBaseUrl = config.flowableBaseUrl.get().replace(/\/+$/, '')
    const skillhubBaseUrl = config.skillhubBaseUrl.get().replace(/\/+$/, '')
    const skillDir = config.skillDir !== undefined && config.skillDir !== ''
      ? config.skillDir
      : dshHomePath('skill-sync', 'skills')
    const userSkillDir = config.userSkillDir !== undefined && config.userSkillDir !== ''
      ? config.userSkillDir
      : dshHomePath('skills')
    // 未配置合法化:空值是合法态(登录页是首次配置入口),不阻塞挂载;
    // sync/ensure 运行期检测到空端点时跳过并 WARN,配置后 volatile-update 生效
    if (flowableBaseUrl !== '') {
      new URL(flowableBaseUrl)
    }
    if (skillhubBaseUrl !== '') {
      new URL(skillhubBaseUrl)
    }
    endpoints.flowableBaseUrl = flowableBaseUrl
    endpoints.skillhubBaseUrl = skillhubBaseUrl
    endpoints.skillhubToken = config.skillhubToken.get()
    endpoints.skillDir = skillDir
    endpoints.userSkillDir = userSkillDir
    // 市场 namespace:cordis.yml 显式配置优先,否则回退环境变量
    // SKILL_MKTPLAC_NAMESPACE;两者都空 = 未开放市场目录。单一命名空间,
    // 逗号视为配置错误(misconfiguration fails loud)。
    const configuredNamespace = config.marketNamespace.get().trim()
    const marketNamespace = configuredNamespace !== ''
      ? configuredNamespace
      : (process.env.SKILL_MKTPLAC_NAMESPACE ?? '').trim()
    if (marketNamespace.includes(',')) {
      throw new Error('skill-sync: marketNamespace 只接受单一命名空间,逗号分隔列表不再支持')
    }
    endpoints.marketNamespace = marketNamespace
    const intervalMs = config.intervalMs.get()
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`skill-sync: intervalMs 必须为正有限数,得到 ${intervalMs}`)
    }
    return intervalMs
  }
  let providerControl: SkillProviderControl | undefined
  let provider: FileSystemSkillProvider | undefined
  const mountProvider = (): void => {
    ctx.effect(
      () => ctx.skills.registerProvider((control) => {
        providerControl = control
        provider = new FileSystemSkillProvider(ctx, control, {
          providerName: 'skill-sync',
          includeDefaultRoots: false,
          customSkillDirs: [endpoints.skillDir],
          watch: false,
        })
        return provider
      }),
      'skill-sync: cache-root skill provider',
    )
  }
  const initialIntervalMs = applySnapshot()
  mountProvider()
  ctx.effect(() => () => { void provider?.dispose() }, 'skill-sync: provider disposal')
  const service = new SkillSyncService(
    ctx,
    endpoints,
    () => providerControl,
  )
  // mkdir 失败(如 DSH_HOME 只读)不阻塞员工端启动,记日志后每轮 interval 重试
  void service.start().catch((error: unknown) => { ctx.logger.warn('skill-sync 启动失败', error) })
  const schedule = (intervalMs: number): void => {
    // clearInterval(undefined) 是安全 no-op,免掉"已有定时器"分支
    clearInterval(timer)
    timer = setInterval(() => {
      void service.sync().catch((error: unknown) => { ctx.logger.warn('skill-sync 周期同步异常', error) })
    }, intervalMs)
  }
  schedule(initialIntervalMs)
  ctx.effect(() => () => {
    clearInterval(timer)
  }, 'skill-sync: daemon interval')
  ctx.on('loader/volatile-update', () => {
    try {
      const next = applySnapshot()
      schedule(next)
      ctx.logger.info('skill-sync: 配置已更新(端点/间隔按新值生效)')
    } catch (error) {
      // 更新值非法(如 URL 残缺)时保留旧快照,只报告错误
      ctx.logger.warn('skill-sync: 配置更新被拒绝,沿用旧配置', error)
    }
  })
  // 登录即触发一轮同步:启动首轮通常发生在登录前,不让用户等下一个 interval
  ctx.on('platform-user/verified', () => {
    void service.sync().catch((error: unknown) => { ctx.logger.warn('skill-sync 登录触发同步异常', error) })
  }, { global: true })
  // 治理端点(待办 ensure + 技能库 catalog/install/uninstall/import):
  // dispatchSkillRoute 负责 JWT 闸门、参数校验与业务错误映射
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: SKILL_ROUTE_PREFIX,
      // handler 返回分发 Promise,webserver 可等待完成(测试亦由此确定性断言)
      handler: (req, res) =>
        dispatchSkillRoute(
          service,
          ctx,
          req.method ?? 'GET',
          new URL(req.url ?? '/', 'http://localhost').pathname,
          req,
          res,
        ).catch((error: unknown) => {
          if (error instanceof SkillEndpointError) {
            sendJson(res, error.status, { error: error.message })
            return
          }
          ctx.logger.warn('skill-sync: 治理端点异常', error)
          if (!res.headersSent) {
            sendJson(res, 500, { error: errorText(error) })
          }
        }),
    }),
  'skill-sync: /api/enterprise/skills prefix route',
  )
}
