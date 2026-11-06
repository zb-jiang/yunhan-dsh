/**
 * 模板预览查看器:逐页浏览模板渲染页并确认选用。
 *
 * 由画廊座位在 viewerId 命中清单项时渲染;父级以 viewerId 作 key 保证
 * 换模板时页码回到第 1 页。
 *
 * @module
 */

import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { previewPageUrl, type PptTemplateItem, type PptTranslate } from './useTemplates.ts'
import css from './PptGallery.module.css'

/** 查看器组件属性。 */
export interface TemplateViewerProps {
  /** 被预览的模板清单项。 */
  item: PptTemplateItem
  /** 设置命名空间文案。 */
  t: PptTranslate
  /** 关闭查看器。 */
  onClose: () => void
  /** 确认选用该模板(走 chip 衔接流程)。 */
  onUse: (item: PptTemplateItem) => void
}

/**
 * 渲染预览对话框:当前页大图、翻页与选用动作。
 *
 * @param props 查看器属性。
 * @returns 对话框元素。
 */
export function TemplateViewer({ item, t, onClose, onUse }: TemplateViewerProps): ReactNode {
  const [page, setPage] = useState(1)
  const [imageError, setImageError] = useState(false)
  const total = Math.max(item.pageCount, 1)
  const goto = (next: number): void => {
    setPage(Math.min(Math.max(next, 1), total))
    setImageError(false)
  }
  return (
    <Modal open onClose={onClose} title={item.name} closeLabel={t('close')} className={css.viewerDialog ?? ''}>
      <div className={css.viewerImageWrap}>
        {imageError
          ? <div className={css.viewerFallback}>{t('viewerLoadError')}</div>
          : (
            <img
              className={css.viewerImage}
              src={previewPageUrl(item, page)}
              alt={t('viewerImageAlt', { name: item.name })}
              onError={() => { setImageError(true) }}
            />
          )}
      </div>
      <div className={css.viewerNav}>
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => { goto(page - 1) }}>
          {t('viewerPrev')}
        </Button>
        <span className={css.viewerPageIndicator}>{t('viewerPage', { current: page, total })}</span>
        <Button variant="outline" size="sm" disabled={page >= total} onClick={() => { goto(page + 1) }}>
          {t('viewerNext')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => { onUse(item) }}>
          {t('viewerUse')}
        </Button>
      </div>
    </Modal>
  )
}
