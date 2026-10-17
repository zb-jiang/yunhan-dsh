/**
 * 实例空间客户端面的单元测试:API 封装(信封解包/JWT/401/409/multipart/
 * session-context 上报体)、文件清单组树、云路径默认计算与 '@' 实例空间源
 * (候选过滤/≤20 截取/onPick 纯文本)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CandidateRequest, ClientSessionContext, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  deleteInstanceFile, encodeRelPath, listInstanceFiles, pullInstanceFile,
  reportSessionWorkspaceContext, uploadToInstanceWorkspace,
} from '../src/client/instance-workspace-api.ts'
import type { InstanceWorkspaceFile } from '../src/client/instance-workspace-api.ts'
import { buildFileTree, relativePathUnder } from '../src/client/instance-files-tab.ts'
import { buildInstanceWorkspaceSource } from '../src/client/instance-trigger-source.ts'
import type { EnterpriseWorkbench } from '../src/client/enterprise-workbench.ts'
import { readToken } from '../src/client/task-api.ts'

vi.mock('../src/client/task-api.ts', () => ({
  readToken: vi.fn((): string | null => null),
}))

const mockedReadToken = vi.mocked(readToken)

beforeEach(() => {
  mockedReadToken.mockReturnValue('jwt-a')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** 清单项构造:默认全部字段,覆写关注面。 */
function wsFile(overrides: Partial<InstanceWorkspaceFile> & { relPath: string }): InstanceWorkspaceFile {
  return {
    sizeBytes: 10,
    contentType: 'text/plain',
    uploadedByLabel: null,
    sourceTaskId: null,
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
    diskMissing: false,
    ...overrides,
  }
}

/** JSON 响应构造(信封形态由调用方给)。 */
function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

/** 触发源 workbench 桩:仅实现实例归属判定所需的面。 */
function stubWorkbench(processInstanceIdOf: Readonly<Record<string, string | undefined>>): EnterpriseWorkbench {
  return {
    taskOfSession(sessionId: string) {
      const processInstanceId = processInstanceIdOf[sessionId]
      return processInstanceId === undefined ? undefined : { processInstanceId }
    },
  } as never
}

describe('instance workspace api', () => {
  it('listInstanceFiles unwraps the envelope and carries the employee JWT', async () => {
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(
      jsonRes({ success: true, data: [wsFile({ relPath: 'reports/周报.md' })] }),
    ))
    vi.stubGlobal('fetch', fetcher)

    const files = await listInstanceFiles('inst 1')

    expect(files).toHaveLength(1)
    expect(files[0]?.relPath).toBe('reports/周报.md')
    const call = fetcher.mock.calls.at(0)
    if (call === undefined) throw new Error('fetch not called')
    const [url, init] = call
    expect(url).toBe('/api/enterprise/workspace/instances/inst%201/files')
    expect(init?.method).toBeUndefined()
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer jwt-a')
  })

  it('listInstanceFiles throws with the HTTP status on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes({ error: 'unauthorized' }, 401))))

    await expect(listInstanceFiles('inst-1')).rejects.toMatchObject({ status: 401 })
  })

  it('listInstanceFiles surfaces the envelope error message on success=false', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      jsonRes({ success: false, data: null, error: { code: 'FORBIDDEN', message: '无权访问该实例' } }),
    )))

    await expect(listInstanceFiles('inst-1')).rejects.toThrow('无权访问该实例')
  })

  it('pullInstanceFile posts the pull body and returns the saved local path', async () => {
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(
      jsonRes({ localPath: 'D:/ws/s1/reports/a.txt' }),
    ))
    vi.stubGlobal('fetch', fetcher)

    const outcome = await pullInstanceFile('s-1', 'inst-1', 'reports/a.txt', 'cwd')

    expect(outcome).toEqual({ kind: 'saved', localPath: 'D:/ws/s1/reports/a.txt' })
    const call = fetcher.mock.calls.at(0)
    if (call === undefined) throw new Error('fetch not called')
    const [url, init] = call
    expect(url).toBe('api/enterprise/workspace/pull')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer jwt-a')
    expect(init?.body).toBe(JSON.stringify({
      sessionId: 's-1', instanceId: 'inst-1', relPath: 'reports/a.txt', target: 'cwd', overwrite: false,
    }))
  })

  it('pullInstanceFile maps 409 to the existed outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes({ existed: true }, 409))))

    const outcome = await pullInstanceFile('s-1', 'inst-1', 'reports/a.txt', 'cwd')

    expect(outcome).toEqual({ kind: 'existed' })
  })

  it('pullInstanceFile throws with the endpoint error message on 400', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      jsonRes({ error: 'relPath 必须是安全的相对路径(不得含 ..、绝对路径或反斜杠)' }, 400),
    )))

    await expect(pullInstanceFile('s-1', 'inst-1', '../escape.txt', 'cwd'))
      .rejects.toMatchObject({
        status: 400,
        message: 'relPath 必须是安全的相对路径(不得含 ..、绝对路径或反斜杠)',
      })
  })

  it('deleteInstanceFile issues DELETE against the encoded content path', async () => {
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(
      jsonRes({ success: true, data: null }),
    ))
    vi.stubGlobal('fetch', fetcher)

    await deleteInstanceFile('inst-1', 'reports/a b.txt')

    const call = fetcher.mock.calls.at(0)
    if (call === undefined) throw new Error('fetch not called')
    const [url, init] = call
    expect(url).toBe(`/api/enterprise/workspace/instances/inst-1/files/content/${encodeRelPath('reports/a b.txt')}`)
    expect(init?.method).toBe('DELETE')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer jwt-a')
  })

  it('uploadToInstanceWorkspace posts multipart with path and file fields', async () => {
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(
      jsonRes({ success: true, data: wsFile({ relPath: 'docs/a.txt' }) }),
    ))
    vi.stubGlobal('fetch', fetcher)
    const file = new File([new Uint8Array([1, 2, 3])], 'a.txt')

    const uploaded = await uploadToInstanceWorkspace('inst-1', 'docs/a.txt', file)

    expect(uploaded.relPath).toBe('docs/a.txt')
    const call = fetcher.mock.calls.at(0)
    if (call === undefined) throw new Error('fetch not called')
    const [url, init] = call
    expect(url).toBe('/api/enterprise/workspace/instances/inst-1/files')
    expect(init?.method).toBe('POST')
    // multipart 的 content-type 由浏览器带 boundary 自动设置,不能手工指定。
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer jwt-a')
    expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined()
    const form = init?.body
    if (!(form instanceof FormData)) throw new Error('body is not FormData')
    expect(form.get('path')).toBe('docs/a.txt')
    expect(form.get('file')).toBe(file)
  })

  it('reportSessionWorkspaceContext posts the binding with the employee JWT', () => {
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(jsonRes({ success: true, data: null })))
    vi.stubGlobal('fetch', fetcher)

    reportSessionWorkspaceContext('s-1', 'inst-1')

    expect(fetcher).toHaveBeenCalledTimes(1)
    const call = fetcher.mock.calls.at(0)
    if (call === undefined) throw new Error('fetch not called')
    const [url, init] = call
    expect(url).toBe('api/enterprise/workspace/session-context')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer jwt-a')
    expect(init?.body).toBe(JSON.stringify({ sessionId: 's-1', processInstanceId: 'inst-1' }))
  })

  it('reportSessionWorkspaceContext skips the post without a login', () => {
    const fetcher = vi.fn(() => Promise.resolve(jsonRes({ success: true, data: null })))
    vi.stubGlobal('fetch', fetcher)
    mockedReadToken.mockReturnValue(null)

    reportSessionWorkspaceContext('s-1', 'inst-1')

    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('buildFileTree', () => {
  it('groups segments into nested directories', () => {
    const root = buildFileTree([
      wsFile({ relPath: 'a/b.txt' }),
      wsFile({ relPath: 'a/c/d.txt' }),
      wsFile({ relPath: 'top.txt' }),
    ])
    expect(root.children.map(node => node.name)).toEqual(['a', 'top.txt'])
    const dirA = root.children[0]
    if (dirA === undefined || dirA.file !== undefined) throw new Error('expected a directory node')
    // 目录 'c' 排在文件 'b.txt' 前。
    expect(dirA.children.map(node => node.name)).toEqual(['c', 'b.txt'])
    const dirC = dirA.children[0]
    if (dirC === undefined || dirC.file !== undefined) throw new Error('expected a directory node')
    expect(dirC.children.map(node => node.name)).toEqual(['d.txt'])
  })

  it('sorts directories before files within the same parent', () => {
    const root = buildFileTree([
      wsFile({ relPath: 'z-dir/x.txt' }),
      wsFile({ relPath: 'a-file.txt' }),
    ])
    expect(root.children.map(node => node.name)).toEqual(['z-dir', 'a-file.txt'])
  })

  it('sorts files by zh collation (pinyin order)', () => {
    const root = buildFileTree([
      wsFile({ relPath: '乙.txt' }),
      wsFile({ relPath: '丙.txt' }),
    ])
    // zh-Hans-CN 拼音序:bing < yi。
    expect(root.children.map(node => node.name)).toEqual(['丙.txt', '乙.txt'])
  })

  it('keeps a same-named file and directory distinct', () => {
    const root = buildFileTree([
      wsFile({ relPath: 'a' }),
      wsFile({ relPath: 'a/b.txt' }),
    ])
    expect(root.children).toHaveLength(2)
    expect(root.children[0]?.file).toBeUndefined()
    expect(root.children[1]?.file?.relPath).toBe('a')
  })

  it('returns an empty root for an empty list', () => {
    expect(buildFileTree([]).children).toEqual([])
  })
})

describe('relativePathUnder', () => {
  it('returns the posix relative path for a path under cwd (windows separators)', () => {
    expect(relativePathUnder('D:\\ws\\s1', 'D:\\ws\\s1\\notes\\a.md')).toBe('notes/a.md')
  })

  it('tolerates a trailing separator on cwd', () => {
    expect(relativePathUnder('D:/ws/s1/', 'D:/ws/s1/a.md')).toBe('a.md')
  })

  it('rejects paths outside cwd and prefix collisions', () => {
    expect(relativePathUnder('D:/ws/s1', 'D:/ws/s10/x.md')).toBeNull()
    expect(relativePathUnder('D:/ws/s1', 'D:/other/a.md')).toBeNull()
  })
})

describe('@instanceWorkspace trigger source', () => {
  const baseSource = (): InputTriggerPick => ({
    candidate: { name: 'reports/a.txt', value: 'reports/a.txt' },
  } as InputTriggerPick)

  it('declares the @ trigger, name and order', () => {
    const source = buildInstanceWorkspaceSource(stubWorkbench({}))
    expect(source.trigger).toBe('@')
    expect(source.name).toBe('instanceWorkspace')
    expect(source.order).toBe(11)
  })

  it('lists no candidates and fetches nothing for a session without a pending task', async () => {
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(jsonRes({ success: true, data: [] })))
    vi.stubGlobal('fetch', fetcher)
    const source = buildInstanceWorkspaceSource(stubWorkbench({}))

    const items = await source.candidates({ sessionId: 's-1' } as ClientSessionContext, {
      query: '', signal: new AbortController().signal,
    } as CandidateRequest)

    expect(items).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('filters candidates by relPath case-insensitively and caps at 20', async () => {
    const all = Array.from({ length: 22 }, (_unused, index) => wsFile({ relPath: `f-${String(index).padStart(2, '0')}.txt` }))
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(jsonRes({ success: true, data: all })))
    vi.stubGlobal('fetch', fetcher)
    const source = buildInstanceWorkspaceSource(stubWorkbench({ 's-1': 'inst-1' }))

    const unfiltered = await source.candidates({ sessionId: 's-1' } as ClientSessionContext, {
      query: '', signal: new AbortController().signal,
    } as CandidateRequest)
    expect(unfiltered).toHaveLength(20)
    expect(unfiltered[0]?.name).toBe('f-00.txt')
    expect(unfiltered[0]?.section).toBe('实例空间文件')
    expect(unfiltered[0]?.icon).toBe('file')
    expect(unfiltered[0]?.value).toBe('f-00.txt')

    const filtered = await source.candidates({ sessionId: 's-1' } as ClientSessionContext, {
      query: 'F-2', signal: new AbortController().signal,
    } as CandidateRequest)
    expect(filtered.map(item => item.name)).toEqual(['f-20.txt', 'f-21.txt'])
  })

  it('inserts the plain mention text on pick', () => {
    const source = buildInstanceWorkspaceSource(stubWorkbench({ 's-1': 'inst-1' }))
    const outcome = source.onPick(baseSource())
    expect(outcome).toEqual({ text: '@实例空间/reports/a.txt' })
  })
})
