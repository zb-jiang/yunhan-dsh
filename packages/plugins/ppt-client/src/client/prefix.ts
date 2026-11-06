/**
 * 模板 chip 前缀在输入框草稿中的拼接与剥离。
 *
 * 前缀独占草稿首行;换选/移除时按 {@link stripChipPrefix} 从草稿开头精确
 * 剥离上一次插入的全文,用户已改动导致对不上时不强行剥离。
 *
 * @module
 */

/** 剥离结果:stripped 为剥掉前缀后的剩余草稿;开头对不上时为 undefined。 */
export type StripResult = { stripped: string } | { stripped: undefined }

/**
 * 从草稿开头剥离先前插入的 chip 前缀(含其后一个换行)。
 *
 * @param prefix 先前插入的前缀全文。
 * @param draft 当前输入框草稿。
 * @returns 剥离后的剩余草稿;草稿不以该前缀开头(用户已改动)时返回 undefined。
 */
export function stripChipPrefix(prefix: string, draft: string): string | undefined {
  if (prefix === '') return draft
  if (!draft.startsWith(prefix)) return undefined
  const rest = draft.slice(prefix.length)
  return rest.startsWith('\n') ? rest.slice(1) : rest
}

/**
 * 组合新前缀与剩余草稿:草稿为空时前缀即全文,否则前缀后接换行再接剩余。
 *
 * @param prefix 新前缀全文。
 * @param rest 剥离旧前缀后的剩余草稿(可为空串)。
 * @returns 应写入输入框的新草稿。
 */
export function composeChipDraft(prefix: string, rest: string): string {
  return rest === '' ? prefix : `${prefix}\n${rest}`
}

/** 选中模板的草稿写入结果;applied=false 表示草稿未被改动。 */
export interface ChipDraftResult {
  draft: string
  applied: boolean
}

/**
 * 选中(或换选)模板时计算输入框新草稿。
 *
 * 先按上一次前缀剥离,再拼接新前缀;旧前缀已在草稿开头对不上(用户改动
 * 过)时不追加新前缀,只让调用方更新选中状态。
 *
 * @param draft 当前输入框草稿。
 * @param lastPrefix 上一次插入的前缀全文;从未插入过时传 null。
 * @param prefix 本次要插入的新前缀全文。
 * @returns 新草稿及是否发生了写入。
 */
export function applyChipPrefix(draft: string, lastPrefix: string | null, prefix: string): ChipDraftResult {
  if (lastPrefix !== null) {
    const stripped = stripChipPrefix(lastPrefix, draft)
    if (stripped === undefined) return { draft, applied: false }
    return { draft: composeChipDraft(prefix, stripped), applied: true }
  }
  return { draft: composeChipDraft(prefix, draft), applied: true }
}
