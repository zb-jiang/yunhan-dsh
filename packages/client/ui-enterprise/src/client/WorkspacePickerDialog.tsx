/**
 * Workspace picker dialog: explicit workspace binding for a task.
 *
 * <p>首次点击未绑定待办时由 TaskQueueSidebar 渲染(workbench.openTask 置
 * pendingTask):员工从工作区列表中单选,或点"浏览本地文件夹"进入目录流程
 * occupant —— `sidebar.nav.directoryFlow` 洞的占用者(browse 档为页面内
 * 目录浏览器,native 档为 OS 原生对话框),本组件只按 owner 契约(open/
 * busy/onPicked/onCancel/onError)与之对话,不区分档位。选定路径经
 * workbench.adoptPickedWorkspace 注册为新工作区并自动选中;确认后 workbench
 * 才新建专属会话并绑定。弹窗明示"选定后不可修改"——绑定即最终决定,没有
 * 草稿期反悔通道;取消不产生任何会话,可重新点击待办再次选择。尚无任何
 * 工作区时列表退化为引导视图,同样走浏览入口;洞未被任何 surface 包占用时
 * 不渲染浏览按钮(无流程可用)。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: 拉入 ui-workspace 的 SlotMap 合并(目录流程洞类型)。
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { Task } from './task-api.ts'
import css from './WorkspacePickerDialog.module.css'

type WorkspacePickerDialogProps = {
  open: boolean
  /** 等待选择工作空间的待办(null 时弹窗不渲染内容)。 */
  task: Task | null
  /** 当前工作区列表(经 useWorkspaces 订阅,创建/删除后实时刷新)。 */
  workspaces: readonly WorkspaceView[]
  onClose: () => void
  onConfirm: (workspaceId: WorkspaceId) => void
  /** 把 occupant 选定的目录注册为新工作区(Host 幂等),失败抛错由弹窗展示。 */
  onAdopt: (path: string) => Promise<WorkspaceId>
  /** 目录流程洞占用源 hook:洞空闲时隐藏浏览入口。 */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** 用 owner 会话渲染目录流程洞(本 entry 的窄化 renderSlot)。 */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
}

export function WorkspacePickerDialog({
  open, task, workspaces, onClose, onConfirm, onAdopt, useDirectoryFlow, renderDirectoryFlow,
}: WorkspacePickerDialogProps) {
  const [selected, setSelected] = useState<WorkspaceId | null>(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const hasWorkspaces = workspaces.length > 0
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // 一次只有一个目录流程在途(occupant 等待中或采纳在途中),浏览按钮随之
  // 禁用——迟到的结果不能与并发的新一次选择/采纳竞争。
  const flowBusy = flowOpen || adopting

  // occupant 半路卸载(HMR/surface 切换)后无人能取消或回报:流程开着而洞
  // 已空时收回。flowOpen 也是依赖——流程可能在洞已空时打开(重试落空),
  // 该转换同样要收回。
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowOpen, flowAvailable])

  /** 采纳 occupant 交回的路径;失败落回弹窗内错误行,可重新点按钮再试。 */
  const adoptDirectory = (path: string): void => {
    setAdopting(true)
    onAdopt(path).then((workspaceId) => {
      setFlowOpen(false)
      setSelected(workspaceId)
    }).catch((reason: unknown) => {
      setBrowseError(reason instanceof Error ? reason.message : String(reason))
      setFlowOpen(false)
    }).finally(() => { setAdopting(false) })
  }

  /** owner 侧会话:采纳期间保持流程打开(busy),occupant 据此禁用提交。 */
  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: adopting,
    onPicked: adoptDirectory,
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setBrowseError(message)
    },
  }

  return (
    <Modal open={open} onClose={onClose} title="选择工作空间" headless={true} className={css.modal ?? ''}>
      {task !== null && (
        <div className={css.dialog}>
          <div className={css.header}>
            <h3 className={css.title}>为「{task.name ?? task.id}」选择工作空间</h3>
            <p className={css.subtitle}>
              将在该工作空间中创建本任务的专属 AI 会话
            </p>
          </div>

          {hasWorkspaces ? (
            <div className={css.list} role="radiogroup" aria-label="工作空间列表">
              {workspaces.map(workspace => (
                <label
                  key={workspace.workspaceId}
                  className={`${css.option} ${selected === workspace.workspaceId ? css.optionSelected ?? '' : ''}`}
                >
                  <input
                    type="radio"
                    name="workspace-picker"
                    className={css.radio}
                    checked={selected === workspace.workspaceId}
                    onChange={() => { setSelected(workspace.workspaceId) }}
                  />
                  <span className={css.optionMain}>
                    <span className={css.optionTitle}>{workspace.title}</span>
                    <span className={css.optionPath} title={workspace.path}>{workspace.path}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className={css.empty}>
              <span>尚无可用工作空间 —— 浏览本地文件夹选定一个目录即创建,再确认处理该待办。</span>
            </div>
          )}

          {flowAvailable && (
            <button
              type="button" className={css.browse}
              onClick={() => { setBrowseError(null); setFlowOpen(true) }}
              disabled={flowBusy}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                <path
                  d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.8h6.5a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
                  fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
                />
              </svg>
              <span>
                {flowOpen ? '等待选择文件夹…' : adopting ? '正在注册工作区…' : '浏览本地文件夹…'}
              </span>
            </button>
          )}
          {browseError !== null && <div className={css.browseError}>{browseError}</div>}

          <div className={css.warning}>
            <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M10 3.5 18 16.5H2L10 3.5Z" strokeLinejoin="round" />
              <path d="M10 8.5v3.6" strokeLinecap="round" />
              <circle cx="10" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
            </svg>
            <span>工作空间选定后不可修改:本任务的所有对话与档案将固定在该工作空间。</span>
          </div>

          <div className={css.actions}>
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button
              disabled={!hasWorkspaces || selected === null}
              onClick={() => { if (selected !== null) onConfirm(selected) }}
            >
              确认并进入会话
            </Button>
          </div>
        </div>
      )}
      {renderDirectoryFlow(flowOwner)}
    </Modal>
  )
}
