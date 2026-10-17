import type { AxiosResponse } from 'axios'
import { readToken } from '../auth/auth-session'
import { del, get, http, post } from './client'
import type { ApiResponse } from './types'

const baseURL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

/** 实例空间文件元数据(设计 docs/plans/2026-10-14-instance-workspace-design.md §4.1)。 */
export interface InstanceWorkspaceFileDto {
  /** 相对路径(/ 分隔) */
  relPath: string
  /** 文件字节数 */
  sizeBytes: number
  /** 内容类型(可空) */
  contentType: string | null
  /** 上传人显示名快照(员工 displayName / 'dsh-service') */
  uploadedByLabel: string | null
  /** 写入来源节点 id(可空) */
  sourceTaskId: string | null
  /** 首次写入时间 */
  createdAt: string
  /** 最近覆盖时间 */
  updatedAt: string
  /** 磁盘文件是否缺失(元数据行存在但盘上已无,按不存在处理) */
  diskMissing: boolean
}

/** 把 relPath 编码进 URL 路径段:逐段 encodeURIComponent 保留 / 分隔符(后端 {*relPath} 按剩余路径捕获)。 */
function encodeRelPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/')
}

/** 流程实例云工作空间员工面 API(管理员经成员校验直通,可直接操作任意实例空间)。 */
export const instanceWorkspaceApi = {
  /** 列实例空间全部文件。 */
  list: (instanceId: string) =>
    get<InstanceWorkspaceFileDto[]>(`/api/workspace/instances/${instanceId}/files`),

  /**
   * 上传/覆盖字节文件(multipart;同 relPath 覆盖,后写者胜)。
   *
   * <p>不走 axios:http 实例默认 JSON Content-Type,而 FormData 必须由浏览器生成
   * 带 boundary 的 multipart 头,故直接用 fetch(不手动设 Content-Type);
   * 顺带避免大文件上传被 axios 30s 超时截断。
   */
  upload: async (instanceId: string, relPath: string, file: File): Promise<InstanceWorkspaceFileDto> => {
    const token = readToken()
    if (!token) throw new Error('登录状态失效,请重新登录')
    const form = new FormData()
    form.append('path', relPath)
    form.append('file', file)
    const resp = await fetch(`${baseURL}/api/workspace/instances/${instanceId}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const body = (await resp.json()) as ApiResponse<InstanceWorkspaceFileDto>
    if (!resp.ok || !body.success) {
      throw new Error(body.error?.message ?? `上传失败(${resp.status})`)
    }
    if (body.data === null || body.data === undefined) {
      throw new Error('上传响应缺少文件数据')
    }
    return body.data
  },

  /** 写/覆盖文本文件(UTF-8;content 允许空串)。 */
  writeText: (instanceId: string, path: string, content: string) =>
    post<InstanceWorkspaceFileDto>(`/api/workspace/instances/${instanceId}/files/text`, { path, content }),

  /** 下载单文件(二进制响应,不经 ApiResponse 解包;拦截器对非标准响应原样放行)。 */
  download: async (instanceId: string, relPath: string): Promise<Blob> => {
    const resp = await http.get(`/api/workspace/instances/${instanceId}/files/content/${encodeRelPath(relPath)}`, {
      responseType: 'blob',
    })
    return (resp as unknown as AxiosResponse<Blob>).data
  },

  /** 导出实例空间全部文件为 zip。 */
  exportZip: async (instanceId: string): Promise<Blob> => {
    const resp = await http.get(`/api/workspace/instances/${instanceId}/files/export`, {
      responseType: 'blob',
    })
    return (resp as unknown as AxiosResponse<Blob>).data
  },

  /** 删除单文件(先删行再删盘;行不存在或磁盘缺失均 404)。 */
  remove: (instanceId: string, relPath: string) =>
    del<void>(`/api/workspace/instances/${instanceId}/files/content/${encodeRelPath(relPath)}`),
}

/** 触发浏览器保存 blob 为文件下载。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
