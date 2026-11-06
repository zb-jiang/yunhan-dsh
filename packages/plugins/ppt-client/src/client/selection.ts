/**
 * 选中模板的衔接流程:Python 就绪检测 → 前缀写入草稿 → 记录选中。
 *
 * 画廊卡片点击与预览器「用这个模板生成」共用;未就绪时只拉起引导,不插
 * 前缀也不改选中状态(设计 §5.5:未就绪阻断并引导)。
 *
 * @module
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { applyChipPrefix } from './prefix.ts'
import { openGuide, pptStore, selectTemplate } from './pptState.ts'
import { fetchPythonReady, type PptTemplateItem } from './useTemplates.ts'

/**
 * 选中一个模板并把它衔接进输入框草稿。
 *
 * @param item 选中的模板清单项(id 即 style_id,出厂与新增同构)。
 * @param draft 当前输入框草稿(dock owner 的 InputState.draft)。
 * @param setDraft 覆写整个草稿的 dock 标准动作。
 * @param t 设置命名空间文案(生成 chipPrefix)。
 */
export async function chooseTemplate(
  item: PptTemplateItem,
  draft: string,
  setDraft: (text: string) => void,
  t: TranslateNS<'settings.ppt'>,
): Promise<void> {
  const ready = await fetchPythonReady()
  if (!ready) {
    openGuide()
    return
  }
  const { lastPrefix } = pptStore.getSnapshot()
  const prefix = t('chipPrefix', { name: item.name, ref: item.id })
  const composed = applyChipPrefix(draft, lastPrefix, prefix)
  // 前缀对不上(用户改动过)时不写草稿,只更新选中状态;lastPrefix 传 null
  // 让下一次换选/移除跳过剥离。
  if (composed.applied) setDraft(composed.draft)
  selectTemplate(
    { id: item.id, name: item.name, previewUrlTemplate: item.previewUrlTemplate },
    composed.applied ? prefix : null,
  )
}
