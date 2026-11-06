/**
 * 模板库入口按钮:挂载在对话输入工具行(conversation.input.left),开合模板画廊。
 *
 * 无 owner 的 session 列表座位,注册时声明 locale: 'settings.ppt'。
 *
 * @module
 */

import type { ReactNode } from 'react'
import { IconFlatListOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { toggleGallery } from './pptState.ts'
import css from './PptGallery.module.css'

/** 入口按钮属性:会话级标准运行时属性 + 设置命名空间文案。 */
export type PptHeroToggleProps = PropsRuntime<'conversation.hero.options'> & PropsLocale<'settings.ppt'>

/**
 * 渲染紧凑的模板库切换按钮。
 *
 * @param props 标准运行时属性与 t。
 * @returns 按钮元素。
 */
export function PptHeroToggle({ t }: PptHeroToggleProps): ReactNode {
  return (
    <button
      type="button"
      className={css.heroToggle}
      aria-label={t('openGallery')}
      title={t('openGallery')}
      onClick={toggleGallery}
    >
      <IconFlatListOutlineMedium size={15} />
      <span>{t('openGallery')}</span>
    </button>
  )
}
