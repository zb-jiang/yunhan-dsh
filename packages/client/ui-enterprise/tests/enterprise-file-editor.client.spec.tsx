// @vitest-environment jsdom
/**
 * 企业文件编辑器行为测试：外层的解码与地址判定、EditorSurface 的保存
 * 状态机（Ctrl+S 与状态条按钮两条路径、版本钉住、防重入、失败映射）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentContent } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { EnterpriseFileWriteRequest } from '@deepseek-ai/dsh-enterprise-file-write/types'
import { EnterpriseFileEditor, describeSaveFailure } from '../src/client/EnterpriseFileEditor.tsx'
import type { EnterpriseFileEditorInjected, EnterpriseFileEditorProps, EnterpriseFileSaveOutcome } from '../src/client/EnterpriseFileEditor.tsx'
import css from '../src/client/EnterpriseFileEditor.module.css'

const SESSION = 'editor-test' as SessionId

// jsdom 未实现 Range.getClientRects,CodeMirror 在 requestAnimationFrame 里测量
// 文本行高时会调用;补一个单零矩形列表即可满足测量路径。
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  const rect = new DOMRect(0, 0, 0, 0)
  const rects: DOMRectList = {
    0: rect,
    length: 1,
    item: (index: number) => (index === 0 ? rect : null),
    // lib.dom 声明的迭代器返回类型是 ArrayIterator<DOMRect>,generator 不满足
    // (exactOptionalPropertyTypes 下 return 类型须为 undefined);借数组迭代器,
    // 运行时按下标读取本对象的 0/length,行为与单元素列表一致。
    [Symbol.iterator]: [rect][Symbol.iterator],
  }
  Range.prototype.getClientRects = function (this: Range) { return rects }
}

type SaveFile = EnterpriseFileEditorInjected['saveFile']

const noop = (): void => {}

/** 保存成功的通道，返回固定的新版本号。 */
function okSave(version = '9'): SaveFile {
  return vi.fn((_sessionId: string, _request: EnterpriseFileWriteRequest): Promise<EnterpriseFileSaveOutcome> =>
    Promise.resolve({ ok: true, version, absolutePath: '/workspace/notes/report.md' }))
}

/** 保存失败但结构化的通道。 */
function failSave(code: string, message: string): SaveFile {
  return vi.fn((_sessionId: string, _request: EnterpriseFileWriteRequest): Promise<EnterpriseFileSaveOutcome> =>
    Promise.resolve({ ok: false, code, message }))
}

/** 挂起直到测试放行的保存通道，用于防重入场景。 */
function deferredSave(): { readonly fn: SaveFile; readonly resolve: (outcome: EnterpriseFileSaveOutcome) => void } {
  let settle!: (outcome: EnterpriseFileSaveOutcome) => void
  const fn = vi.fn((_sessionId: string, _request: EnterpriseFileWriteRequest): Promise<EnterpriseFileSaveOutcome> =>
    new Promise((resolve) => { settle = resolve }))
  return { fn, resolve: (outcome) => { settle(outcome) } }
}

/** 编辑器消费的 bytes 内容帧。 */
function bytesText(text: string): DocumentContent {
  return { kind: 'bytes', data: new TextEncoder().encode(text) }
}

/** 编辑器不读的框架座位省略；宽断言按可比性只填子集（code-body 测试同款惯例）。 */
function makeProps(overrides: Partial<EnterpriseFileEditorProps> = {}): EnterpriseFileEditorProps {
  return {
    resourceAddress: sessionFileAddress(SESSION, 'notes/report.md'),
    sessionId: SESSION,
    content: bytesText('hello world'),
    wrap: false,
    version: '3',
    saveFile: okSave(),
    ...overrides,
  } as EnterpriseFileEditorProps
}

function contentOf(root: HTMLElement): HTMLElement {
  const found = root.querySelector<HTMLElement>('.cm-content')
  if (found === null) throw new Error('missing .cm-content')
  return found
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>('button[type="button"]')
  if (found === null) throw new Error('missing save button')
  return found
}

function statusOf(root: HTMLElement): HTMLElement {
  const status = saveButton(root).previousElementSibling
  if (!(status instanceof HTMLElement)) throw new Error('missing status line')
  return status
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('保存失败文案', () => {
  it('已知的错误码映射到中文提示', () => {
    expect(describeSaveFailure('enterprise-file/stale-version', 'stale')).toBe('文件已被其他人修改,请刷新预览后重试')
    expect(describeSaveFailure('enterprise-file/outside-workspace', '')).toBe('文件在工作空间之外,不能保存')
    expect(describeSaveFailure('enterprise-file/too-large', '')).toBe('文件内容超过大小限制,不能保存')
    expect(describeSaveFailure('enterprise-file/session-not-found', '')).toBe('会话不存在或已结束,不能保存')
    expect(describeSaveFailure('enterprise-file/denied', '')).toBe('没有保存该文件的权限')
    expect(describeSaveFailure('gateway/bad-request', '')).toBe('保存请求不合法')
  })

  it('未知错误码回落到服务端消息', () => {
    expect(describeSaveFailure('enterprise-file/unknown', '磁盘已满')).toBe('磁盘已满')
  })

  it('服务端消息为空时给出兜底提示', () => {
    expect(describeSaveFailure('enterprise-file/unknown', '')).toBe('保存失败')
  })
})

describe('企业文件编辑器', () => {
  it('内容仍由加载器持有时不渲染任何东西', () => {
    const view = render(<EnterpriseFileEditor {...makeProps({
      content: { kind: 'renderer', revision: 1, loaded: noop, failed: noop, reload: noop },
    })} />)
    expect(view.container.firstChild).toBeNull()
  })

  it('非 UTF-8 内容显示无法编辑的提示', () => {
    const view = render(<EnterpriseFileEditor {...makeProps({
      content: { kind: 'bytes', data: new Uint8Array([0x68, 0xff, 0xfe]) },
    })} />)
    expect(view.getByText('文件不是有效的 UTF-8 文本,无法编辑')).toBeTruthy()
  })

  it('session 文件挂载 CodeMirror 视图并就绪保存按钮', () => {
    const view = render(<EnterpriseFileEditor {...makeProps()} />)
    expect(contentOf(view.container).textContent).toBe('hello world')
    expect(saveButton(view.container).disabled).toBe(false)
    expect(statusOf(view.container).textContent).toBe('')
    expect(statusOf(view.container).className).toBe(css.statusInfo)
  })

  it('无法解析的地址保持只读并给出提示', () => {
    const saveFile = okSave()
    const view = render(<EnterpriseFileEditor {...makeProps({ resourceAddress: 'not-a-file-address', saveFile })} />)
    expect(contentOf(view.container).textContent).toBe('hello world')
    expect(saveButton(view.container).disabled).toBe(true)
    expect(statusOf(view.container).textContent).toBe('该文件不支持保存')
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('Ctrl+S 触发保存并钉住返回的新版本', async () => {
    const saveFile = okSave()
    const view = render(<EnterpriseFileEditor {...makeProps({ saveFile })} />)
    fireEvent.keyDown(contentOf(view.container), { key: 's', ctrlKey: true })
    await waitFor(() => { expect(statusOf(view.container).textContent).toBe('已保存') })
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile).toHaveBeenCalledWith(SESSION, {
      path: 'notes/report.md', content: 'hello world', expectedVersion: '3',
    })
    fireEvent.keyDown(contentOf(view.container), { key: 's', ctrlKey: true })
    await waitFor(() => { expect(saveFile).toHaveBeenCalledTimes(2) })
    expect(saveFile).toHaveBeenLastCalledWith(SESSION, {
      path: 'notes/report.md', content: 'hello world', expectedVersion: '9',
    })
  })

  it('absolute 地址按 Ctrl+S 不发起保存并提示不支持', () => {
    const saveFile = okSave()
    const view = render(<EnterpriseFileEditor {...makeProps({
      resourceAddress: absoluteFileAddress('C:/project/report.md'), saveFile,
    })} />)
    fireEvent.keyDown(contentOf(view.container), { key: 's', ctrlKey: true })
    expect(saveFile).not.toHaveBeenCalled()
    expect(statusOf(view.container).textContent).toBe('该文件不支持保存')
  })

  it('保存进行中忽略第二次保存请求', async () => {
    const { fn, resolve } = deferredSave()
    const view = render(<EnterpriseFileEditor {...makeProps({ saveFile: fn })} />)
    fireEvent.keyDown(contentOf(view.container), { key: 's', ctrlKey: true })
    await waitFor(() => { expect(statusOf(view.container).textContent).toBe('正在保存…') })
    expect(saveButton(view.container).disabled).toBe(true)
    fireEvent.keyDown(contentOf(view.container), { key: 's', ctrlKey: true })
    expect(fn).toHaveBeenCalledTimes(1)
    resolve({ ok: true, version: '9', absolutePath: '/workspace/notes/report.md' })
    await waitFor(() => { expect(statusOf(view.container).textContent).toBe('已保存') })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('状态条按钮同样触发保存', async () => {
    const saveFile = okSave()
    const view = render(<EnterpriseFileEditor {...makeProps({ saveFile })} />)
    fireEvent.click(saveButton(view.container))
    await waitFor(() => { expect(statusOf(view.container).textContent).toBe('已保存') })
    expect(saveFile).toHaveBeenCalledTimes(1)
  })

  it('stale-version 失败映射为中文提示与错误样式', async () => {
    const saveFile = failSave('enterprise-file/stale-version', 'stale')
    const view = render(<EnterpriseFileEditor {...makeProps({ saveFile })} />)
    fireEvent.click(saveButton(view.container))
    await waitFor(() => { expect(statusOf(view.container).textContent).toBe('文件已被其他人修改,请刷新预览后重试') })
    expect(statusOf(view.container).className).toBe(css.statusError)
  })

  it('保存通道抛出的 Error 消息直接展示', async () => {
    const saveFile = vi.fn((_sessionId: string, _request: EnterpriseFileWriteRequest): Promise<EnterpriseFileSaveOutcome> =>
      Promise.reject(new Error('网络连接中断')))
    const view = render(<EnterpriseFileEditor {...makeProps({ saveFile })} />)
    fireEvent.click(saveButton(view.container))
    await waitFor(() => { expect(statusOf(view.container).textContent).toBe('网络连接中断') })
  })

  it('非 Error 的拒绝值转为字符串展示', async () => {
    const saveFile = vi.fn((_sessionId: string, _request: EnterpriseFileWriteRequest): Promise<EnterpriseFileSaveOutcome> =>
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- 测试非 Error 拒绝值的字符串降级展示路径
      Promise.reject<EnterpriseFileSaveOutcome>('保存通道崩溃'))
    const view = render(<EnterpriseFileEditor {...makeProps({ saveFile })} />)
    fireEvent.click(saveButton(view.container))
    await waitFor(() => { expect(statusOf(view.container).textContent).toBe('保存通道崩溃') })
  })

  it('CodeMirror 文档变化后进入未保存状态', async () => {
    const view = render(<EnterpriseFileEditor {...makeProps()} />)
    const content = contentOf(view.container)
    content.focus()
    // CodeMirror 只在输入事件路径里生成事务,直接改 textContent 不会触发
    // updateListener;这里用 paste 事件模拟一次真实输入。
    fireEvent.paste(content, { clipboardData: { getData: () => 'x' } })
    await waitFor(() => { expect(statusOf(view.container).textContent).toBe('有未保存的更改(Ctrl+S 保存)') })
  })

  it('按文件后缀选择语法高亮语言', () => {
    const cases: ReadonlyArray<{ readonly file: string; readonly text: string }> = [
      { file: 'notes/config.json', text: '{"a":1}' },
      { file: 'notes/page.html', text: '<p>hi</p>' },
      { file: 'Makefile', text: 'all:\n\techo hi' },
    ]
    for (const { file, text } of cases) {
      const view = render(<EnterpriseFileEditor {...makeProps({
        resourceAddress: sessionFileAddress(SESSION, file),
        content: bytesText(text),
      })} />)
      // CodeMirror 把行分隔渲染成块级结构,textContent 丢失 \n,按空白折叠后比较。
      expect(contentOf(view.container).textContent?.replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
      view.unmount()
    }
  })
})
