/**
 * 工作空间文件的「上传到知识库」操作:sidebar.files.entry.action 座位
 * 占据者(design 2026-09-11 §6 工作空间上传)。
 *
 * <p>每个文件行渲染一个上传图标按钮,点击打开对话框:选应用(当前用户
 * 可见的知识库清单 /api/kb/mine)+ 目标文件夹(该库文件夹树,含根)→
 * 确认后经 Remote readBytes 读工作空间文件全文(原生字节,超限走 too-large
 * 失败)→ 重组 File → 经代理 multipart 上传,响应 pending(解析异步)。
 * 上传成功后展示解析状态提示;关闭对话框即中断在途读取。匿名放行态不渲染
 * 本操作(知识库接口要求登录身份,匿名调用只会 401)。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { listFolders, listMyKbs, uploadDocument } from './kb-api.ts'
import type { KbAppSummary, KbDocument, KbFolder } from './kb-api.ts'
import { useAuth, useGuest } from './EnterpriseUi.tsx'
import css from './KbUploadAction.module.css'

/** entry.action 座位注入面:读工作空间文件全文的 Remote 绑定。 */
export type KbUploadInjected = {
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
}

/** entry.action 座位组件 props:owner(path/name)+ session 标准 kit + 注入面。 */
export type KbUploadActionProps =
  & KbUploadInjected
  & {
    /** 文件绝对路径(树根 + 相对位置)。 */
    readonly path: string
    /** 文件名。 */
    readonly name: string
    /** 当前会话(readBytes 的 workspace root 定位)。 */
    readonly sessionId: SessionId
  }

/** 文件夹下拉的缩进标签(path 按层深缩进,根为 (根目录))。 */
function folderLabel(folder: KbFolder): string {
  const depth = folder.path.split('/').filter(part => part !== '').length - 1
  return `${'　'.repeat(Math.max(depth, 0))}${folder.name}`
}

/** 文件行上传按钮 + 对话框(见模块文档);匿名放行态隐藏(知识库接口要求登录身份)。 */
export function KbUploadAction({ readWorkspaceFile, path, name, sessionId }: KbUploadActionProps): ReactNode {
  const { currentUser } = useAuth()
  const guest = useGuest()
  const [open, setOpen] = useState(false)
  // 判定口径与 GuestSidebarCard 一致:currentUser === null && guest 即匿名放行态。
  if (currentUser === null && guest) return null
  return (
    <>
      <button
        type="button"
        className={css.action}
        aria-label={`上传 ${name} 到知识库`}
        title="上传到知识库"
        onClick={() => { setOpen(true) }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M8 11.5V3.8M5 6.5 8 3.5l3 3M3 12.5h10"
            fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <KbUploadDialog
          readWorkspaceFile={readWorkspaceFile}
          path={path}
          name={name}
          sessionId={sessionId}
          onClose={() => { setOpen(false) }}
        />
      )}
    </>
  )
}

/** 上传对话框 props(与 KbUploadAction 同面 + onClose)。 */
type KbUploadDialogProps = KbUploadActionProps & {
  readonly onClose: () => void
}

/** 上传对话框:选应用 + 选文件夹 → 读文件 → 上传(见模块文档)。 */
function KbUploadDialog({ readWorkspaceFile, path, name, sessionId, onClose }: KbUploadDialogProps): ReactNode {
  const [kbs, setKbs] = useState<KbAppSummary[] | null>(null)
  const [folders, setFolders] = useState<KbFolder[] | null>(null)
  const [kbId, setKbId] = useState('')
  const [folderId, setFolderId] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState<KbDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    listMyKbs().then(
      (list) => {
        if (!alive) return
        setKbs(list)
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      },
    )
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (kbId === '') {
      setFolders(null)
      setFolderId('')
      return undefined
    }
    let alive = true
    setError(null)
    listFolders(kbId).then(
      (list) => {
        if (!alive) return
        setFolders(list)
        setFolderId('')
      },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => { alive = false }
  }, [kbId])

  // 关闭对话框时中断在途读取。
  useEffect(() => () => { controllerRef.current?.abort() }, [])

  const confirmUpload = async (): Promise<void> => {
    if (kbId === '') return
    setUploading(true)
    setError(null)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const result = await readWorkspaceFile(sessionId, path, controller.signal)
      if (!result.ok) {
        setError(`读取文件失败：${result.error.message}`)
        return
      }
      const file = new File([result.value.data], name)
      const doc = await uploadDocument(kbId, file, folderId === '' ? null : folderId)
      setUploaded(doc)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      controllerRef.current = null
    }
  }

  return (
    <Modal open onClose={onClose} title="上传到知识库" headless={true} className={css.modal ?? ''}>
      <div className={css.dialog}>
        <div className={css.header}>
          <h3 className={css.title}>上传到知识库</h3>
          <p className={css.subtitle} title={path}>{name}</p>
        </div>
        {uploaded !== null ? (
          <div className={css.result}>
            <p className={css.resultLine}>已上传「{uploaded.name}」，解析进行中（完成后可被检索与引用）。</p>
            <div className={css.actions}>
              <Button variant="primary" onClick={onClose}>完成</Button>
            </div>
          </div>
        ) : (
          <>
            {error !== null && <div className={css.error}>{error}</div>}
            <label className={css.field}>
              <span className={css.fieldLabel}>目标知识库</span>
              <select
                className={css.select}
                value={kbId}
                disabled={loading || uploading}
                onChange={(e) => { setKbId(e.target.value) }}
              >
                <option value="">{loading ? '加载中…' : '(选择应用)'}</option>
                {(kbs ?? []).map(kb => (
                  <option key={kb.kbId} value={kb.kbId}>{kb.applicationName} — {kb.kbName}</option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>目标文件夹</span>
              <select
                className={css.select}
                value={folderId}
                disabled={kbId === '' || folders === null || uploading}
                onChange={(e) => { setFolderId(e.target.value) }}
              >
                <option value="">(根目录)</option>
                {(folders ?? []).map(folder => (
                  <option key={folder.id} value={folder.id}>{folderLabel(folder)}</option>
                ))}
              </select>
            </label>
            <div className={css.actions}>
              <Button variant="ghost" disabled={uploading} onClick={onClose}>取消</Button>
              <Button
                variant="primary"
                disabled={kbId === '' || uploading}
                onClick={() => { void confirmUpload() }}
              >
                {uploading ? '上传中…' : '上传'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
