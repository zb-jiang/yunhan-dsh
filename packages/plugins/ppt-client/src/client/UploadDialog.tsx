/**
 * 新增模板对话框(设计 2026-11-05):上传参考 .pptx + 填 style slug/
 * 显示名/分类 → 提炼指令写入草稿 → 登记新增 style。
 *
 * 提炼产物的工作空间由用户发送指令的那次会话决定(extraction 的
 * importFromWorkspace 读 `<workspace>/ppt-template`,客户端无从得知该
 * 路径),因此登记走「粘贴工作空间路径」而不是固定路径。
 *
 * @module
 */

import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { bumpTemplates } from './pptState.ts'
import { useTemplates, type PptTemplateCategory, type PptTranslate } from './useTemplates.ts'
import css from './PptGallery.module.css'

/** 与宿主 rpc 的 MAX_UPLOAD_BYTES 保持一致的协议上限(50MB)。 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** 与宿主 templates.ts 的 SLUG_PATTERN 保持一致的 slug 前检规则。 */
const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,63}$/

/** 上传对话框组件属性。 */
export interface UploadDialogProps {
  /** 设置命名空间文案。 */
  t: PptTranslate
  /** 覆写输入框草稿(写入提炼指令),来自 dock 标准动作。 */
  setDraft: (text: string) => void
  /** 从特定分类 tab 打开时锁定的分类;'all' 或未传时由表单自选。 */
  lockedCategory?: PptTemplateCategory | undefined
  /** 关闭对话框。 */
  onClose: () => void
}

interface UploadPayload {
  uploadPath: string
  prompt: string
}

/** 与宿主一致的参考文件扩展名(pptx 提炼走原生解析,pdf 走会话侧读取)。 */
const REFERENCE_EXTENSIONS = ['.pptx', '.pdf']

/** 分类值 → locale key 的显式映射(锁定分类的只读展示用)。 */
const CATEGORY_LABEL_KEYS: Record<PptTemplateCategory, 'catBusiness' | 'catMarketing' | 'catConsulting' | 'catAcademic' | 'catWork' | 'catPersonal'> = {
  business: 'catBusiness',
  marketing: 'catMarketing',
  consulting: 'catConsulting',
  academic: 'catAcademic',
  work: 'catWork',
  personal: 'catPersonal',
}

/** 登记端点错误响应里携带的业务码(slug 撞名与满额同为 409,靠 code 区分)。 */
interface ImportErrorBody {
  error?: string
  code?: string
}

/**
 * 暂存态的模块级持久化:上传成功后用户要关掉对话框去会话里发送提炼
 * 指令(模态会挡住输入框),AI 产完后重开对话框完成登记。对话框随开关
 * 挂卸,登记入口、已粘贴的路径与已填的 slug/显示名/分类必须活过一次
 * 挂卸,否则登记无从进行(分类还要保持原值不可改)。
 */
let stagedFromUpload = false
let savedWorkspace = ''
let savedSlug = ''
let savedName = ''
let savedCategory: PptTemplateCategory | '' = ''

/**
 * 渲染新增模板对话框:选文件、填表单、上传生成提炼指令、粘贴工作空间
 * 路径登记。
 *
 * @param props 上传对话框属性。
 * @returns 对话框元素。
 */
export function UploadDialog({ t, setDraft, lockedCategory, onClose }: UploadDialogProps): ReactNode {
  const { templates } = useTemplates()
  const [file, setFile] = useState<File | null>(null)
  const [slug, setSlugState] = useState(savedSlug)
  const [name, setNameState] = useState(savedName)
  const [category, setCategoryState] = useState<PptTemplateCategory>(lockedCategory ?? (savedCategory !== '' ? savedCategory : 'business'))
  // 分类锁定:tab 带入,或暂存登记期间保持原值——锁定时展示为纯文本。
  const lockedCategoryValue = lockedCategory ?? (stagedFromUpload && savedCategory !== '' ? savedCategory : null)
  const [formError, setFormError] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadFailed, setUploadFailed] = useState(false)
  const [promptStaged, setPromptStaged] = useState(stagedFromUpload)
  const [workspace, setWorkspaceState] = useState(savedWorkspace)
  const [importing, setImporting] = useState(false)
  const [importOk, setImportOk] = useState(false)
  const [importErrorCode, setImportErrorCode] = useState<'invalid' | 'conflict' | 'limit' | 'error' | null>(null)
  // 表单值写穿模块级持久:对话框随开关挂卸,重开时要带出上次填写值。
  const setSlug = (next: string): void => {
    savedSlug = next
    setSlugState(next)
  }
  const setName = (next: string): void => {
    savedName = next
    setNameState(next)
  }
  const setCategory = (next: PptTemplateCategory): void => {
    savedCategory = next
    setCategoryState(next)
  }
  const setWorkspace = (next: string): void => {
    savedWorkspace = next
    setWorkspaceState(next)
  }

  const onFileChange = (next: File | null): void => {
    setUploadFailed(false)
    setFileError(null)
    if (next === null) {
      setFile(null)
      return
    }
    // 客户端只做体积/扩展名预检;校验失败不发请求,真正的校验在宿主。
    if (!REFERENCE_EXTENSIONS.some(ext => next.name.toLowerCase().endsWith(ext))) {
      setFileError(t('fileNotSupported'))
      return
    }
    if (next.size > MAX_UPLOAD_BYTES) {
      setFileError(t('fileTooLarge'))
      return
    }
    setFile(next)
  }

  const upload = async (): Promise<void> => {
    if (file === null) return
    // 表单前检:slug 格式与全域唯一、显示名非空;失败不发请求。
    if (!SLUG_PATTERN.test(slug)) {
      setFormError(t('slugInvalid'))
      return
    }
    if (templates.some(item => item.id === slug)) {
      setFormError(t('slugTaken'))
      return
    }
    if (name.trim() === '') {
      setFormError(t('nameRequired'))
      return
    }
    setFormError(null)
    setUploading(true)
    setUploadFailed(false)
    // tab 锁定分类时用户未经过 setCategory,上传时补记,暂存重开后可带出。
    savedCategory = category
    try {
      // 文件名与表单字段都走查询串:HTTP header 值仅允许 latin1,中文
      // 文件名放 header 会让 fetch 直接抛 Invalid header value。
      const query = new URLSearchParams({ slug, name: name.trim(), category, filename: file.name })
      const response = await fetch(`api/ppt/uploads?${query.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      })
      if (!response.ok) throw new Error(`upload status ${String(response.status)}`)
      const payload = (await response.json()) as UploadPayload
      setDraft(payload.prompt)
      stagedFromUpload = true
      setPromptStaged(true)
    } catch {
      setUploadFailed(true)
    } finally {
      setUploading(false)
    }
  }

  const register = async (): Promise<void> => {
    setImporting(true)
    setImportOk(false)
    setImportErrorCode(null)
    try {
      const response = await fetch('api/ppt/templates/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ImportErrorBody
        setImportErrorCode(body.code === 'slug-conflict'
          ? 'conflict'
          : response.status === 422
            ? 'invalid'
            : response.status === 409
              ? 'limit'
              : 'error')
        return
      }
      setImportOk(true)
      bumpTemplates()
      // 登记完成:清暂存态与全部表单值,下次重开对话框回到全新表单。
      stagedFromUpload = false
      savedWorkspace = ''
      savedSlug = ''
      savedName = ''
      savedCategory = ''
    } catch {
      setImportErrorCode('error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('uploadTitle')} closeLabel={t('close')}>
      <p className={css.dialogHint}>{t('uploadHint')}</p>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="ppt-upload-slug">{t('slugLabel')}</label>
        <input
          id="ppt-upload-slug"
          className={css.formInput}
          type="text"
          value={slug}
          onChange={(event) => { setSlug(event.target.value); setFormError(null) }}
        />
        <p className={css.formHint}>{t('slugHint')}</p>
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="ppt-upload-name">{t('nameLabel')}</label>
        <input
          id="ppt-upload-name"
          className={css.formInput}
          type="text"
          value={name}
          onChange={(event) => { setName(event.target.value); setFormError(null) }}
        />
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="ppt-upload-category">{t('categoryLabel')}</label>
        {lockedCategoryValue !== null ? (
          // 锁定分类只读展示:tab 带入或暂存登记期,不允许下拉修改。
          <span className={css.formStatic}>{t(CATEGORY_LABEL_KEYS[lockedCategoryValue])}</span>
        ) : (
          <select
            id="ppt-upload-category"
            className={css.formInput}
            value={category}
            onChange={(event) => { setCategory(event.target.value as PptTemplateCategory) }}
          >
            <option value="business">{t('catBusiness')}</option>
            <option value="marketing">{t('catMarketing')}</option>
            <option value="consulting">{t('catConsulting')}</option>
            <option value="academic">{t('catAcademic')}</option>
            <option value="work">{t('catWork')}</option>
            <option value="personal">{t('catPersonal')}</option>
          </select>
        )}
      </div>
      {formError !== null && <p className={css.dialogError}>{formError}</p>}
      <div className={css.uploadFileRow}>
        <input type="file" accept=".pptx,.pdf" aria-label={t('uploadPick')} onChange={(event) => { onFileChange(event.target.files?.[0] ?? null) }} />
        {file !== null && <span className={css.uploadFileName}>{file.name}</span>}
      </div>
      {fileError !== null && <p className={css.dialogError}>{fileError}</p>}
      <div className={css.uploadActions}>
        <Button variant="primary" size="sm" disabled={file === null || uploading} onClick={() => { void upload() }}>
          {uploading ? t('uploading') : t('uploadAction')}
        </Button>
        {uploadFailed && <span className={css.dialogError}>{t('uploadError')}</span>}
      </div>
      {promptStaged && (
        <>
          <p className={css.uploadDone}>{t('uploadDone')}</p>
          <div className={css.importBlock}>
            <p className={css.dialogHint}>{t('importHint')}</p>
            <div className={css.importRow}>
              <input
                className={css.importInput}
                type="text"
                value={workspace}
                placeholder={t('importWorkspacePlaceholder')}
                aria-label={t('importAction')}
                onChange={(event) => { setWorkspace(event.target.value); setImportErrorCode(null); setImportOk(false) }}
              />
              <Button variant="primary" size="sm" disabled={workspace.trim() === '' || importing} onClick={() => { void register() }}>
                {importing ? t('importing') : t('importAction')}
              </Button>
            </div>
            {importOk && <p className={css.uploadDone}>{t('importOk')}</p>}
            {importErrorCode !== null && (
              <p className={css.dialogError}>
                {importErrorCode === 'invalid'
                  ? t('importInvalid')
                  : importErrorCode === 'conflict'
                    ? t('importConflict')
                    : importErrorCode === 'limit'
                      ? t('importLimit')
                      : t('importError')}
              </p>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
