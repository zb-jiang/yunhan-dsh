/**
 * 输入框 dock 的模板画廊座位:分类 tab + 模板卡片网格 + 新增模板入口,
 * 并承载预览查看器、新增对话框与 Python 引导三个覆盖层(由画廊或
 * chip 衔接触发,需在画廊收起后仍然可见)。
 *
 * @module
 */

import { useEffect, useState, type ReactNode } from 'react'
import {
  IconCloseOutlineMedium,
  IconInspectOutlineMedium,
  IconProjectAddOutlineMedium,
  IconTrashOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { chooseTemplate } from './selection.ts'
import {
  bumpTemplates,
  closeGallery,
  closeGuide,
  closeUpload,
  closeViewer,
  openUpload,
  openViewer,
  usePptState,
} from './pptState.ts'
import { useTemplates, type PptTemplateCategory, type PptTemplateItem } from './useTemplates.ts'
import { TemplateThumb } from './TemplateThumb.tsx'
import { TemplateViewer } from './TemplateViewer.tsx'
import { UploadDialog } from './UploadDialog.tsx'
import { PythonGuide } from './PythonGuide.tsx'
import css from './PptGallery.module.css'

/** 画廊座位组件属性:dock 标准运行时属性 + 设置命名空间文案。 */
export type TemplateGalleryProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'settings.ppt'>

/** 分类 tab 的键:'all' 或六类之一。 */
type GalleryTab = 'all' | PptTemplateCategory

const TABS: { key: GalleryTab; labelKey: 'tabAll' | 'catBusiness' | 'catMarketing' | 'catConsulting' | 'catAcademic' | 'catWork' | 'catPersonal' }[] = [
  { key: 'all', labelKey: 'tabAll' },
  { key: 'business', labelKey: 'catBusiness' },
  { key: 'marketing', labelKey: 'catMarketing' },
  { key: 'consulting', labelKey: 'catConsulting' },
  { key: 'academic', labelKey: 'catAcademic' },
  { key: 'work', labelKey: 'catWork' },
  { key: 'personal', labelKey: 'catPersonal' },
]

/**
 * 渲染画廊座位:面板(开合)+ 三个覆盖层。
 *
 * @param props dock 标准属性(input/inputActions)与 t。
 * @returns 座位内容;全部关闭时为 null。
 */
export function TemplateGallery({ input, inputActions, t }: TemplateGalleryProps): ReactNode {
  const state = usePptState()
  const templates = useTemplates()
  const [tab, setTab] = useState<GalleryTab>('all')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [deleteFailed, setDeleteFailed] = useState(false)

  // Esc 收起画廊;任一对话框开着时 Esc 归 Modal 处理,避免一次按键连关两层。
  useEffect(() => {
    if (!state.galleryOpen) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (state.viewerId !== null || state.uploadOpen || state.guideOpen) return
      closeGallery()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [state.galleryOpen, state.viewerId, state.uploadOpen, state.guideOpen])

  const choose = (item: PptTemplateItem): void => {
    void chooseTemplate(item, input.draft, (text) => { inputActions.setDraft(text) }, t)
  }

  const removeTemplate = async (id: string): Promise<void> => {
    setPendingDeleteId(null)
    try {
      const response = await fetch(`api/ppt/templates/${id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`template delete status ${String(response.status)}`)
      setDeleteFailed(false)
      bumpTemplates()
    } catch {
      setDeleteFailed(true)
    }
  }

  const items = tab === 'all'
    ? templates.templates
    : templates.templates.filter(item => item.category === tab)
  const viewerItem = state.viewerId === null
    ? undefined
    : templates.templates.find(item => item.id === state.viewerId)

  return (
    <>
      {state.galleryOpen && (
        <section className={css.gallery}>
          {state.guideReadyHint && <p className={css.galleryHint}>{t('guideReadyHint')}</p>}
          <div className={css.galleryHead}>
            <h4 className={css.galleryTitle}>{t('openGallery')}</h4>
            <button type="button" className={css.galleryClose} aria-label={t('close')} onClick={closeGallery}>
              <IconCloseOutlineMedium size={14} />
            </button>
          </div>
          <div className={css.tabRow}>
            {TABS.map(entry => (
              <button
                key={entry.key}
                type="button"
                className={tab === entry.key ? `${css.tab} ${css.tabActive}` : css.tab}
                onClick={() => { setTab(entry.key) }}
              >
                {t(entry.labelKey)}
              </button>
            ))}
          </div>
          {templates.loading && <p className={css.galleryNotice}>{t('galleryLoading')}</p>}
          {templates.error && (
            <p className={`${css.galleryNotice} ${css.galleryError}`}>
              {t('galleryLoadError')}
              <button type="button" className={css.galleryRetryButton} onClick={bumpTemplates}>
                {t('galleryRetry')}
              </button>
            </p>
          )}
          {!templates.loading && !templates.error && items.length === 0 && (
            <p className={css.galleryNotice}>{t('galleryEmpty')}</p>
          )}
          {!templates.loading && !templates.error && items.length > 0 && (
            <div className={css.grid}>
              {items.map(item => (
                <div
                  key={item.id}
                  className={state.selected?.id === item.id ? `${css.card} ${css.cardSelected}` : css.card}
                >
                  <button type="button" className={css.cardPick} title={item.name} onClick={() => { choose(item) }}>
                    <TemplateThumb item={item} className={css.thumb} fallbackClassName={css.thumbFallback} />
                    <span className={css.cardMeta}>
                      <span className={css.cardName}>{item.name}</span>
                      <span className={css.cardPages}>{t('pageCountLabel', { count: item.pageCount })}</span>
                    </span>
                  </button>
                  {pendingDeleteId === item.id
                    ? (
                      <div className={css.confirmRow}>
                        <span className={css.confirmText}>{t('deleteConfirm')}</span>
                        <button type="button" className={css.confirmButton} onClick={() => { void removeTemplate(item.id) }}>
                          {t('deleteYes')}
                        </button>
                        <button type="button" className={css.cancelButton} onClick={() => { setPendingDeleteId(null) }}>
                          {t('deleteCancel')}
                        </button>
                      </div>
                    )
                    : (
                      <div className={css.cardBody}>
                        <span className={css.originBadge}>{t('originBuiltIn')}</span>
                        <span className={css.cardActions}>
                          <button
                            type="button"
                            className={css.iconButton}
                            aria-label={t('previewLabel', { name: item.name })}
                            onClick={() => { openViewer(item.id) }}
                          >
                            <IconInspectOutlineMedium size={14} />
                          </button>
                          {item.origin === 'added' && (
                            <button
                              type="button"
                              className={`${css.iconButton} ${css.iconButtonDanger}`}
                              aria-label={t('deleteLabel', { name: item.name })}
                              onClick={() => { setPendingDeleteId(item.id) }}
                            >
                              <IconTrashOutlineMedium size={14} />
                            </button>
                          )}
                        </span>
                      </div>
                    )}
                </div>
              ))}
              <button type="button" className={css.uploadCard} onClick={openUpload}>
                <IconProjectAddOutlineMedium size={15} />
                {t('uploadCard')}
              </button>
            </div>
          )}
          {deleteFailed && <p className={`${css.galleryNotice} ${css.galleryError}`}>{t('deleteError')}</p>}
        </section>
      )}
      {viewerItem !== undefined && (
        <TemplateViewer
          key={state.viewerId}
          item={viewerItem}
          t={t}
          onClose={closeViewer}
          onUse={(item) => { choose(item) }}
        />
      )}
      {state.uploadOpen && <UploadDialog t={t} setDraft={(text) => { inputActions.setDraft(text) }} lockedCategory={tab === 'all' ? undefined : tab} onClose={closeUpload} />}
      {state.guideOpen && <PythonGuide t={t} onClose={closeGuide} />}
    </>
  )
}
