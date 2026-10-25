/**
 * 待办队列:原生 sidebar 的 enterprise nav 座位占据者。
 *
 * <p>注册进 ui-sidebar 声明的 `sidebar.nav` 槽 —— SidebarRoot 的
 * enterpriseLayout 分支在 navArea 渲染它,原生 workspaces 会话浏览、
 * New Session 与 Settings 保留在各自座位(企业 profile 与上游 DSH 的
 * 合并面最大化保留原生能力)。宽态渲染待办/已完成两组列表,每行压成与
 * 工作区会话行一致的 32px 单行(标题 + 状态徽章 + 右侧绝对时间);两个
 * 列表头部各有"视图选项"菜单(分组方式:按日期/按流程类型;排序方式:
 * 升序/降序),选项经 task-view 派生分组并记忆到 localStorage。任务驱动
 * 导航:待办点击经 workbench.openTask —— 未绑定时弹出"选择工作空间"
 * 确认弹窗(WorkspacePickerDialog,选定后不可修改),确认后才建会话绑定;
 * 已绑定回到原会话。已完成来自引擎
 * 历史数据(持久,刷新仍在),点击回看本地会话或只读档案。窄轨(wide=
 * false,56px)渲染计数徽标,点击展开。未登录时由 shell.overlay 认证
 * 遮罩盖住整帧,这里只渲染占位。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconClockOutlineRegular,
  IconFolderCloseRegular, IconSlidersTwoOutlineRegular, IconTriangleRightFillRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsHooks, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: 拉入 ui-workspace 的 SlotMap 合并与目录流程 owner 契约。
import type { DirectoryPickingInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import { useAuth } from './EnterpriseUi.tsx'
import { WorkspacePickerDialog } from './WorkspacePickerDialog.tsx'
import { useSnapshot } from './workbench/hooks.ts'
import {
  completedTaskRow, deriveTaskGroups, loadTaskViewState, pendingTaskRow, saveTaskViewState,
} from './task-view.ts'
import type { TaskViewGroup, TaskViewOptions, TaskViewRow, TaskViewState } from './task-view.ts'
import css from './TaskQueueSidebar.module.css'

/** nav 座位注入面:工作台编排器 + 目录流程占用源(洞空闲与否经 hooks 下发)。 */
export type TaskQueueSidebarInjected =
  & DirectoryPickingInjected
  & {
    workbench: EnterpriseWorkbench
  }

/** nav 座位组件 props:owner(wide)+ 目录流程洞渲染授权 + 注入面 + 全局标准 kit(useSessions/useWorkspaces)。 */
export type TaskQueueSidebarProps =
  & PropsRuntime<'sidebar.nav'>
  & PropsRenderSlots<'sidebar.nav.directoryFlow'>
  & Omit<TaskQueueSidebarInjected, 'hooks'>
  & PropsHooks<TaskQueueSidebarInjected['hooks']>

/**
 * 列表视图选项菜单:分组方式(按日期/按流程类型)与排序方式(升序/降序)。
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
      // Portal:section 标题行裁剪溢出,就地挂载会被切掉(同工作区视图选项)。
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
 * 收缩;再点已展开的组头回到全收缩。行渲染委托 renderRow(两个列表的
 * 点击行为与徽章不同)。
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

/** 待办队列 nav 座位(见模块文档)。 */
export function TaskQueueSidebar({ wide, workbench, useSessions, useWorkspaces, useDirectoryFlow, renderSlot }: TaskQueueSidebarProps) {
  const { currentUser, loading: authLoading, logout } = useAuth()
  const tasks = useSnapshot(workbench.tasks)
  const bindings = useSnapshot(workbench.bindings)
  // 工作区列表:工作空间选择弹窗的选项来源(创建/删除后实时刷新)。
  const workspaceItems = useWorkspaces(s => s.items)
  // 当前主区会话:官方重构后 navigation 归 ui-workspace,经 mainView 保留计数暴露。
  const currentSession = useSessions(s => Object.values(s.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const authed = !authLoading && currentUser !== null && currentUser.status === 'active'
  // 两个列表各自的视图选项;改动即写回 localStorage(刷新后保留)。
  const [viewState, setViewState] = useState<TaskViewState>(() => loadTaskViewState())
  const updateView = (list: 'pending' | 'completed', options: TaskViewOptions): void => {
    setViewState((prev) => {
      const next = { ...prev, [list]: options }
      saveTaskViewState(next)
      return next
    })
  }
  // 手风琴展开态:单值 key(展开一个其余自动收缩),null = 全收缩;仅内存态,
  // 每次进入默认全收缩。切换分组方式后 key 失配即自然全收缩。
  const [pendingExpanded, setPendingExpanded] = useState<string | null>(null)
  const [completedExpanded, setCompletedExpanded] = useState<string | null>(null)
  const togglePending = (key: string): void => { setPendingExpanded(k => k === key ? null : key) }
  const toggleCompleted = (key: string): void => { setCompletedExpanded(k => k === key ? null : key) }
  const pendingGroups = useMemo(
    () => deriveTaskGroups(tasks.items, viewState.pending, pendingTaskRow),
    [tasks.items, viewState.pending],
  )
  const completedGroups = useMemo(
    () => deriveTaskGroups(tasks.completed, viewState.completed, completedTaskRow),
    [tasks.completed, viewState.completed],
  )

  useEffect(() => {
    if (authed) void workbench.refresh()
  }, [authed, workbench])

  if (!wide) {
    return (
      <button
        type="button"
        className={css.rail}
        onClick={() => { workbench.expandSidebar() }}
        title={`待办 ${tasks.items.length} 项,点击展开`}
      >
        <span className={css.railIcon} aria-hidden>
          <svg viewBox="0 0 16 16" width="18" height="18">
            <path
              d="M2.5 3h11a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-4l-2.5 2.5V10.5h-4.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
              fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className={css.railCount}>{tasks.items.length}</span>
      </button>
    )
  }

  return (
    <div className={css.sidebar}>
      <div className={css.header}>
        <span className={css.headerTitle}>任务工作台</span>
        {authed && (
          <button
            type="button"
            className={css.refresh}
            onClick={() => { void workbench.refresh() }}
            disabled={tasks.loading}
            title="刷新待办与已完成列表"
          >
            {tasks.loading ? '刷新中…' : '刷新'}
          </button>
        )}
      </div>

      <div className={css.listArea}>
        <div className={css.sectionTitle}>
          我的待办
          <span className={css.countBadge}>{tasks.items.length}</span>
          <span className={css.sectionActions}>
            <TaskViewMenu options={viewState.pending} onPick={(next) => { updateView('pending', next) }} />
          </span>
        </div>

        <div className={css.list}>
          {authed && tasks.loading && tasks.items.length === 0 && <div className={css.hint}>加载中…</div>}
          {authed && !tasks.loading && tasks.error !== null && (
            <div className={css.error}>{tasks.error}</div>
          )}
          {authed && !tasks.loading && tasks.error === null && tasks.items.length === 0 && (
            <div className={css.hint}>暂无待办任务</div>
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
          {pendingGroups.map(group => (
            <TaskGroupSection
              key={group.key}
              group={group}
              expandedKey={pendingExpanded}
              onToggle={togglePending}
              renderRow={({ item: task, row }) => {
                const bound = bindings.taskToSession[task.id]
                const active = bound !== undefined && bound === currentSession
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={clsx(css.taskItem, active && css.taskItemActive)}
                    onClick={() => { void workbench.openTask(task) }}
                    disabled={tasks.skillPreparing}
                  >
                    <span className={css.taskName}>{row.title}</span>
                    {active && <span className={css.sessionTag}>处理中</span>}
                    <span className={css.taskTime}>{row.timeLabel}</span>
                  </button>
                )
              }}
            />
          ))}
        </div>

        {authed && (
          <>
            <div className={clsx(css.sectionTitle, css.sectionTitleSecondary)}>
              已完成
              <span className={css.countBadge}>{tasks.completed.length}</span>
              <span className={css.sectionActions}>
                <TaskViewMenu options={viewState.completed} onPick={(next) => { updateView('completed', next) }} />
              </span>
            </div>
            <div className={css.list}>
              {tasks.completed.length === 0 && <div className={css.hint}>暂无已完成任务</div>}
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
                        className={clsx(css.taskItem, css.doneItem, active && css.taskItemActive)}
                        onClick={() => { workbench.openCompletedTask(task) }}
                      >
                        <span className={css.taskName}>{row.title}</span>
                        <span className={css.doneTag}>已提交</span>
                        <span className={css.taskTime}>{row.timeLabel}</span>
                      </button>
                    )
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {authed && (
        <div className={css.footer}>
          {/* oxlint-disable typescript/no-unnecessary-condition -- authed is a hoisted boolean; TS cannot narrow through it */}
          <span className={css.footerUser} title={currentUser?.email ?? ''}>
            {currentUser?.displayName ?? ''}
          </span>
          {/* oxlint-enable typescript/no-unnecessary-condition */}
          <button type="button" className={css.logout} onClick={() => { void logout() }}>
            退出
          </button>
        </div>
      )}

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
  )
}
