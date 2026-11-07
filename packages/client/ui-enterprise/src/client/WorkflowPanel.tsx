/**
 * 工作流全窗口面板:main 槽位的 `enterprise-workflow` 面板占据者。
 *
 * <p>注册进 ui-layout 的 `main` keyed 槽(id 同步登记 `sidebar.panellist`,
 * 侧栏顶部功能入口区提供带待办数徽标的入口)——替代原 sidebar.nav 上的
 * 紧凑待办队列,以整页空间承载待办管理:头部统计卡(待办/今日到期/
 * 已超时/本周完成,由任务数据就地计算)、待办与已完成两个标签页、
 * 搜索过滤与视图选项菜单。两个列表沿用 task-view 的分组/排序派生与
 * localStorage 记忆;行升级为两行卡片——标题行(流程类型徽标 + 节点名 +
 * 处理中/截止徽标右对齐,同一基线),信息行(发起人 · 所属应用 · 实例 ID ·
 * 到达时间;应用名经 kb/mine 应用清单解析,未收录的应用隐藏该项)。
 * 截止时间取自 dshMeta.actionPolicy.timeoutPolicy
 * .duration(非必填,未配置不显示截止徽标);已超时 = 截止已过而待办仍在
 * 名下。任务驱动导航:待办点击经 workbench.openTask —— 未绑定时弹出
 * "选择工作空间"确认弹窗(WorkspacePickerDialog;目录流程洞
 * `sidebar.nav.directoryFlow` 由本面板的 children 声明承接,选定后不可
 * 修改),确认后才建会话绑定;已绑定回到原会话。已完成来自引擎历史数据
 * (持久,刷新仍在),按页加载("加载更多"),点击回看本地会话或只读
 * 档案。登录墙存在时由 shell.overlay 认证遮罩盖住整帧;登录用户栏在
 * 侧栏底部(UserFooterCard)。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconAlarmClockOutlineRegular, IconCheckCircleOutlineRegular, IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular, IconClockOutlineRegular, IconFolderCloseRegular,
  IconListPenOutlineRegular, IconSearchOutlineRegular, IconSlidersTwoOutlineRegular,
  IconTriangleRightFillRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsHooks, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: 拉入 ui-workspace 的 SlotMap 合并与目录流程 owner 契约。
import type { DirectoryPickingInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { listMyKbs } from './kb-api.ts'
import type { Task } from './task-api.ts'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import { useAuth } from './EnterpriseUi.tsx'
import { WorkspacePickerDialog } from './WorkspacePickerDialog.tsx'
import { useSnapshot } from './workbench/hooks.ts'
import {
  completedTaskRow, deriveTaskGroups, loadTaskViewState, pendingTaskRow, saveTaskViewState,
} from './task-view.ts'
import type { TaskViewGroup, TaskViewOptions, TaskViewRow, TaskViewState } from './task-view.ts'
import { deadlineState, formatDeadline, formatElapsedMillis, formatTimeoutDuration, taskDeadline } from './workflow-deadline.ts'
import css from './WorkflowPanel.module.css'

/** 面板注入面:工作台编排器 + 目录流程占用源(洞空闲与否经 hooks 下发)。 */
export type WorkflowPanelInjected =
  & DirectoryPickingInjected
  & {
    workbench: EnterpriseWorkbench
  }

/** 面板组件 props:目录流程洞渲染授权 + 注入面 + 全局标准 kit(useSessions/useWorkspaces)。 */
export type WorkflowPanelProps =
  & PropsRuntime<'main'>
  & PropsRenderSlots<'sidebar.nav.directoryFlow'>
  & Omit<WorkflowPanelInjected, 'hooks'>
  & PropsHooks<WorkflowPanelInjected['hooks']>

/** 活动标签页:待办在前(主任务面)。 */
type WorkflowTab = 'pending' | 'completed'

/** 统计卡的语义色调(对应 DSH 状态色族)。 */
type StatTone = 'business' | 'warning' | 'error' | 'success'

/** 截止徽标:按 deadlineState 派生色调与文案;title 展示原定截止与超时配置。
 *  未配置超时时长返回 null(超时时间仅在配置了 duration 时展示)。
 */
function DeadlineChip({ task }: { task: Task }) {
  const state = deadlineState(task, new Date())
  if (state === 'none') return null
  const due = taskDeadline(task)
  const duration = task.dshMeta?.actionPolicy?.timeoutPolicy?.duration ?? null
  // duration 已解析出截止才可能走到这里;无值防御(同样不展示)。
  if (due === null) return null
  const hint = duration === null
    ? `原定 ${formatDeadline(due)} 截止`
    : `原定 ${formatDeadline(due)} 截止 · 超时配置 ${formatTimeoutDuration(duration) ?? duration}`
  if (state === 'overdue') {
    return <span className={clsx(css.deadlineChip, css.deadlineOverdue)} title={hint}>已超时</span>
  }
  if (state === 'today') {
    return <span className={clsx(css.deadlineChip, css.deadlineSoon)} title={hint}>{formatDeadline(due)} 截止</span>
  }
  return <span className={clsx(css.deadlineChip, css.deadlineNormal)} title={hint}>{formatDeadline(due)} 截止</span>
}

/** 列表视图选项菜单:分组方式(按日期/按流程类型)与排序方式(升序/降序)。
 * 交互对齐工作区"视图选项"(Menu portal 锚在滑杆图标按钮上);onPick 由
 * 调用方写回各自列表的持久化状态。
 */
function TaskViewMenu({ options, onPick }: {
  options: TaskViewOptions
  onPick: (next: TaskViewOptions) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { type: 'label' as const, id: 'group-by', text: '分组方式' },
        { id: 'date', label: '按日期', icon: <IconClockOutlineRegular /> },
        { id: 'process-type', label: '按流程类型', icon: <IconFolderCloseRegular /> },
        { type: 'separator' as const, id: 'order-separator' },
        { type: 'label' as const, id: 'order-by', text: '排序方式' },
        { id: 'asc', label: '升序', icon: <IconChevronUpOutlineRegular /> },
        { id: 'desc', label: '降序', icon: <IconChevronDownOutlineRegular /> },
      ]}
      selectedIds={[options.groupBy === 'date' ? 'date' : 'process-type', options.orderBy]}
      onSelect={(id) => {
        if (id === 'date' || id === 'process-type') {
          onPick({ ...options, groupBy: id === 'date' ? 'date' : 'processType' })
        } else if (id === 'asc' || id === 'desc') {
          onPick({ ...options, orderBy: id })
        }
        setOpen(false)
      }}
      align="end"
      dense
      // Portal:工具栏行裁剪溢出,就地挂载会被切掉(同工作区视图选项)。
      portal
      anchor={
        <Tooltip label="视图选项" side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.viewToggle}
            aria-label="视图选项"
            onClick={() => { setOpen(v => !v) }}
          >
            <IconSlidersTwoOutlineRegular />
          </button>
        </Tooltip>
      }
    />
  )
}

/**
 * 单个分组的折叠区:组头(chevron + 组名 + 计数)可点击展开/收缩。
 * 手风琴语义由调用方的 expandedKey 单值状态表达——展开一个,其余自动
 * 收缩;再点已展开的组头回到全收缩。行渲染委托 renderRow(两个标签页的
 * 行内容与点击行为不同)。
 */
function TaskGroupSection<T>({ group, expandedKey, onToggle, renderRow }: {
  group: TaskViewGroup<T>
  expandedKey: string | null
  onToggle: (key: string) => void
  renderRow: (entry: { item: T; row: TaskViewRow }) => ReactNode
}) {
  const expanded = expandedKey === group.key
  return (
    <div className={css.group}>
      <button
        type="button"
        className={css.groupHeader}
        aria-expanded={expanded}
        onClick={() => { onToggle(group.key) }}
      >
        <IconTriangleRightFillRegular
          className={clsx(css.groupChevron, expanded && css.groupChevronOpen)}
        />
        <span className={css.groupLabel} title={group.label}>{group.label}</span>
        <span className={css.groupCount}>{group.rows.length}</span>
      </button>
      {expanded && group.rows.map(entry => renderRow(entry))}
    </div>
  )
}

/** 统计卡 tone → 图标底色类(tone 为闭集;CSS module 类名类型可能 undefined,clsx 可吸收)。 */
const STAT_TONE_CLASS: Record<StatTone, string | undefined> = {
  business: css.statBusiness,
  warning: css.statWarning,
  error: css.statError,
  success: css.statSuccess,
}

/** 头部统计卡:大数字 + 标签 + 状态色图标(数值由调用方就地计算)。 */
function StatCard({ tone, icon, value, label }: {
  tone: StatTone
  icon: ReactNode
  value: number
  label: string
}) {
  return (
    <div className={clsx(css.statCard, STAT_TONE_CLASS[tone])}>
      <span className={css.statIcon} aria-hidden>{icon}</span>
      <span className={css.statValue}>{value}</span>
      <span className={css.statLabel}>{label}</span>
    </div>
  )
}

/** 应用名缓存(按用户会话):kb/mine 一次拉取,applicationId → 显示名;
 *  失败清缓存,下次挂载重试;未收录的应用在行内隐藏该项。
 */
let appNamesCache: { userId: string; names: Promise<ReadonlyMap<string, string>> } | null = null

function loadAppNames(userId: string): Promise<ReadonlyMap<string, string>> {
  if (appNamesCache?.userId !== userId) {
    appNamesCache = {
      userId,
      names: listMyKbs()
        .then(kbs => new Map(kbs.map(kb => [kb.applicationId, kb.applicationName])))
        .catch((e: unknown) => {
          appNamesCache = null
          throw e
        }),
    }
  }
  return appNamesCache.names
}

/** 信息行条目:标签 + 值;值超长省略,mono 用于实例 ID 等机器标识。 */
function MetaItem(props: { label: string; value: string; mono?: boolean; title?: string }) {
  const { label, value, mono = false, title } = props
  return (
    <span className={css.taskMetaItem} title={title ?? value}>
      <span className={css.taskMetaLabel}>{label}</span>
      <span className={mono ? clsx(css.taskMetaValue, css.taskMetaMono) : css.taskMetaValue}>{value}</span>
    </span>
  )
}

/** 实例 ID 的行内展示形:前 8 位 + 省略号(完整值走 title)。 */
function instanceShortId(instanceId: string): string {
  return `${instanceId.slice(0, 8)}…`
}

/** 工作流全窗口面板(见模块文档)。 */
export function WorkflowPanel({ workbench, useSessions, useWorkspaces, useDirectoryFlow, renderSlot }: WorkflowPanelProps) {
  const { currentUser, loading: authLoading } = useAuth()
  const tasks = useSnapshot(workbench.tasks)
  const bindings = useSnapshot(workbench.bindings)
  // 工作区列表:工作空间选择弹窗的选项来源(创建/删除后实时刷新)。
  const workspaceItems = useWorkspaces(s => s.items)
  // 当前主区会话:官方重构后 navigation 归 ui-workspace,经 mainView 保留计数暴露。
  const currentSession = useSessions(s => Object.values(s.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const authed = !authLoading && currentUser !== null && currentUser.status === 'active'
  // 应用名映射(所属应用列):随登录用户拉取一次,解析失败仅隐藏该列。
  const [appNames, setAppNames] = useState<ReadonlyMap<string, string>>(new Map())
  const userId = currentUser?.id
  useEffect(() => {
    if (userId === undefined) return
    let live = true
    void loadAppNames(userId).then((names) => {
      if (live) setAppNames(names)
    }, () => { /* 解析失败仅隐藏应用名,不阻塞待办列表 */ })
    return () => { live = false }
  }, [userId])
  // 两个列表各自的视图选项;改动即写回 localStorage(刷新后保留)。
  const [viewState, setViewState] = useState<TaskViewState>(() => loadTaskViewState())
  const updateView = (list: 'pending' | 'completed', options: TaskViewOptions): void => {
    setViewState((prev) => {
      const next = { ...prev, [list]: options }
      saveTaskViewState(next)
      return next
    })
  }
  const [tab, setTab] = useState<WorkflowTab>('pending')
  const [query, setQuery] = useState('')
  // 手风琴展开态:单值 key(展开一个其余自动收缩),null = 全收缩;仅内存态,
  // 每次进入默认全收缩。切换分组方式后 key 失配即自然全收缩。
  const [pendingExpanded, setPendingExpanded] = useState<string | null>(null)
  const [completedExpanded, setCompletedExpanded] = useState<string | null>(null)
  const togglePending = (key: string): void => { setPendingExpanded(k => k === key ? null : key) }
  const toggleCompleted = (key: string): void => { setCompletedExpanded(k => k === key ? null : key) }

  useEffect(() => {
    if (authed) void workbench.refresh()
  }, [authed, workbench])

  // 搜索过滤:待办匹配节点名/流程类型/发起人(显示名与 id),已完成匹配
  // 节点名/流程类型;空查询原样返回。结果再进 task-view 的分组/排序派生。
  const pendingItems = useMemo(() => filterTasks(tasks.items, query), [tasks.items, query])
  const completedItems = useMemo(() => filterTasks(tasks.completed, query), [tasks.completed, query])
  const pendingGroups = useMemo(
    () => deriveTaskGroups(pendingItems, viewState.pending, pendingTaskRow),
    [pendingItems, viewState.pending],
  )
  const completedGroups = useMemo(
    () => deriveTaskGroups(completedItems, viewState.completed, completedTaskRow),
    [completedItems, viewState.completed],
  )

  // 统计卡:待办总数;今日到期(截止在今天、尚未超时)与已超时只对配置了
  // duration 的待办计数(duration 非必填);本周完成基于已加载的完成记录。
  const stats = useMemo(() => {
    const now = new Date()
    let dueToday = 0
    let overdue = 0
    for (const task of tasks.items) {
      const state = deadlineState(task, now)
      if (state === 'overdue') overdue += 1
      else if (state === 'today') dueToday += 1
    }
    const weekStart = new Date(now)
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7))
    weekStart.setHours(0, 0, 0, 0)
    const doneThisWeek = tasks.completed.filter(
      task => task.endTime !== null && Date.parse(task.endTime) >= weekStart.getTime(),
    ).length
    return { pending: tasks.items.length, dueToday, overdue, doneThisWeek }
  }, [tasks.items, tasks.completed])

  const hasMoreCompleted = tasks.completed.length >= tasks.completedSize
  // 登录墙存在时不渲染:认证遮罩盖住整帧,刷新随登录态恢复触发。
  if (!authed) return null

  return (
    <div className={css.page}>
      <div className={css.inner}>
        <header className={css.header}>
          <div className={css.heading}>
            <h1 className={css.title}>工作流</h1>
            <p className={css.intro}>处理分配给你的流程待办,回看已提交的任务记录。</p>
          </div>
          <button
            type="button"
            className={css.refresh}
            onClick={() => { void workbench.refresh() }}
            disabled={tasks.loading}
            title="刷新待办与已完成列表"
          >
            {tasks.loading ? '刷新中…' : '刷新'}
          </button>
        </header>

        <section className={css.stats} aria-label="待办统计">
          <StatCard tone="business" icon={<IconListPenOutlineRegular />} value={stats.pending} label="待办" />
          <StatCard tone="warning" icon={<IconClockOutlineRegular />} value={stats.dueToday} label="今日到期" />
          <StatCard tone="error" icon={<IconAlarmClockOutlineRegular />} value={stats.overdue} label="已超时" />
          <StatCard tone="success" icon={<IconCheckCircleOutlineRegular />} value={stats.doneThisWeek} label="本周完成" />
        </section>

        <div className={css.toolbar}>
          <div className={css.tabs} role="tablist" aria-label="任务列表切换">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'pending'}
              className={clsx(css.tab, tab === 'pending' && css.tabActive)}
              onClick={() => { setTab('pending') }}
            >
              待办
              <span className={css.tabCount}>{pendingItems.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'completed'}
              className={clsx(css.tab, tab === 'completed' && css.tabActive)}
              onClick={() => { setTab('completed') }}
            >
              已完成
              <span className={css.tabCount}>{completedItems.length}</span>
            </button>
          </div>
          <div className={css.search}>
            <IconSearchOutlineRegular className={css.searchIcon} />
            <input
              className={css.searchInput}
              type="search"
              placeholder={tab === 'pending' ? '搜索节点、流程类型、发起人' : '搜索节点、流程类型'}
              value={query}
              onChange={(e) => { setQuery(e.target.value) }}
            />
          </div>
          <TaskViewMenu
            options={viewState[tab]}
            onPick={(next) => { updateView(tab, next) }}
          />
        </div>

        <section className={css.listCard} aria-label={tab === 'pending' ? '待办列表' : '已完成列表'}>
          {tasks.loading && tasks.items.length === 0 && <div className={css.hint}>加载中…</div>}
          {!tasks.loading && tasks.error !== null && (
            <div className={css.error}>{tasks.error}</div>
          )}
          {!tasks.loading && tasks.error === null && tab === 'pending' && tasks.items.length === 0 && (
            <div className={css.empty}>
              <IconListPenOutlineRegular className={css.emptyIcon} />
              <p className={css.emptyTitle}>暂无待办任务</p>
              <p className={css.emptyHint}>新的流程待办会出现在这里。</p>
            </div>
          )}
          {!tasks.loading && tasks.error === null && tab === 'completed' && tasks.completed.length === 0 && (
            <div className={css.empty}>
              <IconCheckCircleOutlineRegular className={css.emptyIcon} />
              <p className={css.emptyTitle}>暂无已完成任务</p>
              <p className={css.emptyHint}>提交过的待办会记录在这里。</p>
            </div>
          )}
          {tasks.prefillNotice !== null && tasks.items.length > 0 && (
            <div className={css.notice} title={tasks.prefillNotice}>{tasks.prefillNotice}</div>
          )}
          {tasks.skillPreparing && (
            <div className={css.notice}>正在准备任务技能…</div>
          )}
          {tasks.skillNotice !== null && (
            <div className={css.notice} title={tasks.skillNotice}>{tasks.skillNotice}</div>
          )}

          {tab === 'pending' && pendingGroups.length > 0 && (
            <div className={css.groups}>
              {pendingGroups.map(group => (
                <TaskGroupSection
                  key={group.key}
                  group={group}
                  expandedKey={pendingExpanded}
                  onToggle={togglePending}
                  renderRow={({ item: task, row }) => {
                    const bound = bindings.taskToSession[task.id]
                    const active = bound !== undefined && bound === currentSession
                    const appName = task.applicationId === null ? null : appNames.get(task.applicationId) ?? null
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={clsx(css.taskRow, active && css.taskRowActive)}
                        onClick={() => { void workbench.openTask(task) }}
                        disabled={tasks.skillPreparing}
                      >
                        <div className={css.taskMain}>
                          <div className={css.taskTitleLine}>
                            {task.processDefinitionName !== null && (
                              <span className={css.processBadge}>{task.processDefinitionName}</span>
                            )}
                            <span className={css.taskTitle}>{row.title}</span>
                            {active && <span className={css.activeTag}>处理中</span>}
                            <DeadlineChip task={task} />
                          </div>
                          <div className={css.taskMetaLine}>
                            {task.startUserName !== null && <MetaItem label="发起人" value={task.startUserName} />}
                            {appName !== null && <MetaItem label="应用" value={appName} />}
                            <MetaItem label="实例" value={instanceShortId(task.processInstanceId)} mono title={task.processInstanceId} />
                            <MetaItem label="到达" value={row.timeLabel} />
                          </div>
                        </div>
                      </button>
                    )
                  }}
                />
              ))}
            </div>
          )}

          {tab === 'completed' && completedGroups.length > 0 && (
            <div className={css.groups}>
              {completedGroups.map(group => (
                <TaskGroupSection
                  key={group.key}
                  group={group}
                  expandedKey={completedExpanded}
                  onToggle={toggleCompleted}
                  renderRow={({ item: task, row }) => {
                    const session = bindings.completedByTask[task.id]
                    const active = session !== undefined && session === currentSession
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={clsx(css.taskRow, css.taskRowDone, active && css.taskRowActive)}
                        onClick={() => { workbench.openCompletedTask(task) }}
                      >
                        <div className={css.taskMain}>
                          <div className={css.taskTitleLine}>
                            {task.processDefinitionName !== null && (
                              <span className={css.processBadge}>{task.processDefinitionName}</span>
                            )}
                            <span className={css.taskTitle}>{row.title}</span>
                            {active && <span className={css.activeTag}>回看中</span>}
                            <span className={css.doneTag}>已提交</span>
                          </div>
                          <div className={css.taskMetaLine}>
                            <MetaItem label="实例" value={instanceShortId(task.processInstanceId)} mono title={task.processInstanceId} />
                            <MetaItem label="完成" value={row.timeLabel} />
                            {task.durationInMillis !== null && (
                              <MetaItem label="耗时" value={formatElapsedMillis(task.durationInMillis) ?? '—'} />
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  }}
                />
              ))}
            </div>
          )}

          {tab === 'pending' && tasks.items.length > 0 && pendingGroups.length === 0 && (
            <div className={css.hint}>没有匹配"{query}"的待办</div>
          )}
          {tab === 'completed' && tasks.completed.length > 0 && completedGroups.length === 0 && (
            <div className={css.hint}>没有匹配"{query}"的已完成任务</div>
          )}

          {tab === 'completed' && hasMoreCompleted && (
            <div className={css.loadMoreArea}>
              {tasks.completedMoreError !== null && (
                <div className={css.error}>{tasks.completedMoreError}</div>
              )}
              <button
                type="button"
                className={css.loadMore}
                onClick={() => { void workbench.loadMoreCompleted() }}
                disabled={tasks.completedLoadingMore}
              >
                {tasks.completedLoadingMore ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
        </section>

        {/* 工作空间选择弹窗:key 按任务重挂载,选项状态不跨任务残留。 */}
        <WorkspacePickerDialog
          key={tasks.pendingTask?.id ?? 'none'}
          open={tasks.pendingTask !== null}
          task={tasks.pendingTask}
          workspaces={workspaceItems}
          onClose={() => { workbench.cancelPendingTask() }}
          onConfirm={(workspaceId) => { void workbench.confirmPendingTaskWorkspace(workspaceId) }}
          onAdopt={path => workbench.adoptPickedWorkspace(path)}
          useDirectoryFlow={useDirectoryFlow}
          renderDirectoryFlow={owner => renderSlot('sidebar.nav.directoryFlow', owner)}
        />
      </div>
    </div>
  )
}

/** 搜索过滤的行字段面(待办与已完成行共用)。 */
type TaskFilterFields = {
  name: string | null
  processDefinitionName: string | null
  startUserName?: string | null
  startUserId?: string | null
}

/** 搜索过滤:待办与已完成共用的字段匹配(大小写不敏感)。 */
function filterTasks<T extends TaskFilterFields>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return items
  return items.filter(task =>
    task.name?.toLowerCase().includes(q) === true
    || task.processDefinitionName?.toLowerCase().includes(q) === true
    || task.startUserName?.toLowerCase().includes(q) === true
    || task.startUserId?.toLowerCase().includes(q) === true)
}
