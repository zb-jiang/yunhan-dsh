/**
 * PPT 插件客户端入口:设置卡片、输入工具行的模板库入口、输入框
 * dock 的模板 chip 与画廊座位(chip 衔接、预览查看器、上传对话框、Python
 * 引导均由画廊座位承载)。挂载点全部由 ui-conversation 现有声明提供,
 * 无需新增 slot;文案统一走 `settings.ppt` 命名空间。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: 拉入 ui-renderer 的 Context 增强(ctx.slots 服务类型)。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: 拉入 ui-settings 的 SlotMap 声明('settings.section' 座位类型)。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: 拉入 locale 插件的 Context 增强(ctx.locale)与命名空间合并点。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: 拉入 ui-conversation 的 SlotMap 声明(conversation.* 座位类型)。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: 拉入 ui-session 的会话级标准属性合并(sessionId/useSession 等)。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, zh, type PptSettingsKey } from './locales.ts'
import { PptSettingsCard } from './PptSettingsCard.tsx'
import { PptHeroToggle } from './PptHeroToggle.tsx'
import { TemplateChip } from './TemplateChip.tsx'
import { TemplateGallery } from './TemplateGallery.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PPT 设置卡片与模板库文案。 */
    'settings.ppt': PptSettingsKey
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('settings.ppt', { zh, en }), 'ppt-client: settings dictionaries')
  // 座位由 ui-settings 声明,经 slots.inject 延迟到声明后注册。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ppt-image-config',
    order: 40,
    label: () => ctx.locale.bind('settings.ppt')('nav'),
    locale: 'settings.ppt',
    inject: () => ({}),
  }, PptSettingsCard))
  // 对话输入工具行的模板库入口(同一组件;hero options 入口已按产品要求移除)。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'ppt-gallery-toggle',
    order: 10,
    locale: 'settings.ppt',
  }, PptHeroToggle))
  // 输入框 dock:模板 chip 座位(选中态),位于画廊面板之前。
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'ppt-chip',
    order: 5,
    locale: 'settings.ppt',
  }, TemplateChip))
  // 输入框 dock:模板画廊座位(面板 + 预览/上传/引导覆盖层)。
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'ppt-gallery',
    order: 6,
    locale: 'settings.ppt',
  }, TemplateGallery))
}
