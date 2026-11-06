/**
 * 输入框 dock 的模板 chip 座位:选中模板后显示缩略图卡片(预览首图 +
 * 模板名 + 移除按钮),对齐画廊卡片视觉。
 *
 * @module
 */

import type { ReactNode } from 'react'
import { IconCloseOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { stripChipPrefix } from './prefix.ts'
import { clearSelection, pptStore, usePptState } from './pptState.ts'
import { TemplateThumb } from './TemplateThumb.tsx'
import css from './PptGallery.module.css'

/** chip 座位的组件属性:dock 标准运行时属性 + 设置命名空间文案。 */
export type TemplateChipProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'settings.ppt'>

/**
 * 渲染当前模板 chip;未选中时不出占位。
 *
 * @param props dock 标准属性(input/inputActions)与 t。
 * @returns chip 元素;未选中模板时返回 null。
 */
export function TemplateChip({ input, inputActions, t }: TemplateChipProps): ReactNode {
  const { selected } = usePptState()
  if (selected === null) return null
  const remove = (): void => {
    // 事件回调里直接读模块 store 快照,不依赖渲染期闭包。
    const { lastPrefix } = pptStore.getSnapshot()
    if (lastPrefix !== null) {
      const rest = stripChipPrefix(lastPrefix, input.draft)
      if (rest !== undefined) inputActions.setDraft(rest)
    }
    clearSelection()
  }
  return (
    <div className={css.chipRow}>
      <span className={css.chipCard}>
        <TemplateThumb
          item={selected}
          className={css.chipThumb}
          fallbackClassName={css.chipThumbFallback}
        />
        <span className={css.chipName}>{selected.name}</span>
        <button
          type="button"
          className={css.chipRemove}
          aria-label={t('chipRemove', { name: selected.name })}
          onClick={remove}
        >
          <IconCloseOutlineMedium size={12} />
        </button>
      </span>
    </div>
  )
}
