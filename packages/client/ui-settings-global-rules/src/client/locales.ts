/** Copy dictionaries for the Global-rules settings section. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Global rules',
  title: 'Global rules',
  intro: 'These instructions are injected near the top of every session on this machine. Record environment facts and standing rules here — installed tool paths, coding conventions, reply-language preferences — so you do not repeat them in every conversation.',
  pathLabel: 'File',
  notCreated: 'Not created yet; saving creates it.',
  editorLabel: 'Global rules content',
  editorPlaceholder: 'Write the standing rules for your agent…',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved.',
  reload: 'Reload',
  loadFailed: 'Loading the global rules failed.',
  saveFailed: 'Saving the global rules failed.',
  saveTooLarge: 'The file exceeds the write ceiling; trim it before saving.',
  overBudget: 'Over the injection budget: {bytes} of {maxBytes} bytes. Saving is allowed, but the harness may drop part of the file when injecting.',
  usage: '{bytes} of {maxBytes} bytes',
  bytesUnit: 'bytes',
}

/** The settings.globalRules namespace key union. */
export type GlobalRulesKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '全局规则',
  title: '全局规则',
  intro: '这段指令会注入到本机每个会话的顶层。请在这里记录环境事实与固定规则——已安装的工具路径、编码规范、回复语言偏好等——避免每次对话重复说明。',
  pathLabel: '文件',
  notCreated: '文件尚不存在，保存后创建。',
  editorLabel: '全局规则内容',
  editorPlaceholder: '写下给 Agent 的固定规则…',
  save: '保存',
  saving: '保存中…',
  saved: '已保存。',
  reload: '重新加载',
  loadFailed: '加载全局规则失败。',
  saveFailed: '保存全局规则失败。',
  saveTooLarge: '文件超过写入上限，请精简后再保存。',
  overBudget: '超出注入预算：{bytes} / {maxBytes} 字节。仍可保存，但注入时部分内容可能被忽略。',
  usage: '{bytes} / {maxBytes} 字节',
  bytesUnit: '字节',
}
