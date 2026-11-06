/**
 * 模板首屏缩略图:取预览第 1 页,加载失败时显示占位块。画廊卡片与
 * 输入框 chip 卡共用。
 *
 * @module
 */

import { useState, type ReactNode } from 'react'
import { previewPageUrl, type PptTemplateItem } from './useTemplates.ts'

/** 缩略图组件属性。 */
export interface TemplateThumbProps {
  /** 模板清单项(或含预览 URL 模板的片段)。 */
  item: Pick<PptTemplateItem, 'previewUrlTemplate'>
  /** 图片元素附加的 class(CSS module 类名可能为 undefined)。 */
  className?: string | undefined
  /** 占位块附加的 class。 */
  fallbackClassName?: string | undefined
}

/**
 * 渲染模板缩略图。
 *
 * @param props 缩略图属性。
 * @returns 图片或占位块元素。
 */
export function TemplateThumb({ item, className, fallbackClassName }: TemplateThumbProps): ReactNode {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className={fallbackClassName} />
  return (
    <img
      className={className}
      src={previewPageUrl(item, 1)}
      alt=""
      onError={() => { setFailed(true) }}
    />
  )
}
