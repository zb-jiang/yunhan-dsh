// @vitest-environment jsdom
/** 「引用到对话」:预览正文右键选区 → 光标菜单 → 引用 chip 经 inputActions 插入草稿。 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputActions, ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  QuoteToConversationAction, buildFileQuotePayload, selectionLines,
} from '../src/client/QuoteToConversationAction.tsx'
import {
  FILE_QUOTE_SOURCE_NAME, buildFileQuoteInsert, buildFileQuoteSource, fileQuoteModelText,
  fileQuoteRef, parseFileQuoteRef,
} from '../src/client/file-quote-source.ts'
import type { FileQuotePayload } from '../src/client/file-quote-source.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const unused = (): never => { throw new Error('This isolated component does not consume framework hooks') }

const CAPTURED_SPAN = { start: 0, end: 0, draftRev: 1 }

function createInputActions(overrides: Partial<InputActions> = {}): InputActions {
  return {
    captureInsertion: vi.fn(() => CAPTURED_SPAN),
    insertText: unused,
    insertReference: vi.fn(() => true),
    setDraft: unused, persistDraft: unused, addAttachments: unused,
    removeAttachment: unused, pruneAttachments: unused, submit: unused,
    ...overrides,
  }
}

/** 渲染进一个 data-textpreview-url 预览根(模拟纯文本渲染的宿主结构,body 带行标记)。 */
function mountAction(actions: InputActions, absolutePath = 'D:\\资料\\报告.md') {
  return render(
    <div data-textpreview-url="file:///D:/资料/报告.md">
      <span data-textpreview-line="1" data-testid="body">正文内容</span>
      <QuoteToConversationAction absolutePath={absolutePath} inputActions={actions} />
    </div>,
  )
}

/** 把 window 选区设为 node 上 [from, to) 的真实 Range。 */
function selectText(node: Node, from = 0, to?: number): void {
  const selection = window.getSelection()
  selection?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, to ?? (node instanceof Text ? node.length : node.childNodes.length))
  selection?.addRange(range)
}

describe('buildFileQuotePayload', () => {
  it('无行信息时不带 start/end', () => {
    expect(buildFileQuotePayload('a.md', '正文')).toEqual({ path: 'a.md', text: '正文' })
  })

  it('带行号范围', () => {
    expect(buildFileQuotePayload('a.md', '正文', { start: 3, end: 7 }))
      .toEqual({ path: 'a.md', start: 3, end: 7, text: '正文' })
  })

  it('超出上限按 code point 截断并追加省略行', () => {
    expect(buildFileQuotePayload('f.md', '字'.repeat(3001)).text)
      .toBe(`${'字'.repeat(3000)}\n……(引用截断)`)
  })
})

describe('selectionLines', () => {
  it('锚点与焦点所在行取 min/max(反向选区归一)', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div data-textpreview-line="4">甲</div><div data-textpreview-line="2">乙</div>'
    document.body.append(root)
    const [first, second] = root.querySelectorAll<HTMLElement>('[data-textpreview-line]')
    const selection = window.getSelection()!
    selection.removeAllRanges()
    const range = document.createRange()
    range.setStart(first!.firstChild!, 0)
    range.setEnd(second!.firstChild!, 0)
    selection.addRange(range)
    expect(selectionLines(root, selection)).toEqual({ start: 2, end: 4 })
  })

  it('任一端不在行元素内为 undefined', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div data-textpreview-line="1">甲</div><div>乙</div>'
    document.body.append(root)
    const [marked, plain] = root.querySelectorAll<HTMLElement>('div')
    const selection = window.getSelection()!
    selection.removeAllRanges()
    const range = document.createRange()
    range.setStart(marked!.firstChild!, 0)
    range.setEnd(plain!.firstChild!, 1)
    selection.addRange(range)
    expect(selectionLines(root, selection)).toBeUndefined()
  })
})

describe('file-quote-source', () => {
  const payload: FileQuotePayload = { path: 'D:\\资料\\报告.md', start: 12, end: 14, text: '第一行\n第二行\n第三行' }

  it('ref 载荷 round-trip,形状不符拒收', () => {
    expect(parseFileQuoteRef(fileQuoteRef(payload))).toEqual(payload)
    expect(parseFileQuoteRef('不是 JSON')).toBeUndefined()
    expect(parseFileQuoteRef(JSON.stringify({ path: 1, text: '' }))).toBeUndefined()
    expect(parseFileQuoteRef(fileQuoteRef({ path: 'a', text: 'x', start: 2, end: 1 }))).toBeUndefined()
  })

  it('剪贴板投影为 文件名:起-止,不带 @ 前缀', () => {
    expect(buildFileQuoteInsert(payload).clipboardText).toBe('报告.md:12-14')
    expect(buildFileQuoteInsert({ path: payload.path, text: payload.text }).clipboardText).toBe('报告.md')
  })

  it('模型文本为路径行号署名 + 代码围栏片段', () => {
    expect(fileQuoteModelText(payload)).toBe(
      '引用文件 D:\\资料\\报告.md 第 12-14 行：\n```\n第一行\n第二行\n第三行\n```\n',
    )
  })

  it('正文含反引号串时围栏加长', () => {
    expect(fileQuoteModelText({ path: 'a.md', text: '```\nx\n```' })).toContain('````\n```\nx\n```\n````')
  })

  it('insertReference 收到 chip 描述与捕获 span', () => {
    const insertReference = vi.fn((_ref: ReferenceInsert, _span: TokenSpan) => true)
    const actions = createInputActions({ insertReference })
    const { container } = mountAction(actions)
    const body = container.querySelector('[data-testid="body"]')!
    selectText(body.firstChild!)
    fireEvent.contextMenu(body)
    fireEvent.click(screen.getByRole('menuitem', { name: '引用到对话' }))
    expect(insertReference).toHaveBeenCalledTimes(1)
    const [ref, span] = insertReference.mock.calls[0]!
    expect(ref.source).toBe(FILE_QUOTE_SOURCE_NAME)
    expect(ref.appearance).toBe('file')
    expect(ref.label).toBe('报告.md:1-1')
    expect(parseFileQuoteRef(ref.ref)).toEqual({ path: 'D:\\资料\\报告.md', start: 1, end: 1, text: '正文内容' })
    expect(span).toBe(CAPTURED_SPAN)
  })

  it('选区不在行标记内(非纯文本渲染器)不弹菜单', () => {
    const captureInsertion = vi.fn(() => CAPTURED_SPAN)
    const actions = createInputActions({ captureInsertion })
    const { container } = render(
      <div data-textpreview-url="file:///D:/资料/报告.md">
        <span data-testid="plain">无行标记正文</span>
        <QuoteToConversationAction absolutePath="D:\\资料\\报告.md" inputActions={actions} />
      </div>,
    )
    const body = container.querySelector('[data-testid="plain"]')!
    selectText(body.firstChild!)
    fireEvent.contextMenu(body)
    expect(screen.queryByRole('menuitem', { name: '引用到对话' })).toBeNull()
    expect(captureInsertion).not.toHaveBeenCalled()
  })

  it('openReference 携行号时打开文件并传 line 定位参数', () => {
    const openResource = vi.fn()
    const source = buildFileQuoteSource({
      sidebarRight: { openResource } as never,
      sessions: { list: { getSnapshot: () => ({ byId: { 's1': { cwd: 'D:\\ws' } } }) } } as never,
    })
    expect(source.openReference?.({ sessionId: 's1' as never }, { ref: fileQuoteRef(payload), appearance: 'file' })).toBe(true)
    expect(openResource).toHaveBeenCalledTimes(1)
    const [url, options] = openResource.mock.calls[0] as [string, { params: { line: number } } | undefined]
    expect(url).toMatch(/^dsh-resource:\/\/file\//u)
    expect(options?.params).toEqual({ line: 12 })
  })

  it('openReference 无行号时只打开文件,形状不符拒收', () => {
    const openResource = vi.fn()
    const source = buildFileQuoteSource({
      sidebarRight: { openResource } as never,
      sessions: { list: { getSnapshot: () => ({ byId: {} }) } } as never,
    })
    const bare = buildFileQuoteInsert({ path: 'D:\\ws\\a.md', text: 'x' })
    expect(source.openReference?.({ sessionId: 's2' as never }, { ref: bare.ref, appearance: 'file' })).toBe(true)
    expect(openResource).toHaveBeenCalledWith(expect.stringMatching(/^dsh-resource:\/\/file\//u))
    expect(source.openReference?.({ sessionId: 's2' as never }, { ref: '坏载荷', appearance: 'file' })).toBe(false)
    expect(source.openReference?.({ sessionId: 's2' as never }, { ref: '{}', appearance: 'session' })).toBe(false)
  })

  it('serialize 对坏载荷抛错(阻塞发送,不静默降级)', async () => {
    const source = buildFileQuoteSource({ sidebarRight: {} as never, sessions: {} as never })
    await expect(source.codec!.serialize('坏载荷', new AbortController().signal)).rejects.toThrow()
  })
})
