/**
 * 工作空间文件的「上传到实例空间」操作:sidebar.files.entry.action 座位第二
 * 占据者(design 2026-10-14-instance-workspace-design.md §5.3 树上云)。
 *
 * <p>仅绑定待办的会话渲染按钮(未绑定返回 null)。点击打开对话框:目标
 * relPath 默认为文件相对会话工作目录的路径(不在工作目录下则取文件名),
 * 可编辑;确认后经 Remote readBytes 读工作空间文件全文(原生字节,超限走
 * too-large 失败)→ 重组 File → 经代理 multipart 上传到该流程实例的云
 * 工作空间。上传是覆盖语义,提交前查清单,目标已存在时先弹同名确认(与
 * 「下载到本地」的冲突确认对称)。成功后可一键「打开实例空间」查看;关闭
 * 对话框即中断在途读取。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { relativePathUnder, useSessionInstance } from './instance-files-tab.ts'
import { listInstanceFiles, uploadToInstanceWorkspace } from './instance-workspace-api.ts'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import css from './InstanceUploadAction.module.css'

/** entry.action 座位注入面:读工作空间文件全文的 Remote 绑定 + 工作台编排器。 */
export type InstanceUploadInjected = {
  /**
   * 读一个工作空间文件的完整字节(readBytes 无 range;Remote 不拒绝,失败走 result)。
   * @param sessionId - 文件所在会话(定位 workspace root)。
   * @param path - 文件绝对路径(树根 + 相对位置)。
   * @param signal - 调用方取消。
   */
  readonly readWorkspaceFile: (
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
  ) => Promise<RemoteResult<WorkspaceFileBytes<Uint8Array<ArrayBuffer>>>>
  /** 工作台编排器(实例归属判定与「打开实例空间」跳转)。 */
  workbench: EnterpriseWorkbench
}

/** entry.action 座位组件 props:owner(path/name)+ session 标准 kit + 注入面。 */
export type InstanceUploadActionProps =
  & InstanceUploadInjected
  & {
    /** 文件绝对路径(树根 + 相对位置)。 */
    readonly path: string
    /** 文件名。 */
    readonly name: string
    /** 当前会话(readBytes 的 workspace root 定位与实例归属判定)。 */
    readonly sessionId: SessionId
  }

/** 文件行上传按钮 + 对话框(见模块文档)。 */
export function InstanceUploadAction({ readWorkspaceFile, workbench, path, name, sessionId }: InstanceUploadActionProps): ReactNode {
  const instanceId = useSessionInstance(workbench, sessionId)
  const [open, setOpen] = useState(false)
  // 未绑定待办的会话没有实例空间可传,不渲染按钮。
  if (instanceId === null) return null
  return (
    <>
      <button
        type="button"
        className={css.action}
        aria-label={`上传 ${name} 到实例空间`}
        title="上传到实例空间"
        onClick={() => { setOpen(true) }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M8 3.5v7.7M5 6l3-3 3 3M3 12.5h10"
            fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <InstanceUploadDialog
          readWorkspaceFile={readWorkspaceFile}
          workbench={workbench}
          path={path}
          name={name}
          sessionId={sessionId}
          instanceId={instanceId}
          onClose={() => { setOpen(false) }}
        />
      )}
    </>
  )
}

/** 上传对话框 props(与 InstanceUploadAction 同面 + 解析出的实例与 onClose)。 */
type InstanceUploadDialogProps = Omit<InstanceUploadActionProps, 'sessionId'> & {
  readonly sessionId: SessionId
  readonly instanceId: string
  readonly onClose: () => void
}

/** 上传对话框:编辑目标路径 → 读文件 → 上传(见模块文档)。 */
function InstanceUploadDialog({
  readWorkspaceFile, workbench, path, name, sessionId, instanceId, onClose,
}: InstanceUploadDialogProps): ReactNode {
  const cwd = workbench.cwdOfSession(sessionId)
  const [relPath, setRelPath] = useState(() => (cwd === undefined ? name : relativePathUnder(cwd, path) ?? name))
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState(false)
  /** 待确认的覆盖目标;null = 无冲突(或已确认后沿用)。 */
  const [overwriteRelPath, setOverwriteRelPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  // 关闭对话框时中断在途读取。
  useEffect(() => () => { controllerRef.current?.abort() }, [])

  /** 读取本地文件全文并上传(服务端覆盖语义;冲突确认由 confirmUpload 把关)。 */
  const upload = async (signal: AbortSignal): Promise<void> => {
    const result = await readWorkspaceFile(sessionId, path, signal)
    if (!result.ok) {
      setError(`读取文件失败：${result.error.message}`)
      return
    }
    const file = new File([result.value.data], name)
    await uploadToInstanceWorkspace(instanceId, relPath, file)
    setUploaded(true)
  }

  const confirmUpload = async (): Promise<void> => {
    if (cwd === undefined) {
      setError('无法定位会话工作目录,不能读取本地文件')
      return
    }
    setUploading(true)
    setError(null)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      // 上传即覆盖(服务端后写者胜):提交前查清单,目标已存在时先弹确认,与
      // 「下载到本地」的冲突确认对称。按大小写不敏感比对(云端落盘的磁盘不区分
      // 大小写);查询与上传之间他人写入的窗口由服务端原子替换兜底。
      if (overwriteRelPath === null) {
        const files = await listInstanceFiles(instanceId)
        if (files.some(f => f.relPath.toLowerCase() === relPath.toLowerCase())) {
          setOverwriteRelPath(relPath)
          return
        }
      }
      await upload(controller.signal)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      controllerRef.current = null
    }
  }

  return (
    <Modal open onClose={onClose} title="上传到实例空间" headless={true} className={css.modal ?? ''}>
      <div className={css.dialog}>
        <div className={css.header}>
          <h3 className={css.title}>上传到实例空间</h3>
          <p className={css.subtitle} title={path}>{name}</p>
        </div>
        {uploaded ? (
          <div className={css.result}>
            <p className={css.resultLine}>已上传为「{relPath}」，流程各节点可立即在实例空间读取。</p>
            <div className={css.actions}>
              <Button variant="ghost" onClick={() => { workbench.openInstanceFilesTab(sessionId) }}>打开实例空间</Button>
              <Button variant="primary" onClick={onClose}>完成</Button>
            </div>
          </div>
        ) : (
          <>
            {error !== null && <div className={css.error}>{error}</div>}
            {overwriteRelPath !== null ? (
              <>
                <p className={css.resultLine}>实例空间已存在同名文件「{overwriteRelPath}」,是否覆盖?</p>
                <div className={css.actions}>
                  <Button variant="ghost" disabled={uploading} onClick={() => { setOverwriteRelPath(null) }}>取消</Button>
                  <Button variant="primary" disabled={uploading} onClick={() => { void confirmUpload() }}>
                    {uploading ? '上传中…' : '覆盖'}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <label className={css.field}>
                  <span className={css.fieldLabel}>目标路径（实例空间内的相对路径）</span>
                  <input
                    type="text"
                    className={css.input}
                    value={relPath}
                    disabled={uploading}
                    onChange={(e) => { setRelPath(e.target.value) }}
                  />
                </label>
                <div className={css.actions}>
                  <Button variant="ghost" disabled={uploading} onClick={onClose}>取消</Button>
                  <Button variant="primary" disabled={uploading || relPath === ''} onClick={() => { void confirmUpload() }}>
                    {uploading ? '上传中…' : '上传'}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
