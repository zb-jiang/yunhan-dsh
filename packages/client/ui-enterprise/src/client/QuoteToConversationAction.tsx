/**
 * 右栏文件预览的「引用到对话」:sidebar.right.tab.document.actions 座位
 * 占据者(企业层扩展,官方预览包零改动)。
 *
 * <p>TextPreview 是全部渲染器(text/markdown/html/image/media/pdf/code/
 * office/excel)的公共宿主,根元素带 data-textpreview-url;本条目渲染进
 * 预览工具栏,在该根上挂 contextmenu 监听——正文内有非空选区时在光标处
 * 弹「引用到对话」菜单,点击后经 session 标准件 inputActions 的
 * insertReference 在当前会话输入草稿插入引用 chip(文件图标 +
 * `文件名:起-止`;captureInsertion + insertReference 的修订守卫组合;
 * 插入被拒只记 console.warn,不打断用户)。chip 的运行时出口
 * (点击定位/模型序列化)由 file-quote-source.ts 的同名触发源承载。
 *
 * <p>仅纯文本渲染器支持引用:其逐行元素盖 data-textpreview-line 标记,
 * 选区两端都落在标记内才弹出菜单并得到行号范围;其余渲染器(Markdown、
 * 代码块、编辑器等)的 DOM 无行标记,右键不弹本菜单(走浏览器默认行为)。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { buildFileQuoteInsert } from './file-quote-source.ts'
import type { FileQuotePayload } from './file-quote-source.ts'

/** 单次引用的最大字符数(按 Unicode code point 计,超出截断并追加省略行)。 */
const MAX_QUOTE_CHARS = 3000

/** 座位组件 props:owner(absolutePath)+ session 标准件中实际使用的部分。 */
export type QuoteToConversationActionProps = {
  /** 文件在执行环境中的绝对路径(chip 载荷署名与点击定位都用它)。 */
  readonly absolutePath: string
  /** 当前会话的输入动作(捕获插入点 + 插入引用 chip)。 */
  readonly inputActions: InputActions
}

/**
 * 从 DOM 选区提取 1 起的行号范围:锚点/焦点各取所在纯文本行
 * (data-textpreview-line),行号取 min/max(反向选区归一)。
 * @param root - 预览根(行标记必须落在其中)。
 * @param selection - 浏览器选区(非折叠)。
 * @returns 行号范围;任一端不在行标记内为 undefined(渲染器无行信息)。
 */
export function selectionLines(
  root: HTMLElement,
  selection: Selection,
): { start: number; end: number } | undefined {
  const lineOf = (node: Node): number | undefined => {
    const element = node instanceof Element ? node : node.parentElement
    if (element === null) return undefined
    const marked = element.closest<HTMLElement>('[data-textpreview-line]')
    if (marked === null || !root.contains(marked)) return undefined
    const line = Number(marked.dataset.textpreviewLine)
    return Number.isInteger(line) && line >= 1 ? line : undefined
  }
  if (selection.anchorNode === null || selection.focusNode === null) return undefined
  const start = lineOf(selection.anchorNode)
  const end = lineOf(selection.focusNode)
  if (start === undefined || end === undefined) return undefined
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/**
 * 把选中文本组装为 chip 载荷:按 code point 截断(超上限追加省略行)。
 * @param absolutePath - 文件在执行环境中的绝对路径。
 * @param selected - 用户选中的文本。
 * @param lines - 选区行号范围;渲染器无行信息时缺省。
 * @returns chip 载荷(text 已并入截断标记)。
 */
export function buildFileQuotePayload(
  absolutePath: string,
  selected: string,
  lines?: { readonly start: number; readonly end: number },
): FileQuotePayload {
  const chars = Array.from(selected)
  const truncated = chars.length > MAX_QUOTE_CHARS
  const text = (truncated ? `${chars.slice(0, MAX_QUOTE_CHARS).join('')}\n……(引用截断)` : selected.replace(/\s+$/, ''))
  return {
    path: absolutePath,
    ...(lines === undefined ? {} : { start: lines.start, end: lines.end }),
    text,
  }
}

/** 光标处弹出的引用菜单状态(null = 关闭);菜单仅在选区带行号范围时弹出。 */
type QuoteMenu = { readonly rect: DOMRect; readonly text: string; readonly lines: { readonly start: number; readonly end: number } }

/** 预览工具栏条目:隐藏挂载点 + contextmenu 监听 + 光标处引用菜单。 */
export function QuoteToConversationAction({ absolutePath, inputActions }: QuoteToConversationActionProps): ReactNode {
  const mountRef = useRef<HTMLSpanElement>(null)
  const [menu, setMenu] = useState<QuoteMenu | null>(null)

  useEffect(() => {
    const root = mountRef.current?.closest<HTMLElement>('[data-textpreview-url]') ?? null
    if (root === null) return
    const onContextMenu = (event: MouseEvent): void => {
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) return
      const text = selection.toString()
      if (text.trim() === '') return
      // 仅纯文本渲染器支持:选区两端不在行标记内(其他渲染器)不弹菜单,
      // 也不 preventDefault,右键走浏览器默认行为。
      const lines = selectionLines(root, selection)
      if (lines === undefined) return
      event.preventDefault()
      setMenu({ rect: new DOMRect(event.clientX, event.clientY, 0, 0), text, lines })
    }
    root.addEventListener('contextmenu', onContextMenu)
    return () => { root.removeEventListener('contextmenu', onContextMenu) }
  }, [])

  const quote = (state: QuoteMenu): void => {
    setMenu(null)
    const span = inputActions.captureInsertion()
    const payload = buildFileQuotePayload(absolutePath, state.text, state.lines)
    if (!inputActions.insertReference(buildFileQuoteInsert(payload), span)) {
      console.warn('[ui-enterprise] 引用到对话:插入被拒(草稿已变更或正在提交)')
    }
  }

  return (
    <>
      <span ref={mountRef} hidden />
      {menu !== null && (
        <Menu
          open
          portal
          autoFocus
          dense
          anchor={<span hidden aria-hidden="true" />}
          getAnchorRect={() => menu.rect}
          items={[{ id: 'quote-to-conversation', label: '引用到对话' }]}
          onSelect={() => { quote(menu) }}
          onClose={() => { setMenu(null) }}
        />
      )}
    </>
  )
}
