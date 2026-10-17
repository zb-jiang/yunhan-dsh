/**
 * 企业流程工作台控制器:待办/已完成列表 store、任务↔会话绑定、打开/提交编排。
 *
 * <p>待办队列侧栏(原生 sidebar 的 nav 座位)与档案栏都从这里读数据:任务列表经
 * /dsh/tasks 代理拉取,已完成列表经 /dsh/history/tasks 持久查询(刷新后仍在);
 * 每个待办首次点击时经 SessionsCreatePort 新建专属 DSH 会话并绑定,再次点击回到
 * 原会话。userPrompt 预填走 conversation.input 的草稿写路径,仅在草稿为空时填入,
 * 不覆盖员工已编辑的内容;预填失败原因记入 prefillNotice(侧栏提示,便于诊断);
 * 提交完成后解绑进行中绑定、记录回执并刷新队列;知识库归属保留(应用 id
 * 随回执固化进持久化条目),已完成会话继续注入 kb 块、选择器入口继续可用。
 * 打开待办前先经 skill-sync 的即时安装
 * 端点确保 dshMeta.skillRefs 就绪(仍缺失走 skillNotice 降级提示,不阻断会话;
 * skill-repo-design §7)。
 *
 * <p>任务会话仍处草稿期(未发送过消息、输入框已清空)时,员工在对话区顶部切换
 * 目录后重新点击待办,绑定会迁移到新工作区的当前空白会话(原生目录切换已把草稿
 * 与图片移交过去,认领即跟随);已有对话历史的任务会话不迁移,点击待办回到原会话
 * (历史留在原地可达)。
 *
 * <p>首次点击未绑定待办不再自动挑选工作区:进入"选择工作空间"弹窗,由员工显式
 * 选定并确认(弹窗明示选定后不可修改)后才新建专属会话并绑定;取消或未确认时不
 * 产生任何会话,可反复重新选择。绑定(含草稿期迁移后的重绑)写入 localStorage,
 * 刷新后回到原会话,不再产生孤儿会话。
 *
 * <p>绑定状态刻意用普通对象而非 Map/Set:快照存储引擎经 immer produce 起草,
 * 而运行时导入的 immer 未启用 MapSet 插件,Map 草稿在首次变更时抛
 * "[Immer] minified error nr: 0"。已完成任务的会话映射另存 localStorage,
 * 页面刷新后仍能回到原会话;任务档案经 rightbar 标签页系统呈现
 * (openTask/openCompletedTask 打开 ARCHIVE_TAB_KIND 标签页)。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { completeTask, ensureSkills, getCompletedTasks, getMyTasks } from './task-api.ts'
import type { CompletedTask, Task } from './task-api.ts'
import { INSTANCE_FILES_TAB_KIND } from './instance-files-tab.ts'
import { reportSessionWorkspaceContext } from './instance-workspace-api.ts'
import { reportSessionKb, type SessionKbEntry } from './kb-session-report.ts'

/**
 * 跨域会话端口的最小创建面:运行时的 SessionRuntime 同时满足 ISessions
 * (UI 公开面,刻意不暴露 create——"New Session"走 workspaces 的空白会话
 * 复用)与 SessionsPort(跨域面,含 create),装配与测试注入处已做结构
 * 校验。任务绑定需要"新建不复用"的会话(connectWorkspace 的复用会把上
 * 一个任务的残留草稿和绑定错交给下一个任务),因此经此结构化断言取实
 * 现上的 create。断言完全留在企业包内,上游契约零改动。
 */
type SessionsCreatePort = {
  create(opts: { workspaceId: WorkspaceId }): Promise<SessionId>
}

/**
 * SidebarRight 控制器的 Tab 域端口:openTabIn 直接写目标会话自己的 adopted
 * store(openContent 自带展开与 surface 物化),与"哪个座位正挂载"完全解耦
 * ——公开面 ISidebarRight.openTab 只作用于当前挂载座位,切换会话的瞬间会
 * 把标签写进上一个会话的表面。与 SessionsCreatePort 同思路的结构化断言:
 * 断言留在企业包内,上游契约零改动。
 */
type SidebarRightTabDomainPort = {
  openTabIn(sessionId: SessionId, kind: string): void
}

/** 待办队列状态(侧栏与档案栏共享)。 */
export type WorkbenchTasksState = {
  items: readonly Task[]
  /** 已完成历史任务(引擎持久数据,侧栏"已完成"分组)。 */
  completed: readonly CompletedTask[]
  loading: boolean
  error: string | null
  /** 最近一次预填失败的诊断提示;null = 成功或未触发(侧栏细提示)。 */
  prefillNotice: string | null
  /** 档案栏正在只读查看的已完成任务(无本地会话时的回看入口)。 */
  selectedCompleted: CompletedTask | null
  /**
   * 等待员工在"选择工作空间"弹窗中确认的待办(首次点击未绑定待办时置入;
   * 确认/取消后清空)。null = 无待确认任务。
   */
  pendingTask: Task | null
  /** 正在确保待办 skill 就绪(打开待办前的即时安装窗口;侧栏提示+防连点)。 */
  skillPreparing: boolean
  /** 最近一次 skill 就绪失败的降级提示;null = 无失败或未触发(侧栏提示)。 */
  skillNotice: string | null
}

/** 已提交完成任务的档案记录(解绑后档案栏的"已完成"回执)。 */
export type CompletedTaskRecord = {
  /** 引擎任务 id(与历史任务 id 一致;据此在已完成列表定位完整档案数据)。 */
  taskId: string
  taskName: string
  submittedAt: number
  /** 流程所属应用 id;提交时从 Task.applicationId 固化(历史任务无此字段,kb 注入与选择器入口凭此解析)。 */
  applicationId: string | null
}

/** 任务↔会话绑定状态(普通对象 + immer 核心 draft 路径;见模块文档)。 */
export type WorkbenchBindingsState = {
  /** taskId → 绑定会话 id。 */
  taskToSession: Record<string, SessionId>
  /** sessionId → 绑定任务 id(反向索引)。 */
  sessionToTask: Record<string, string>
  /** sessionId → 已提交完成任务记录。 */
  completedBySession: Record<string, CompletedTaskRecord>
  /** taskId → 提交时所在会话(已完成任务回看本地会话的入口)。 */
  completedByTask: Record<string, SessionId>
}

/** localStorage 键:已完成任务的会话映射(刷新后回看聊天历史的入口)。 */
const COMPLETED_SESSIONS_KEY = 'dsh-enterprise-completed-sessions'

/** 已完成任务→会话的持久化条目:应用归属在提交时固化,webserver 重启后 kb 归属重放仍可用。 */
export type CompletedSessionEntry = {
  sessionId: SessionId
  /** 提交时的 Task.applicationId;旧版本持久化条目缺此信息,记 null(kb 归属重放跳过)。 */
  applicationId: string | null
}

/** 读取持久化的已完成任务→会话映射;无存储或条目损坏按空处理,旧版字符串值兼容为无归属条目。 */
function loadCompletedSessions(): Record<string, CompletedSessionEntry> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(COMPLETED_SESSIONS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const entries: Record<string, CompletedSessionEntry> = {}
    for (const [taskId, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 旧版格式值为纯会话 id 字符串;新版为 { sessionId, applicationId }。
      if (typeof value === 'string') {
        entries[taskId] = { sessionId: value as SessionId, applicationId: null }
      } else if (typeof value === 'object' && value !== null
        && typeof (value as { sessionId?: unknown }).sessionId === 'string') {
        const appId = (value as { applicationId?: unknown }).applicationId
        entries[taskId] = {
          sessionId: (value as { sessionId: string }).sessionId as SessionId,
          applicationId: typeof appId === 'string' ? appId : null,
        }
      }
    }
    return entries
  } catch {
    // localStorage 条目损坏(JSON 解析失败):按无映射处理,已完成任务
    // 退化为只读档案视图,不阻断工作台。
    return {}
  }
}

/** 写回持久化映射;存储不可写(私隐模式/配额)时仅内存生效。 */
function saveCompletedSessions(map: Record<string, CompletedSessionEntry>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COMPLETED_SESSIONS_KEY, JSON.stringify(map))
  } catch {
    // 写失败只损失刷新后的回看入口,内存映射当次会话仍有效。
  }
}

/** localStorage 键:进行中任务的会话绑定(刷新后回到原会话)。 */
const TASK_SESSIONS_KEY = 'dsh-enterprise-task-sessions'

/** 读取持久化的进行中任务→会话绑定;无存储或条目损坏按空处理。 */
function loadTaskSessions(): Record<string, SessionId> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(TASK_SESSIONS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Record<string, SessionId>
  } catch {
    // localStorage 条目损坏(JSON 解析失败):按无绑定处理,待办重新走
    // 工作空间选择弹窗,不阻断工作台。
    return {}
  }
}

/** 写回持久化的进行中任务绑定;存储不可写(私隐模式/配额)时仅内存生效。 */
function saveTaskSessions(map: Record<string, SessionId>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(TASK_SESSIONS_KEY, JSON.stringify(map))
  } catch {
    // 写失败只损失刷新后的绑定恢复,内存绑定当次会话仍有效。
  }
}

/** 控制器依赖的六个跨插件服务面。 */
export interface WorkbenchDeps {
  readonly sessions: ISessions
  readonly workspaces: IWorkspaces
  /** 会话导航面(官方 ui-workspace):openSession/startSession 是官方重构后主区切换的唯一入口。 */
  readonly uiWorkspace: UiWorkspace
  readonly layout: ILayout
  readonly conversation: IConversation
  readonly sidebarRight: ISidebarRight
}

/** 任务档案标签页的类型标识(rightbar 标签页系统 openTab 的 kind)。 */
export const ARCHIVE_TAB_KIND = 'dsh-enterprise-archive'

/** 任务档案标签页实现的注册 id(stage-two keyed 座位的 key)。 */
export const ARCHIVE_TAB_ID = '@deepseek-ai/dsh-client-ui-enterprise/archive'

/** "浏览本地文件夹"选目录的结果(WorkspacePickerDialog 据此更新选中/提示)。 */
export type WorkspacePickResult =
  | { status: 'picked'; workspaceId: WorkspaceId }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

/**
 * 工作台编排器。apply 时构造一次,经各插槽 inject 面闭包分发;
 * 状态面是纯 observable store,组件用 useSyncExternalStore 订阅。
 */
export class EnterpriseWorkbench {
  /** 待办队列(所有列表展示的单一数据源)。 */
  readonly tasks: SnapshotStore<WorkbenchTasksState>
  /** 任务↔会话绑定(高亮与档案归属)。 */
  readonly bindings: SnapshotStore<WorkbenchBindingsState>
  /** 已完成任务→会话的持久映射(刷新后回看聊天历史)。 */
  private readonly completedSessions: Record<string, CompletedSessionEntry>
  /** 已完成预填的任务 id(避免切回任务时重复覆盖草稿)。 */
  private readonly prefilledTasks = new Set<string>()
  /**
   * 已武装的档案栏补开(至多一个;新目标替换旧目标并退订,无定时器):
   * openTabIn 需要 adopted store,而会话视图被剪枝后重建的瞬间 store 尚未
   * 创建(座位渲染才创建),此时直接调用是静默 no-op——等 mounted 发布
   * 目标会话后重放一次。undefined = 无待补开。
   */
  private archiveReplay: {
    target: SessionId | undefined
    /** 补开序列是否含实例空间标签页(与发起次 openArchiveTab 的实参一致)。 */
    withInstanceFiles: boolean
    unsubscribe(): void
  } | undefined
  /**
   * 导航序号(single-flight):openTask 的 ensureSkillsReady 与建会话是
   * 异步缺口,期间用户的新点击(待办/已完成/确认)应使旧点击的续跑作废,
   * 否则迟到的 openSession 会把主区又切回去。每个导航入口先自增,await 后
   * 比对,不一致即放弃本次导航动作。
   */
  private navigationSeq = 0
  private readonly deps: WorkbenchDeps

  /**
   * @param deps - 跨插件服务面(sessions/workspaces/layout/conversation)。
   */
  constructor(deps: WorkbenchDeps) {
    this.deps = deps
    this.tasks = createSnapshotStore<WorkbenchTasksState>({
      items: [], completed: [], loading: false, error: null,
      prefillNotice: null, selectedCompleted: null, pendingTask: null,
      skillPreparing: false, skillNotice: null,
    })
    // 刷新恢复:持久化的进行中绑定先入 store(反向索引同步重建),绑定会话
    // 已被删除时 openTask 的存续检查会退回工作空间选择弹窗。
    const persistedTasks = loadTaskSessions()
    const persistedReverse: Record<string, string> = {}
    for (const [taskId, sessionId] of Object.entries(persistedTasks)) {
      persistedReverse[sessionId] = taskId
    }
    this.bindings = createSnapshotStore<WorkbenchBindingsState>({
      taskToSession: persistedTasks, sessionToTask: persistedReverse,
      completedBySession: {}, completedByTask: {},
    })
    this.completedSessions = loadCompletedSessions()
  }

  /** 拉取当前用户待办与已完成列表(侧栏挂载与手动刷新共用)。 */
  async refresh(): Promise<void> {
    this.tasks.update((draft) => {
      draft.loading = true
      draft.error = null
    })
    try {
      const [items, completed] = await Promise.all([getMyTasks(), getCompletedTasks()])
      this.tasks.update((draft) => {
        draft.items = items
        draft.completed = completed
        draft.loading = false
        draft.error = null
      })
      // 任务列表就绪后重放持久绑定的会话归属:覆盖初始化与 webserver 重启自愈。
      this.replaySessionKbReports()
      // 实例空间绑定同样重放(仅进行中绑定;pull 端点与每轮注入据此自愈)。
      this.replaySessionWorkspaceReports()
    } catch (e) {
      this.tasks.update((draft) => {
        draft.loading = false
        draft.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  /**
   * 打开一个待办:先确保 skillRefs 就绪(即时安装,降级不阻断;见
   * ensureSkillsReady),然后回到已绑定会话;未绑定时进入"选择工作空间"
   * 弹窗(pendingTask 置位,由 TaskQueueSidebar 渲染),员工显式选定并
   * 确认后才经 confirmPendingTaskWorkspace 新建专属会话并预填任务指令。
   * 建会话走 createTaskSession(每任务一个干净会话;connectWorkspace
   * 会复用工作区的空白会话,其残留草稿会拦截预填且多任务会错绑到同一会话)。
   * 预填失败原因记入 prefillNotice 供侧栏提示。
   * @param task - 队列中选中的待办。
   */
  async openTask(task: Task): Promise<void> {
    const seq = ++this.navigationSeq
    this.note(`openTask ${task.id} seq=${seq}`)
    this.tasks.update((draft) => { draft.selectedCompleted = null })
    // 工作项 3:先确保 skillRefs 就绪再进入会话(已就绪时是纯本地目录检查,无出站)
    await this.ensureSkillsReady(task)
    // single-flight:等待就绪期间用户又触发了其它导航,本次点击作废,
    // 不再把主区切回旧任务(乱序续跑是"点着点着档案栏错乱"的放大器)。
    if (seq !== this.navigationSeq) {
      this.note(`openTask ${task.id} superseded (seq=${seq} < ${this.navigationSeq})`)
      return
    }
    const bound = this.bindings.getSnapshot().taskToSession[task.id]
    if (bound !== undefined && this.deps.sessions.list.getSnapshot().byId[bound] !== undefined) {
      const sessionId = bound
      const prefillNotice = this.prefillPrompt(task, sessionId)
      this.tasks.update((draft) => { draft.prefillNotice = prefillNotice })
      this.note(`openTask ${task.id} -> session ${sessionId}`)
      this.deps.uiWorkspace.openSession(sessionId)
      this.openArchiveTab(sessionId, true)
      return
    }
    // 未绑定(首次点击,或持久绑定对应的会话已不存在):交给员工显式
    // 选择工作空间,不自动挑选、不预建会话;取消前不产生任何绑定。
    this.tasks.update((draft) => { draft.pendingTask = task })
  }

  /**
   * 员工在"选择工作空间"弹窗中确认后调用:在选定工作区新建专属会话、
   * 建立绑定(含 localStorage 持久化)、预填任务指令并进入会话与档案栏。
   * 建会话失败时保留弹窗(pendingTask 不清空),员工可重试或取消。
   * @param workspaceId - 员工在弹窗中选定的工作区。
   */
  async confirmPendingTaskWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const task = this.tasks.getSnapshot().pendingTask
    if (task === null) return
    const seq = ++this.navigationSeq
    const sessionId = await this.createTaskSession(workspaceId)
    if (sessionId === undefined) return
    this.bind(task.id, sessionId)
    this.reportSessionApp(sessionId, task.applicationId)
    this.reportSessionWorkspace(sessionId, task.processInstanceId)
    const prefillNotice = this.prefillPrompt(task, sessionId)
    this.tasks.update((draft) => {
      // 只清自己置入的弹窗任务:等待建会话期间用户可能又点击了其它未绑定
      // 待办(新的 pendingTask),不能一并清掉。
      if (draft.pendingTask?.id === task.id) draft.pendingTask = null
      draft.prefillNotice = prefillNotice
    })
    // single-flight:等待建会话期间有更新导航时,会话与绑定保留(员工显式
    // 确认的产物,不绑就成了孤儿),但不再抢主区与档案栏。
    if (seq !== this.navigationSeq) return
    this.note(`confirm ${task.id} -> session ${sessionId}`)
    this.deps.uiWorkspace.openSession(sessionId)
    this.openArchiveTab(sessionId, true)
  }

  /** 员工取消"选择工作空间"弹窗:清空待确认任务,不产生会话与绑定。 */
  cancelPendingTask(): void {
    if (this.tasks.getSnapshot().pendingTask === null) return
    this.tasks.update((draft) => { draft.pendingTask = null })
  }

  /**
   * 弹窗内"浏览本地文件夹"入口:打开宿主目录选择器(桌面版是 OS 原生
   * 文件夹对话框,Web 端由 in-app browse 后端承接),选定后把该路径注册为
   * 新工作区(Host 幂等:路径已注册时返回既有工作区)并返回其 id,弹窗随之
   * 选中新工作区,员工仍需显式确认才建会话绑定。
   * @returns picked 携带新建(或既有)工作区 id;cancelled 为员工取消选择;
   *          error 携带可供弹窗展示的失败原因。
   */
  async pickNewWorkspace(): Promise<WorkspacePickResult> {
    let path: string | null
    try {
      path = await this.deps.uiWorkspace.pickDirectory()
    } catch (error: unknown) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    if (path === null) return { status: 'cancelled' }
    try {
      const workspace = await this.deps.workspaces.create({ path })
      return { status: 'picked', workspaceId: workspace.workspaceId }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return { status: 'error', message: `注册工作区失败:${detail}` }
    }
  }

  /**
   * 打开一个已完成任务:提交时的会话(内存映射或 localStorage 持久映射)
   * 还活着则回到该会话并补全完成回执;否则回到「新会话」UI(不残留上一个
   * 会话的内容),并在档案栏只读展示引擎历史(任务信息/完成时间/变量/执行路径)。
   * @param task - 侧栏"已完成"分组中选中的历史任务。
   */
  openCompletedTask(task: CompletedTask): void {
    // 同步入口也推进导航序号:使等待中的 openTask/确认续跑作废。
    this.navigationSeq++
    this.note(`openCompletedTask ${task.id} seq=${this.navigationSeq}`)
    const memory = this.bindings.getSnapshot().completedByTask[task.id]
    const persisted = this.completedSessions[task.id]
    const sessionId = memory ?? persisted?.sessionId
    if (sessionId !== undefined && this.deps.sessions.list.getSnapshot().byId[sessionId] !== undefined) {
      this.tasks.update((draft) => { draft.selectedCompleted = null })
      // 刷新后内存回执丢失时从历史任务补全,档案栏才能渲染完成回执;
      // 应用归属取提交时固化的持久化条目(历史任务数据无此字段)。
      this.bindings.update((draft) => {
        if (draft.completedBySession[sessionId] === undefined) {
          draft.completedBySession[sessionId] = {
            taskId: task.id,
            taskName: task.name ?? task.id,
            submittedAt: task.endTime !== null ? (Date.parse(task.endTime) || Date.now()) : Date.now(),
            applicationId: persisted?.applicationId ?? null,
          }
        }
        draft.completedByTask[task.id] = sessionId
      })
      this.deps.uiWorkspace.openSession(sessionId)
      this.openArchiveTab(sessionId)
    } else {
      this.tasks.update((draft) => { draft.selectedCompleted = task })
      // 关联会话已不存在(本地会话被清理):回「新会话」UI,不残留上一个会话
      // 的内容;startSession 异步建会话,此时 mounted 仍是旧会话,不能走
      // openArchiveTab(undefined)(会把档案标签写进旧会话),直接武装补开,
      // 新会话挂载后档案标签落到新会话表面。
      this.deps.uiWorkspace.startSession()
      this.armArchiveReplay(undefined, false)
    }
  }

  /**
   * 打开目标会话的实例空间标签页(树上云上传成功后的「打开实例空间」跳转)。
   * 调用场景是用户正看着该会话的文件标签页,座位必然已挂载、openTabIn
   * 必然落地(无 openArchiveTab 的时序缺口)。
   * @param sessionId - 目标会话(即当前文件标签页所在会话)。
   */
  openInstanceFilesTab(sessionId: SessionId): void {
    this.archiveTabPort.openTabIn(sessionId, INSTANCE_FILES_TAB_KIND)
  }

  /**
   * 打开任务档案标签页,并保证它落在目标会话的 rightbar 表面上。
   *
   * <p>经 openTabIn 直接写目标会话自己的 adopted store(openContent 自带
   * planSetExpanded(true) 与 surface 物化):座位挂没挂载、挂的是谁,都不
   * 影响写入落点——旧实现经公开面 openTab(require() 取当前挂载座位的绑定),
   * 切换会话的瞬间会把标签与展开写进上一个会话的表面;后来改为"等 mounted
   * 发布目标会话再 openTab"的订阅式修复,又因每次点击挂独立订阅、互不取消、
   * 3 秒超时静默放弃,在快速来回切换时留下错位的展开残留(按钮与面板一起
   * 消失,刷新才恢复)。
   *
   * <p>仅剩一个时序缺口:目标会话的视图被剪枝后重建的瞬间,store 实例尚未
   * 创建(座位渲染才创建,adoption 随之),openTabIn 静默 no-op——由
   * armArchiveReplay 在 mounted 发布目标会话后补开一次(单订阅、可替换、
   * 无定时器,见该方法文档)。
   *
   * @param target - 要显示档案栏的会话;undefined 表示落到当前已挂载会话
   *   (只读档案路径:不切换会话,当前会话即可)。
   * @param withInstanceFiles - 是否同时打开实例空间标签页(绑定待办的会话为
   *   true:先开实例空间、后开档案,后开者保持激活——进入待办默认看档案);
   *   只读档案与已完成会话路径保持 false,实例空间标签页只在进行中绑定出现。
   */
  private openArchiveTab(target: SessionId | undefined, withInstanceFiles = false): void {
    const mounted = this.deps.sidebarRight.mounted.getSnapshot()
    if (target !== undefined) {
      this.note(`archiveTab target=${target} mounted=${mounted ?? 'none'}`)
      if (withInstanceFiles) this.archiveTabPort.openTabIn(target, INSTANCE_FILES_TAB_KIND)
      this.archiveTabPort.openTabIn(target, ARCHIVE_TAB_KIND)
      this.armArchiveReplay(target, withInstanceFiles)
      return
    }
    // 只读档案路径:落到当前挂载的会话;尚无挂载会话时等第一个座位发布。
    if (mounted !== undefined) {
      this.note(`archiveTab read-only mounted=${mounted}`)
      this.archiveTabPort.openTabIn(mounted, ARCHIVE_TAB_KIND)
      return
    }
    this.note('archiveTab read-only awaiting first seat')
    this.armArchiveReplay(undefined, false)
  }

  /**
   * 武装档案栏补开(同一时刻至多一个;新目标替换旧目标并退订)。
   *
   * <p>与旧订阅式修复的差别:订阅全局唯一、可被后续点击替换、无 3 秒超时
   * ——不会积累悬挂订阅,也没有"超时后放弃、残留展开状态"的路径。目标
   * 会话在补开前又来了新点击时,新目标直接替换旧目标(旧订阅退订)。目标
   * 会话一直不挂载时,订阅静默闲置:仅在 mounted 恰好变成该会话时才补开,
   * 而那正是当初点击想要的语义。
   */
  private armArchiveReplay(target: SessionId | undefined, withInstanceFiles: boolean): void {
    if (this.archiveReplay !== undefined && this.archiveReplay.target === target
      && this.archiveReplay.withInstanceFiles === withInstanceFiles) return
    if (this.archiveReplay !== undefined) this.note(`replay replace ${String(this.archiveReplay.target)} -> ${target ?? 'any'}`)
    this.archiveReplay?.unsubscribe()
    const mounted = this.deps.sidebarRight.mounted
    const unsubscribe = mounted.subscribe(() => {
      const now = mounted.getSnapshot()
      if (now === undefined) return
      if (target !== undefined && now !== target) return
      this.archiveReplay = undefined
      unsubscribe()
      this.note(`replay fire target=${target ?? 'any'} mounted=${now}`)
      // 此刻目标会话的座位已挂载,store 实例必已创建,openTabIn 必然落地。
      // 与发起次同序:先实例空间、后档案(后开者激活)。
      if (withInstanceFiles) this.archiveTabPort.openTabIn(now, INSTANCE_FILES_TAB_KIND)
      this.archiveTabPort.openTabIn(now, ARCHIVE_TAB_KIND)
    })
    this.archiveReplay = { target, withInstanceFiles, unsubscribe }
  }

  /** SidebarRight 控制器的 Tab 域端口(结构化断言;见 SidebarRightTabDomainPort)。 */
  private get archiveTabPort(): SidebarRightTabDomainPort {
    return this.deps.sidebarRight as ISidebarRight & SidebarRightTabDomainPort
  }

  /**
   * 导航/档案事件面包屑(环形,卡死诊断用):卡死形态是跨组件状态机脱节,
   * 事后无法从现场反推时序——所有会改变"哪个会话挂载/档案栏何时开"的路径
   * 都在此留痕,哨兵发现卡死时随日志倾倒。
   */
  private breadcrumbs: string[] = []
  private note(event: string): void {
    const at = new Date()
    const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}.${String(at.getMilliseconds()).padStart(3, '0')}`
    this.breadcrumbs.push(`${stamp} ${event}`)
    if (this.breadcrumbs.length > 20) this.breadcrumbs.shift()
  }

  /** 卡死哨兵状态。 */
  private stuckCheckTimer: ReturnType<typeof setTimeout> | undefined
  private stuckSeatGraceTimer: ReturnType<typeof setTimeout> | undefined
  private stuckPollTimer: ReturnType<typeof setInterval> | undefined
  /** "右边栏不可达"形态首次发现时刻(连续两个轮询周期才定性,防瞬时误报)。 */
  private unreachableSeenAt: number | undefined
  private lastHealAt = 0

  /**
   * 右边栏卡死哨兵 v3:两轮修复都没能根除"按钮+面板一起消失",与其继续盲改,
   * 不如把卡死状态变成可观测、可自愈的——
   *
   * <p>形态零(DOM 级"不可达",v3 新增):主会话在选、无全局面板,但 DOM 里
   * 既没有展开按钮([data-sidebar-right-expand])也没有可见的右栏会话座位
   * ([data-sidebar-right-session]:not([hidden]))——用户从任何入口都打不开
   * 右边栏。该谓词不依赖任何内部可观测面(mounted/isExpanded 对"视图选中
   * 与主区脱钩"类卡死全部失明),纯 DOM 取证,任何形态都逃不掉。轮询 2 秒
   * 且需连续命中才定性(开合过渡/懒挂载不会误报);定性后倾倒现场并尝试
   * 自愈(重新 openSession + openTabIn,均为幂等公开面)。
   *
   * <p>形态一(可自愈):座位已挂载 + surface 展开 + frame 轨道收起,自愈为
   * layout.openRightbar(true,false),冷却 1.5 秒。
   *
   * <p>形态二(只记日志):主会话已选中但 600ms 后座位仍未挂载。
   *
   * <p>驱动:mounted/panelInfo 订阅(250ms 去抖)+ 2 秒轮询兜底——若卡死发生在
   * 最后一次事件之后且状态不再变化,订阅驱动永远不会再触发,轮询是唯一的
   * 收口。启动时打横幅证明新 bundle 已生效,并挂 window.__yunhanRightbar()
   * 手动取证入口。
   * @returns 解除哨兵的清理函数(挂载到 ctx.effect)。
   */
  armStuckSentinel(): () => void {
    console.info('[yunhan] 右边栏哨兵 v3 已布防;卡死取证可调 window.__yunhanRightbar()')
    const mounted = this.deps.sidebarRight.mounted
    const panelInfo = this.deps.layout.panelInfo
    const schedule = (): void => {
      if (this.stuckCheckTimer !== undefined) return
      this.stuckCheckTimer = setTimeout(() => {
        this.stuckCheckTimer = undefined
        this.evaluateStuck()
      }, 250)
    }
    const unsubscribeMounted = mounted.subscribe(schedule)
    const unsubscribePanel = panelInfo.subscribe(() => {
      this.note(`panel -> ${panelInfo.getSnapshot().activePanelId ?? 'null'}`)
      schedule()
    })
    this.stuckPollTimer = setInterval(() => { this.evaluateStuck() }, 2000)
    if (typeof window !== 'undefined') {
      ;(window as unknown as Record<string, unknown>).__yunhanRightbar = () => {
        const dump = this.dumpRightbarState('manual')
        console.log('[yunhan] 右边栏状态(手动取证)', dump)
        return dump
      }
    }
    schedule()
    return () => {
      unsubscribeMounted()
      unsubscribePanel()
      if (this.stuckCheckTimer !== undefined) { clearTimeout(this.stuckCheckTimer); this.stuckCheckTimer = undefined }
      if (this.stuckSeatGraceTimer !== undefined) { clearTimeout(this.stuckSeatGraceTimer); this.stuckSeatGraceTimer = undefined }
      if (this.stuckPollTimer !== undefined) { clearInterval(this.stuckPollTimer); this.stuckPollTimer = undefined }
      this.unreachableSeenAt = undefined
    }
  }

  /** 右边栏现场快照(哨兵日志与手动取证共用):内部可观测面 + DOM 取证。 */
  private dumpRightbarState(reason: string): Record<string, unknown> {
    const seats = typeof document === 'undefined' ? [] : [...document.querySelectorAll<HTMLElement>('[data-sidebar-right-session]')]
      .map(el => ({ session: el.dataset.sidebarRightSession, hidden: el.hidden }))
    return {
      reason,
      at: new Date().toISOString(),
      mounted: this.deps.sidebarRight.mounted.getSnapshot(),
      isExpanded: this.deps.sidebarRight.isExpanded(),
      panel: this.deps.layout.panelInfo.getSnapshot().activePanelId,
      mainSession: this.mainSessionId(),
      viewport: typeof window === 'undefined' ? undefined : window.innerWidth,
      dom: {
        expandButton: typeof document === 'undefined' ? undefined : document.querySelector('[data-sidebar-right-expand]') !== null,
        visibleSeat: seats.some(seat => !seat.hidden),
        seats,
        trackCollapsed: typeof document === 'undefined' ? undefined : document.querySelector('[data-rightbar-collapsed]') !== null,
      },
      breadcrumbs: [...this.breadcrumbs],
    }
  }

  /** 当前主区会话(官方 retain 计数是唯一可信来源)。 */
  private mainSessionId(): SessionId | undefined {
    return Object.values(this.deps.sessions.list.getSnapshot().byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  }

  /** 哨兵评估:见 armStuckSentinel。 */
  private evaluateStuck(): void {
    if (typeof document === 'undefined') return
    const mountedSession = this.deps.sidebarRight.mounted.getSnapshot()
    // 形态零(DOM 级不可达):按钮与可见座位同时缺席,且非全局面板遮挡。
    // 连续命中 2 秒才定性;定性即倾倒现场并尝试幂等自愈(重放导航意图)。
    const mainSession = this.mainSessionId()
    const panelActive = this.deps.layout.panelInfo.getSnapshot().activePanelId !== null
    const unreachable = mainSession !== undefined && !panelActive
      && document.querySelector('[data-sidebar-right-expand]') === null
      && document.querySelector('[data-sidebar-right-session]:not([hidden])') === null
    if (unreachable) {
      if (this.unreachableSeenAt === undefined) {
        this.unreachableSeenAt = Date.now()
        this.note(`unreachable? main=${mainSession}`)
        return
      }
      if (Date.now() - this.unreachableSeenAt < 2000 || Date.now() - this.lastHealAt < 1500) return
      this.unreachableSeenAt = undefined
      this.lastHealAt = Date.now()
      const detail = this.dumpRightbarState('unreachable')
      console.error('[yunhan] 右边栏不可达(按钮与面板同时消失),已尝试重放导航自愈', detail)
      this.note(`unreachable-healed main=${mainSession}`)
      // 幂等公开面重放:replaceMain 会重新 selectPanel(null),openTabIn 重新
      // 物化目标会话 surface(若 adoption 尚在)——无论脱钩在哪一层,这一对
      // 组合都是"用户点击想要的结果"的安全重放。
      this.deps.uiWorkspace.openSession(mainSession)
      this.archiveTabPort.openTabIn(mainSession, ARCHIVE_TAB_KIND)
      return
    }
    this.unreachableSeenAt = undefined
    // 形态一(可自愈):座位 active + surface 展开 + frame 轨道收起。
    if (mountedSession !== undefined && this.deps.sidebarRight.isExpanded()
      && document.querySelector('[data-rightbar-collapsed]') !== null
      && window.innerWidth >= 768) {
      if (Date.now() - this.lastHealAt > 1500) {
        this.lastHealAt = Date.now()
        const detail = this.dumpRightbarState('form1')
        console.error('[yunhan] 右边栏卡死已自动恢复(surface 展开 但 frame 轨道为 0)', detail)
        this.note(`stuck-healed mounted=${mountedSession}`)
        this.deps.layout.openRightbar(true, false)
      }
      return
    }
    // 形态二(只记日志):主会话在选但座位迟迟不挂载。
    if (mainSession !== undefined && mountedSession === undefined) {
      if (this.stuckSeatGraceTimer !== undefined) return
      this.stuckSeatGraceTimer = setTimeout(() => {
        this.stuckSeatGraceTimer = undefined
        if (this.deps.sidebarRight.mounted.getSnapshot() !== undefined) return
        const stillMain = this.mainSessionId()
        if (stillMain === undefined) return
        console.error('[yunhan] 右边栏座位 600ms 未挂载(主会话已选中)', this.dumpRightbarState('seat-missing'))
        this.note(`seat-not-mounted session=${stillMain}`)
      }, 600)
      return
    }
    if (this.stuckSeatGraceTimer !== undefined) {
      clearTimeout(this.stuckSeatGraceTimer)
      this.stuckSeatGraceTimer = undefined
    }
  }

  /**
   * 把任务指令重新填入会话输入框(档案栏"重新填入"按钮;显式操作,直接覆盖草稿)。
   * @param task - 目标待办。
   * @param sessionId - 绑定会话。
   * @returns 是否成功(无指令或会话不可达为 false)。
   */
  reinsertPrompt(task: Task, sessionId: SessionId): boolean {
    const prompt = task.dshMeta?.userPrompt
    if (prompt == null || prompt === '') return false
    const input = this.sessionInput(sessionId)
    if (input === undefined) return false
    input.setDraft(prompt)
    return true
  }

  /**
   * 提交待办:POST 变量到引擎,解绑会话,记录完成回执并刷新队列;
   * 会话映射同步写入 localStorage 供刷新后回看。
   * @param task - 目标待办。
   * @param variables - 映射后的流程上下文变量。
   * @throws 引擎拒绝时原样抛出(档案栏展示错误)。
   */
  async submitTask(task: Task, variables: Record<string, unknown>): Promise<void> {
    await completeTask(task.id, variables)
    this.unbind(task, 'completed')
    await this.refresh()
  }

  /**
   * 当前会话绑定的待办(档案栏归属判断);无绑定返回 undefined。
   * @param sessionId - 会话 id。
   * @returns 绑定的 {@link Task};无绑定时 undefined。
   */
  taskOfSession(sessionId: SessionId): Task | undefined {
    const taskId = this.bindings.getSnapshot().sessionToTask[sessionId]
    if (taskId === undefined) return undefined
    return this.tasks.getSnapshot().items.find(item => item.id === taskId)
  }

  /** 侧栏窄轨展开(layout 面宽切换;与原生侧栏 toggle 同一动作)。 */
  expandSidebar(): void {
    this.deps.layout.toggleSidebar()
  }

  /** 退出已完成任务的只读档案视图(切换会话时由档案栏调用)。 */
  clearSelectedCompleted(): void {
    if (this.tasks.getSnapshot().selectedCompleted === null) return
    this.tasks.update((draft) => { draft.selectedCompleted = null })
  }

  /**
   * 确保待办的 skillRefs 就绪(skill-repo-design §7):已就绪时纯本地目录
   * 检查,缺失时触发即时同步安装。检查/安装期间置 skillPreparing(侧栏
   * 提示+防连点);仍缺失或请求失败只记 skillNotice 走降级提示,不阻断
   * 会话创建(AI 会话照常进行,仅 skill 工具调不到该技能)。
   * @param task - 即将打开的待办。
   */
  private async ensureSkillsReady(task: Task): Promise<void> {
    const names = task.dshMeta?.skillRefs ?? []
    const unique = [...new Set(names.filter(name => name !== ''))]
    if (unique.length === 0) {
      // 无 skillRefs 的任务不受上一次降级提示影响(清残留)
      if (this.tasks.getSnapshot().skillNotice !== null) {
        this.tasks.update((draft) => { draft.skillNotice = null })
      }
      return
    }
    this.tasks.update((draft) => { draft.skillPreparing = true })
    try {
      const missing = await ensureSkills(unique)
      if (missing.length > 0) {
        this.tasks.update((draft) => {
          draft.skillNotice = `技能 ${missing.join('、')} 未能安装;会话将继续,但 AI 无法调用该技能`
        })
      } else {
        this.tasks.update((draft) => { draft.skillNotice = null })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.tasks.update((draft) => {
        draft.skillNotice = `技能就绪检查失败(${message});会话将继续,但 AI 可能无法调用任务技能`
      })
    } finally {
      this.tasks.update((draft) => { draft.skillPreparing = false })
    }
  }

  /**
   * 为任务新建(不复用)一个 DSH 会话,失败原因记入队列错误面。
   * 经 SessionsCreatePort 断言取运行时实现上的 create —— 见该类型的
   * 模块文档;断言失败面为零(实现已满足 SessionsPort)。
   * @param workspaceId - 目标工作区。
   * @returns 新会话 id;失败时 undefined(错误已记入 tasks.error)。
   */
  private async createTaskSession(workspaceId: WorkspaceId): Promise<SessionId | undefined> {
    try {
      return await (this.deps.sessions as ISessions & SessionsCreatePort).create({ workspaceId })
    } catch (e) {
      this.tasks.update((draft) => {
        draft.error = e instanceof Error ? e.message : String(e)
      })
      return undefined
    }
  }

  /**
   * 任务指令预填:仅草稿为空且未预填过时写入(不覆盖员工编辑)。
   * @returns 失败原因(人读,记入 prefillNotice);null = 成功或无需预填。
   */
  private prefillPrompt(task: Task, sessionId: SessionId): string | null {
    const prompt = task.dshMeta?.userPrompt
    if (prompt == null || prompt.trim() === '') {
      return '该任务未配置指令(流程定义需重新发布后启动新实例)'
    }
    if (this.prefilledTasks.has(task.id)) return null
    const input = this.sessionInput(sessionId)
    if (input === undefined) return '会话输入面不可用,未能预填指令'
    if (input.state.getSnapshot().draft !== '') {
      return '输入框已有内容,未覆盖;可用档案栏「重新填入」补填'
    }
    input.setDraft(prompt)
    this.prefilledTasks.add(task.id)
    return null
  }

  /** 解析会话的输入面(草稿写路径);会话不在列表/无 scope 时返回 undefined。 */
  private sessionInput(sessionId: SessionId) {
    const actx = this.deps.sessions.scope(sessionId)
    if (actx === undefined) return undefined
    return this.deps.conversation.input.for(actx)
  }

  /** 建立任务↔会话双向绑定(重绑时覆盖旧正向记录),并持久化正向映射。 */
  private bind(taskId: string, sessionId: SessionId): void {
    this.bindings.update((draft) => {
      draft.taskToSession[taskId] = sessionId
      draft.sessionToTask[sessionId] = taskId
    })
    saveTaskSessions(this.bindings.getSnapshot().taskToSession)
  }

  /** 已上报的服务端会话→应用归属(去重;值不变不重发)。 */
  private readonly reportedSessionApps = new Map<string, string | null>()

  /** 上报单条会话归属到本地 kb-context 插件(值不变时跳过;失败静默自愈)。 */
  private reportSessionApp(sessionId: SessionId, applicationId: string | null): void {
    if (this.reportedSessionApps.get(sessionId) === applicationId) return
    this.reportedSessionApps.set(sessionId, applicationId)
    reportSessionKb([{ sessionId, applicationId }])
  }

  /** 已上报的会话→流程实例绑定(去重;值不变不重发)。 */
  private readonly reportedSessionWorkspaces = new Map<string, string>()

  /**
   * 上报单条会话→流程实例绑定到本地 instance-workspace 插件(值不变时跳过;
   * 失败静默自愈:每轮实例空间注入与 pull 端点的 cwd 解析据此路由)。
   */
  private reportSessionWorkspace(sessionId: SessionId, processInstanceId: string): void {
    if (this.reportedSessionWorkspaces.get(sessionId) === processInstanceId) return
    this.reportedSessionWorkspaces.set(sessionId, processInstanceId)
    reportSessionWorkspaceContext(sessionId, processInstanceId)
  }

  /**
   * 重放进行中绑定的会话→流程实例上报(初始化与每次刷新后;webserver 内存
   * 映射重启丢失后自愈)。已完成会话不重放:提交后无新回合,不注入也不开
   * 实例空间标签页。
   */
  private replaySessionWorkspaceReports(): void {
    const { taskToSession } = this.bindings.getSnapshot()
    for (const [taskId, sessionId] of Object.entries(taskToSession)) {
      // 列表暂缺的任务(瞬时抖动)跳过不报,下一条 task 到达时重放补齐。
      const task = this.tasks.getSnapshot().items.find(item => item.id === taskId)
      if (task === undefined) continue
      this.reportSessionWorkspace(sessionId, task.processInstanceId)
    }
  }

  /**
   * 会话的工作目录(树上云默认目标 relPath、预览 dsh-resource 地址共用)。
   * @param sessionId - 目标会话。
   * @returns 会话 cwd;会话不在列表时 undefined。
   */
  cwdOfSession(sessionId: SessionId): string | undefined {
    return this.deps.sessions.list.getSnapshot().byId[sessionId]?.cwd
  }

  /**
   * 已完成会话的应用归属(查持久化条目;刷新后无需先开档案回执即可解析,
   * 供知识库选择器入口与 '@' 触发源在会话直开场景使用)。
   * @param sessionId - 目标会话。
   * @returns 提交时固化的应用 id;非已完成会话或旧版无归属条目为 null。
   */
  completedApplicationId(sessionId: SessionId): string | null {
    for (const entry of Object.values(this.completedSessions)) {
      if (entry.sessionId === sessionId) return entry.applicationId
    }
    return null
  }

  /** 重放全部持久绑定的会话归属(初始化与每次刷新后;webserver 重启自愈;含已完成会话)。 */
  private replaySessionKbReports(): void {
    const { taskToSession } = this.bindings.getSnapshot()
    const entries: SessionKbEntry[] = []
    for (const [taskId, sessionId] of Object.entries(taskToSession)) {
      // 列表暂缺的任务(瞬时抖动)跳过不报,避免把已知归属误清成 null。
      const task = this.tasks.getSnapshot().items.find(item => item.id === taskId)
      if (task === undefined) continue
      const applicationId = task.applicationId
      if (this.reportedSessionApps.get(sessionId) === applicationId) continue
      this.reportedSessionApps.set(sessionId, applicationId)
      entries.push({ sessionId, applicationId })
    }
    // 已完成会话:归属在提交时固化进持久化条目,重放使重启后的 kb 注入自愈;
    // 无归属条目(旧版本数据/应用未归属)跳过,不产生 null 清除。
    for (const entry of Object.values(this.completedSessions)) {
      if (entry.applicationId === null) continue
      if (this.reportedSessionApps.get(entry.sessionId) === entry.applicationId) continue
      this.reportedSessionApps.set(entry.sessionId, entry.applicationId)
      entries.push({ sessionId: entry.sessionId, applicationId: entry.applicationId })
    }
    if (entries.length > 0) reportSessionKb(entries)
  }

  /** 解除绑定;'completed' 时在会话上留完成回执并把映射持久化。 */
  private unbind(task: Task, _reason: 'completed'): void {
    let persisted: SessionId | undefined
    this.bindings.update((draft) => {
      const sessionId = draft.taskToSession[task.id]
      // 用 spread+rest pattern 移除键,绕开 lint 的 no-dynamic-delete 规则
      // (不能改回 Map:immer 运行时未启用 MapSet 插件,Map draft 会崩溃)。
      const { [task.id]: _removed1, ...rest1 } = draft.taskToSession
      draft.taskToSession = rest1
      if (sessionId !== undefined) {
        const { [sessionId]: _removed2, ...rest2 } = draft.sessionToTask
        draft.sessionToTask = rest2
        draft.completedBySession[sessionId] = {
          taskId: task.id,
          taskName: task.name ?? task.id,
          submittedAt: Date.now(),
          applicationId: task.applicationId,
        }
        draft.completedByTask[task.id] = sessionId
        persisted = sessionId
      }
    })
    if (persisted !== undefined) {
      // 知识库归属保留不清除:已完成会话继续注入 kb 块、选择器入口继续可用;
      // 应用归属在提交时固化进持久化条目,webserver 重启后归属重放自愈。
      this.completedSessions[task.id] = { sessionId: persisted, applicationId: task.applicationId }
      saveCompletedSessions(this.completedSessions)
    }
    // 提交完成后任务不再"进行中":从持久化绑定中移除,避免刷新后残留。
    saveTaskSessions(this.bindings.getSnapshot().taskToSession)
  }
}
