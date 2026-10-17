/**
 * 实例空间标签页:rightbar 标签页系统 `sidebar.right.pane.tab` 座位的企业占据者
 * (design 2026-10-14-instance-workspace-design.md §5.2)。
 *
 * <p>仅绑定待办的会话由工作台程序化打开(类型不注册 guide,不进 guide 页);
 * 展示该流程实例云工作空间的全部文件 —— 流程各节点(员工待办会话、DSH 自动
 * 节点、引擎 delegate)实时共享。树形 relPath,行信息为大小/上传人/更新时间,
 * 磁盘缺失行有标记。行动作:
 *
 * <ul>
 *   <li>下载:经本地 pull 端点(Node 侧)落到会话工作目录同名路径;目标已
 *       存在(409)时弹确认框,确认后带 overwrite 重发。</li>
 *   <li>预览:pull 到会话 cwd 下的预览缓存目录,再经 dsh-resource 地址交给
 *       现有文件查看器(缓存必须落会话 cwd 内,viewer 不认 workspace 外路径)。</li>
 *   <li>删除:确认框后经代理 DELETE,成功后刷新清单。</li>
 * </ul>
 *
 * <p>未绑定待办的会话渲染空态;动作进行中整面蒙版,错误就地展示。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { INSTANCE_FILES_TAB_ID, buildFileTree, formatBytes, useSessionInstance } from './instance-files-tab.ts'
import type { InstanceFileTreeNode } from './instance-files-tab.ts'
import { deleteInstanceFile, listInstanceFiles, pullInstanceFile } from './instance-workspace-api.ts'
import type { InstanceWorkspaceFile } from './instance-workspace-api.ts'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import { formatShortTime } from './workbench/hooks.ts'
import css from './InstanceFilesPanel.module.css'

/** 实例空间标签页注入面:工作台编排器(cwd 解析与导航都经它)。 */
export type InstanceFilesPanelInjected = {
  workbench: EnterpriseWorkbench
}

/** 实例空间标签页组件 props:session 标准套件 + tabInfo 钩子 + 注入面。 */
export type InstanceFilesPanelProps =
  & PropsRuntime<'sidebar.right.pane.tab', typeof INSTANCE_FILES_TAB_ID>
  & InstanceFilesPanelInjected

/** 确认框状态:覆盖已存在的下载目标,或删除云端文件。 */
type ConfirmState = { kind: 'overwrite'; relPath: string } | { kind: 'delete'; relPath: string }

/** 未知异常的人读消息。 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 目录名路径(展开态键;根为 '')。 */
function dirPathOf(node: InstanceFileTreeNode, parentPath: string): string {
  return parentPath === '' ? node.name : `${parentPath}/${node.name}`
}

/** 实例空间标签页(见模块文档)。 */
export function InstanceFilesPanel({ sessionId, useTabInfo, workbench }: InstanceFilesPanelProps): ReactNode {
  const instanceId = useSessionInstance(workbench, sessionId)
  const { tab } = useTabInfo()

  const [files, setFiles] = useState<readonly InstanceWorkspaceFile[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 动作进行中的蒙版文案;null = 空闲。 */
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  /** 折叠的目录名路径集合;默认全部展开。 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  // 清单拉取:打开/切换会话/绑定变化/手动刷新时。
  useEffect(() => {
    if (instanceId === null) {
      setFiles(null)
      setError(null)
      return undefined
    }
    let alive = true
    setLoading(true)
    setError(null)
    listInstanceFiles(instanceId).then(
      (list) => {
        if (!alive) return
        setFiles(list)
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive) return
        setError(messageOf(e))
        setLoading(false)
      },
    )
    return () => { alive = false }
  }, [instanceId, sessionId, refreshKey])

  const tree = useMemo(
    () => (files === null ? null : buildFileTree(files)),
    [files],
  )

  /** 折叠/展开一个目录(不动子孙的独立选择)。 */
  const toggleDir = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  /** 下载到会话工作目录(409 冲突转确认框;overwrite 由确认框重发携带)。 */
  const download = async (relPath: string, overwrite: boolean): Promise<void> => {
    if (instanceId === null) return
    setBusy('正在下载…')
    setError(null)
    setNotice(null)
    try {
      const outcome = await pullInstanceFile(sessionId, instanceId, relPath, 'cwd', overwrite)
      if (outcome.kind === 'existed') {
        setConfirm({ kind: 'overwrite', relPath })
      } else {
        setNotice(`已下载到 ${outcome.localPath}`)
      }
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  /** 预览:落缓存 → dsh-resource 地址 → 现有查看器。 */
  const preview = async (relPath: string): Promise<void> => {
    if (instanceId === null) return
    setBusy('正在准备预览…')
    setError(null)
    setNotice(null)
    try {
      const outcome = await pullInstanceFile(sessionId, instanceId, relPath, 'cache')
      if (outcome.kind !== 'saved') {
        // 缓存目标始终覆盖,existed 只可能是实现违约。
        setError('预览缓存状态异常(不应出现),请重试')
        return
      }
      const cwd = workbench.cwdOfSession(sessionId)
      if (cwd === undefined) {
        setError('无法定位会话工作目录,不能预览;可改用下载')
        return
      }
      tab.actions.openResource(fileAddressFor(sessionId, cwd, outcome.localPath))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  /** 删除云端文件(确认框已把关),成功后刷新清单。 */
  const remove = async (relPath: string): Promise<void> => {
    if (instanceId === null) return
    setBusy('正在删除…')
    setError(null)
    setNotice(null)
    try {
      await deleteInstanceFile(instanceId, relPath)
      setNotice(`已删除 ${relPath}`)
      setRefreshKey(key => key + 1)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  const confirmAccept = (): void => {
    if (confirm === null) return
    const relPath = confirm.relPath
    setConfirm(null)
    void (confirm.kind === 'overwrite' ? download(relPath, true) : remove(relPath))
  }

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.headerMain}>
          <div className={css.title}>实例空间</div>
          <div className={css.subtitle}>
            {instanceId === null ? '未绑定待办' : `流程实例 ${instanceId.slice(0, 13)}…`}
          </div>
        </div>
        <button
          type="button"
          className={css.refresh}
          disabled={instanceId === null || loading || busy !== null}
          onClick={() => { setRefreshKey(key => key + 1) }}
          aria-label="刷新实例空间文件"
          title="刷新"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6"
              fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className={css.body}>
        {instanceId === null
          ? <div className={css.placeholder}>当前会话未绑定待办,没有可用的实例空间</div>
          : (
            <>
              {error !== null && <div className={css.error}>{error}</div>}
              {notice !== null && <div className={css.notice}>{notice}</div>}
              {loading && <div className={css.hint}>加载中…</div>}
              {!loading && tree !== null && tree.children.length === 0 && (
                <div className={css.hint}>实例空间暂无文件 —— 各流程节点写入的文件会实时出现在这里。</div>
              )}
              {tree !== null && tree.children.length > 0 && (
                <div className={css.tree}>
                  {tree.children.map(child => (
                    <TreeNode
                      key={child.file?.relPath ?? child.name}
                      node={child}
                      parentPath=""
                      depth={0}
                      collapsed={collapsed}
                      onToggle={toggleDir}
                      onPreview={(relPath) => { void preview(relPath) }}
                      onDownload={(relPath) => { void download(relPath, false) }}
                      onDelete={(relPath) => { setConfirm({ kind: 'delete', relPath }) }}
                    />
                  ))}
                </div>
              )}
            </>
          )}
      </div>

      {busy !== null && <div className={css.mask}>{busy}</div>}

      {confirm !== null && (
        <Modal open onClose={() => { setConfirm(null) }} title={confirm.kind === 'overwrite' ? '覆盖本地文件' : '删除实例空间文件'} headless={true}>
          <div className={css.dialog}>
            <h3 className={css.dialogTitle}>
              {confirm.kind === 'overwrite' ? '覆盖本地文件' : '删除实例空间文件'}
            </h3>
            <p className={css.dialogText}>
              {confirm.kind === 'overwrite'
                ? `本地已存在同名文件「${confirm.relPath}」,是否覆盖?`
                : `确认删除实例空间文件「${confirm.relPath}」?此操作对所有流程节点生效,不可恢复。`}
            </p>
            <div className={css.dialogActions}>
              <Button variant="ghost" onClick={() => { setConfirm(null) }}>取消</Button>
              <Button
                variant="primary"
                onClick={confirmAccept}
              >
                {confirm.kind === 'overwrite' ? '覆盖' : '删除'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** 树节点 props:节点本身 + 深度/展开态与动作回调。 */
type TreeNodeProps = {
  readonly node: InstanceFileTreeNode
  readonly parentPath: string
  readonly depth: number
  readonly collapsed: ReadonlySet<string>
  readonly onToggle: (path: string) => void
  readonly onPreview: (relPath: string) => void
  readonly onDownload: (relPath: string) => void
  readonly onDelete: (relPath: string) => void
}

/** 一个目录或文件行(目录递归子层)。 */
function TreeNode(props: TreeNodeProps): ReactNode {
  const { node, parentPath, depth, collapsed, onToggle, onPreview, onDownload, onDelete } = props
  const path = dirPathOf(node, parentPath)
  const indent = { paddingLeft: `${depth * 14 + 4}px` }

  if (node.file === undefined) {
    const isCollapsed = collapsed.has(path)
    return (
      <>
        <div className={css.row} style={indent}>
          <button
            type="button"
            className={css.toggle}
            onClick={() => { onToggle(path) }}
            aria-label={isCollapsed ? `展开 ${node.name}` : `折叠 ${node.name}`}
            aria-expanded={!isCollapsed}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden style={isCollapsed ? undefined : { transform: 'rotate(90deg)' }}>
              <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className={css.name}>{node.name}</span>
        </div>
        {!isCollapsed && node.children.map(child => (
          <TreeNode
            key={child.file?.relPath ?? child.name}
            node={child}
            parentPath={path}
            depth={depth + 1}
            collapsed={collapsed}
            onToggle={onToggle}
            onPreview={onPreview}
            onDownload={onDownload}
            onDelete={onDelete}
          />
        ))}
      </>
    )
  }

  const file = node.file
  return (
    <div className={css.row} style={indent}>
      <span className={css.toggleSpacer} />
      <button type="button" className={css.fileButton} onClick={() => { onPreview(file.relPath) }} title={file.relPath}>
        {node.name}
      </button>
      <span className={css.meta}>
        {file.diskMissing && <span className={css.missingTag}>磁盘缺失</span>}
        <span>{formatBytes(file.sizeBytes)}</span>
        {file.uploadedByLabel !== null && <span>{file.uploadedByLabel}</span>}
        <span>{formatShortTime(file.updatedAt)}</span>
      </span>
      <span className={css.rowActions}>
        <button type="button" className={css.action} onClick={() => { onPreview(file.relPath) }} aria-label={`预览 ${node.name}`} title="预览">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path
              d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Zm6.5 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
              fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </button>
        <button type="button" className={css.action} onClick={() => { onDownload(file.relPath) }} aria-label={`下载 ${node.name}`} title="下载到本地">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M8 3v7.7M5 8l3 3 3-3M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className={css.action} onClick={() => { onDelete(file.relPath) }} aria-label={`删除 ${node.name}`} title="删除">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M3 4.5h10M6.5 4.5v-1h3v1M4.5 4.5l.7 8h5.6l.7-8M6.8 7v3.5M9.2 7v3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </span>
    </div>
  )
}
