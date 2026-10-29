/**
 * 企业文件编辑器 — 右栏文件预览的 CodeMirror 6 编辑体。
 *
 * 由 index.ts 以 extension 优先级注册（覆盖同后缀的官方只读预览），宿主以
 * bytes-complete 模式整读文件内容。外层组件只做内容解码与地址判定（非
 * bytes 内容渲染为空，非 UTF-8 文本显示错误，session 文件才得到保存目标），
 * EditorSurface 持有 CodeMirror 视图与状态条。Ctrl+S（或状态条按钮）经注
 * 入的 saveFile 保存；保存时把 version 钉住（首次取元数据版本，之后取上次
 * 保存返回的新版本），外部已改动时服务端报 stale-version，由错误文案引导
 * 重载。
 */
import { basicSetup, EditorView } from 'codemirror'
import { keymap } from '@codemirror/view'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { EnterpriseFileWriteRequest } from '@deepseek-ai/dsh-enterprise-file-write/types'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import styles from './EnterpriseFileEditor.module.css'

/** 编辑体在 sidebar.right.tab.document 插槽里的唯一 key。 */
export const ENTERPRISE_FILE_EDITOR_ID = 'enterprise-file-editor'

/** 可编辑的文件后缀清单；definition 的 extensions 与之一致。 */
export const ENTERPRISE_FILE_EDITOR_EXTENSIONS: readonly string[] = [
  'md', 'markdown', 'json', 'html', 'htm',
  'txt', 'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'css', 'scss', 'less', 'py', 'java', 'kt', 'go', 'rs',
  'c', 'h', 'cpp', 'cs', 'sh', 'ps1', 'bat', 'cmd',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'xml', 'sql', 'vue', 'rb', 'php',
]

/** 保存成功结果：新版本号由服务端返回，后续保存必须带上。 */
export interface EnterpriseFileSaveSuccess {
  readonly ok: true
  readonly version: string
  readonly absolutePath: string
}

/** 保存失败结果：code 对应 enterprise-file/* 与 gateway/bad-request 错误码。 */
export interface EnterpriseFileSaveFailure {
  readonly ok: false
  readonly code: string
  readonly message: string
}

/** saveFile 的结果类型（不 reject,结果承载失败）。 */
export type EnterpriseFileSaveOutcome = EnterpriseFileSaveSuccess | EnterpriseFileSaveFailure

/** 由 index.ts 注入的保存通道；sessionId 为普通 string（组件层不做 branded 断言）。 */
export interface EnterpriseFileEditorInjected {
  readonly saveFile: (
    sessionId: string,
    request: EnterpriseFileWriteRequest,
    signal?: AbortSignal,
  ) => Promise<EnterpriseFileSaveOutcome>
}

export type EnterpriseFileEditorProps = DocumentPreviewProps & EnterpriseFileEditorInjected

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string }

/** 服务端错误码 → 中文提示；未识别的码回落到服务端 message。 */
export function describeSaveFailure(code: string, message: string): string {
  switch (code) {
    case 'enterprise-file/stale-version': return '文件已被其他人修改,请刷新预览后重试'
    case 'enterprise-file/outside-workspace': return '文件在工作空间之外,不能保存'
    case 'enterprise-file/too-large': return '文件内容超过大小限制,不能保存'
    case 'enterprise-file/session-not-found': return '会话不存在或已结束,不能保存'
    case 'enterprise-file/denied': return '没有保存该文件的权限'
    case 'gateway/bad-request': return '保存请求不合法'
    default: return message.length > 0 ? message : '保存失败'
  }
}

function languageFor(path: string | undefined) {
  if (path === undefined) return []
  const dot = path.toLowerCase().lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return markdown()
  if (ext === 'json') return json()
  if (ext === 'html' || ext === 'htm') return html()
  return []
}

/** EditorSurface 收敛后的入参：地址已解析、内容已确认是可解码文本。 */
interface EditorSurfaceProps {
  readonly text: string
  /** 解析出的文件路径；地址无法解析时为 undefined（仅影响语言高亮）。 */
  readonly path: string | undefined
  /** session 文件的保存目标；其他 scope 无保存通道。 */
  readonly target: { readonly sessionId: string; readonly path: string } | undefined
  /** 宿主元数据带的文件版本；首次保存没有钉住版本时作为 expectedVersion 回落。 */
  readonly initialVersion: string | undefined
  readonly saveFile: EnterpriseFileEditorInjected['saveFile']
}

/** 编辑体视图：CodeMirror 6 挂载、Ctrl+S keymap 与保存状态条。 */
function EditorSurface({ text, path, target, initialVersion, saveFile }: EditorSurfaceProps): ReactNode {
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  // 挂载用 ref 回调转 state：首次 render 以 host=null 跑一次 effect（不挂视图），
  // setHost 触发重渲染后再以真实节点跑一次，两个分支天然覆盖。
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  // 当前文档文本：视图创建时钉为初始 text，docChanged 时跟随更新；保存读
  // 这里而不是 view，保存逻辑与视图生命周期解耦。
  const docRef = useRef(text)

  // latest-ref：插槽工厂每次 render 重跑,saveFile/target/initialVersion 引用
  // 都会变化,keymap 回调与保存逻辑持久的只有 ref 对象本身。
  const saveFileRef = useRef(saveFile)
  saveFileRef.current = saveFile
  const targetRef = useRef(target)
  targetRef.current = target
  const initialVersionRef = useRef(initialVersion)
  initialVersionRef.current = initialVersion
  // 钉住的保存版本：undefined 时回落到元数据版本;保存成功后换成服务端返回的
  // 新版本,元数据刷新迟到也不影响连续保存。
  const versionRef = useRef<string | undefined>(undefined)
  const savingRef = useRef(false)

  const performSave = async (): Promise<void> => {
    if (savingRef.current) return
    const current = targetRef.current
    if (current === undefined) {
      setSaveState({ kind: 'error', message: '该文件不支持保存' })
      return
    }
    savingRef.current = true
    setSaveState({ kind: 'saving' })
    try {
      const expectedVersion = versionRef.current ?? initialVersionRef.current
      const outcome = await saveFileRef.current(current.sessionId, {
        path: current.path,
        content: docRef.current,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      })
      if (outcome.ok) {
        versionRef.current = outcome.version
        setDirty(false)
        setSaveState({ kind: 'saved' })
      } else {
        setSaveState({ kind: 'error', message: describeSaveFailure(outcome.code, outcome.message) })
      }
    } catch (error) {
      setSaveState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      savingRef.current = false
    }
  }
  const saveRef = useRef(performSave)
  saveRef.current = performSave

  useEffect(() => {
    if (host === null) return
    const view = new EditorView({
      doc: text,
      extensions: [
        // keymap 恒挂载：非 session 文件按 Ctrl+S 也走 performSave,由 target
        // 守卫给出「不支持保存」的明确反馈,而不是吞掉快捷键。
        keymap.of([{
          key: 'Mod-s',
          run: () => { void saveRef.current(); return true },
        }]),
        EditorView.lineWrapping,
        languageFor(path),
        oneDark,
        basicSetup,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            docRef.current = update.state.doc.toString()
            setDirty(true)
          }
        }),
      ],
      parent: host,
    })
    docRef.current = text
    setDirty(false)
    return () => { view.destroy() }
    // path 与 text 同源（resourceAddress/content）,一起构成重建条件。
  }, [host, text, path])

  const editable = target !== undefined
  const statusText = saveState.kind === 'saving' ? '正在保存…'
    : saveState.kind === 'saved' ? '已保存'
      : saveState.kind === 'error' ? saveState.message
        : dirty ? '有未保存的更改(Ctrl+S 保存)'
          : editable ? ''
            : '该文件不支持保存'
  const statusClass = saveState.kind === 'error' ? styles.statusError : styles.statusInfo

  return (
    <div className={styles.wrapper}>
      <div ref={setHost} className={styles.editorHost} />
      <div className={styles.statusBar}>
        <span className={statusClass}>{statusText}</span>
        <button
          type="button"
          className={styles.saveButton}
          disabled={!editable || saveState.kind === 'saving'}
          onClick={() => { void saveRef.current() }}
        >
          保存
        </button>
      </div>
    </div>
  )
}

/** 右栏文件编辑体：内容解码与地址判定在外层收敛,编辑视图在 EditorSurface。 */
export function EnterpriseFileEditor(props: EnterpriseFileEditorProps): ReactNode {
  const { content, resourceAddress, version, saveFile } = props
  const parsed = useMemo(() => parseFileAddress(resourceAddress), [resourceAddress])
  const decoded = useMemo((): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } | undefined => {
    if (content.kind !== 'bytes') return undefined
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(content.data) }
    } catch {
      return { ok: false, error: '文件不是有效的 UTF-8 文本,无法编辑' }
    }
  }, [content])

  if (decoded === undefined) return null
  if (!decoded.ok) {
    return (
      <div className={styles.wrapper}>
        <p className={styles.statusLine}>{decoded.error}</p>
      </div>
    )
  }
  const target = parsed !== undefined && parsed.scope === 'session'
    ? { sessionId: parsed.sessionId, path: parsed.path }
    : undefined
  return (
    <EditorSurface
      text={decoded.text} path={parsed?.path} target={target} initialVersion={version} saveFile={saveFile}
    />
  )
}
