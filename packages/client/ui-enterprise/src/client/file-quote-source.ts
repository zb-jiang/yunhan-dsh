/**
 * 「引用到对话」chip 的 '@' 触发源(企业层扩展):右栏预览选区经
 * QuoteToConversationAction 插入内联 chip(文件图标 + 文件名:行号),本源
 * 承载 chip 的两处运行时出口——点击 chip 经 openReference 在右栏打开文件并
 * 定位到引用首行(TextPreview 的 navigation 效果负责翻页落位),发送时经
 * codec.serialize 产出「路径 + 行号署名 + 代码围栏片段」的模型文本(选区
 * 原文内嵌,与主流 agent 的选区引用一致;普通 @file 是给路径靠工具读的
 * agentic 风格,两者并存)。
 *
 * <p>本源不出菜单候选(candidates 恒空且 showGroupTitle 关闭,不渲染分组
 * 行),ref 是 JSON 载荷(路径/起止行/选区文本),随 DraftReference 落盘。
 * 已知降级:chip 只存在于编辑器文档,草稿持久化重载后还原为纯文本标记
 * `文件名:起-止`(与上游 @file 提及一致);clipboardText 刻意不带 '@'
 * 前缀,避免历史消息被官方 file 提及规则误渲染成指向 `名:行号` 路径的
 * 文件徽标。
 */
import type { ReferenceInsert } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'

/** '@' 菜单里本源的注册名(occurrence.source 的路由键)。 */
export const FILE_QUOTE_SOURCE_NAME = 'enterpriseFileQuote'

/** 一次选区引用的载荷:ref JSON 的结构。 */
export interface FileQuotePayload {
  /** 文件在执行环境中的绝对路径。 */
  readonly path: string
  /** 选区起始行(1 起,含);预览未暴露行信息时缺省。 */
  readonly start?: number
  /** 选区结束行(1 起,含),与 start 同现。 */
  readonly end?: number
  /** 选区文本(由调用方截断,截断标记已并入文本)。 */
  readonly text: string
}

/** ref JSON 的形状断言:仅接受本源写出的字段,拒收未知结构。 */
function isFileQuotePayload(value: unknown): value is FileQuotePayload {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.path !== 'string' || typeof candidate.text !== 'string') return false
  const { start, end } = candidate
  if (start === undefined && end === undefined) return true
  return typeof start === 'number' && typeof end === 'number' && Number.isInteger(start) && Number.isInteger(end)
    && start >= 1 && end >= start
}

/**
 * 把载荷编码为本源的 ref(JSON 字符串,DraftReference 落盘持久化)。
 * @param payload - 选区引用载荷。
 * @returns ref 字符串。
 */
export function fileQuoteRef(payload: FileQuotePayload): string {
  return JSON.stringify(payload)
}

/**
 * 解析本源 ref;形状不符返回 undefined(openReference 以此拒绝,交还原手势)。
 * @param ref - occurrence 上的 ref 字符串。
 * @returns 载荷;解析失败或形状不符为 undefined。
 */
export function parseFileQuoteRef(ref: string): FileQuotePayload | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(ref)
  } catch {
    return undefined
  }
  return isFileQuotePayload(parsed) ? parsed : undefined
}

/** 路径末段文件名(两种分隔符都认)。 */
function baseName(path: string): string {
  return path.replace(/^.*[\\/]/, '')
}

/** 行号后缀「:起-止」;无行信息为空串。 */
function lineSuffix(payload: FileQuotePayload): string {
  return payload.start === undefined ? '' : `:${payload.start}-${payload.end}`
}

/**
 * chip 的剪贴板/持久化投影。刻意不带 '@' 前缀,见模块注释。
 * @param payload - 选区引用载荷。
 * @returns `文件名:起-止`(无行信息时仅文件名)。
 */
export function fileQuoteClipboardText(payload: FileQuotePayload): string {
  return `${baseName(payload.path)}${lineSuffix(payload)}`
}

/** 围栏长度:大于正文里最长反引号串,至少 3。 */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * 模型序列化:路径 + 行号署名 + 代码围栏内嵌选区原文,与主流 agent 的
 * 选区引用产出同构(模型凭行号可展开上下文)。
 * @param payload - 选区引用载荷。
 * @returns 发送给模型的一个引用块(末尾换行)。
 */
export function fileQuoteModelText(payload: FileQuotePayload): string {
  const heading = payload.start === undefined
    ? `引用文件 ${payload.path}：`
    : `引用文件 ${payload.path} 第 ${payload.start}-${payload.end} 行：`
  return `${heading}\n${fenceFor(payload.text)}\n${payload.text}\n${fenceFor(payload.text)}\n`
}

/**
 * 组装插 chip 用的 ReferenceInsert(QuoteToConversationAction 经
 * inputActions.insertReference 传入草稿)。
 * @param payload - 选区引用载荷。
 * @returns chip 的插入描述:label 与剪贴板投影同为 `文件名:起-止`。
 */
export function buildFileQuoteInsert(payload: FileQuotePayload): ReferenceInsert {
  const clipboardText = fileQuoteClipboardText(payload)
  return {
    source: FILE_QUOTE_SOURCE_NAME,
    ref: fileQuoteRef(payload),
    label: clipboardText,
    appearance: 'file',
    clipboardText,
  }
}

/**
 * 构造「引用到对话」chip 的触发源(apply 时注册一次,退订器由 ctx.effect 持有)。
 * @param deps - 右栏导航面与会话列表(点击 chip 打开文件并定位用)。
 * @returns 触发源。
 */
export function buildFileQuoteSource(deps: {
  readonly sidebarRight: ISidebarRight
  readonly sessions: ISessions
}): InputTriggerSource {
  return {
    trigger: '@',
    name: FILE_QUOTE_SOURCE_NAME,
    order: 30,
    showGroupTitle: false,
    candidates: () => Promise.resolve([]),
    onPick() {
      return undefined
    },
    openReference(session: ClientSessionContext, { ref, appearance }) {
      if (appearance !== 'file') return false
      const payload = parseFileQuoteRef(ref)
      if (payload === undefined) return false
      const cwd = deps.sessions.list.getSnapshot().byId[session.sessionId]?.cwd
      const url = fileAddressFor(session.sessionId, cwd, payload.path)
      if (payload.start === undefined) deps.sidebarRight.openResource(url)
      else deps.sidebarRight.openResource(url, { params: { line: payload.start } })
      return true
    },
    codec: {
      clipboardText(ref) {
        const payload = parseFileQuoteRef(ref)
        return payload === undefined ? ref : fileQuoteClipboardText(payload)
      },
      serialize(ref) {
        const payload = parseFileQuoteRef(ref)
        if (payload === undefined) return Promise.reject(new Error(`${FILE_QUOTE_SOURCE_NAME}: corrupt reference payload`))
        return Promise.resolve(fileQuoteModelText(payload))
      },
    },
  }
}
