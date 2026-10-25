import type { AxiosResponse } from 'axios'
import { readToken } from '../auth/auth-session'
import { http } from './client'
import { del, get, patch, post } from './client'
import type { ApiResponse } from './types'

const baseURL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

/** 知识库(一个应用一个库)。 */
export interface KnowledgeBaseDto {
  id: string
  applicationId: string
  name: string
  createdAt: string | null
}

/** 文件夹(parentId 为 null 表示根目录;path 为物化路径,如 '/财务/报销')。 */
export interface KbFolderDto {
  id: string
  kbId: string
  parentId: string | null
  name: string
  path: string
  createdAt: string | null
}

/** 文档列表项(textExcerpt 为摘要窗口;全文经下载端点获取)。 */
export interface KbDocumentDto {
  id: string
  kbId: string
  folderId: string | null
  name: string
  contentType: string
  sizeBytes: number
  parseStatus: 'pending' | 'ready' | 'failed'
  parseError: string | null
  textExcerpt: string
  /** 单 chunk 最大字符数(重新解析对话框预填)。 */
  chunkMaxSize: number
  /** 相邻 chunk 重叠字符数。 */
  chunkOverlap: number
  /** 优先切分的分隔符(真实字符,如 '\n\n')。 */
  chunkSeparator: string
  uploadedBy: string
  /** 上传者显示名(用户记录缺失时为 null,降级显示 uploadedBy 短 id)。 */
  uploaderName: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** chunk 拆分参数(上传/重新解析;全字段可选,缺省取服务端配置默认)。 */
export interface ChunkParams {
  chunkMaxSize?: number
  chunkOverlap?: number
  chunkSeparator?: string
}

/** 当前用户可见的知识库摘要(应用名 + 库名)。 */
export interface KbAppSummary {
  kbId: string
  applicationId: string
  applicationName: string
  kbName: string
}

/** 单路候选明细(向量路为 chunk 行,词法两路为文档行;rank 从 1 起)。 */
export interface KbTraceCandidate {
  docId: string
  docName: string
  folderId: string | null
  rank: number
  /** 路内原始排序分(向量=余弦距离/关键词=trgm 相似度/全文=ts_rank)。 */
  rawScore: number | null
  /** 块下标(仅向量路)。 */
  chunkIndex: number | null
  /** 该行向所属文档贡献的 RRF 分 1/(60+rank)。 */
  rrfScore: number
  /** 命中文本(向量路为 chunk 原文;词法两路为文档 text_content 前 1000 字符)。 */
  snippet: string
}

/** 单路候选明细(search-debug)。 */
export interface KbTracePath {
  /** 路径机器名:vector | keyword | fts。 */
  path: 'vector' | 'keyword' | 'fts'
  metric: string
  candidates: KbTraceCandidate[]
}

/** 单条 RRF 贡献明细。 */
export interface KbTraceContribution {
  path: 'vector' | 'keyword' | 'fts'
  rank: number
  score: number
}

/** 文档级 RRF 融合明细(出现在任意一路的文档都有一行,不只 topK)。 */
export interface KbTraceDoc {
  docId: string
  docName: string
  folderId: string | null
  totalScore: number
  finalRank: number
  inTopK: boolean
  contributions: KbTraceContribution[]
}

/** rerank 泳道候选行(RRF 候选池 2×topK 中每篇文档的融合分与重排分)。 */
export interface KbTraceRerank {
  docId: string
  docName: string
  /** RRF 融合分(池序按此降序)。 */
  rrfScore: number
  /** 重排相关性分(0~1,越大越相关;null = 本次 rerank 调用失败降级)。 */
  rerankScore: number | null
  /** 是否进入最终 topK。 */
  inTopK: boolean
}

/** 混合检索 debug 追踪(三路候选 + RRF 融合 + rerank 精排 + 最终命中)。 */
export interface KbSearchTraceDto {
  kbId: string
  query: string
  folderId: string | null
  topK: number
  candidateLimit: number
  /** rerank 采纳阈值(低于阈值的候选被过滤)。 */
  rerankMinScore: number
  /** rerank 模型名(展示用)。 */
  rerankModel: string
  paths: KbTracePath[]
  rerankPool: KbTraceRerank[]
  docs: KbTraceDoc[]
  results: KbSearchHitDto[]
}

/** 文档级检索命中(与 search 端点一致)。 */
export interface KbSearchHitDto {
  docId: string
  docName: string
  folderId: string | null
  /** 原文摘录:文档 text_content 前 1000 字符在前,有向量命中时追加名次最优块(换行分隔)。 */
  snippet: string
  /** 相关性分:rerank 启用时为重排分(0~1);关闭或降级时为 RRF 融合分。 */
  score: number
}

export const kbApi = {
  /** 查应用知识库(不存在则按需开通)。 */
  ensureByApp: (appId: string) => get<KnowledgeBaseDto>(`/api/apps/${appId}/kb`),

  /** 当前用户可见的知识库清单(system_admin 全部;其余为管理员 ∪ 成员的应用)。 */
  listMine: () => get<KbAppSummary[]>('/api/kb/mine'),

  /**
   * 混合检索 debug 追踪:返回三路候选与 RRF 融合中间态。
   * 每次调用后端会真实执行一次查询向量化(硅基流动)。
   */
  searchDebug: (kbId: string, params: { query: string; topK?: number }) =>
    get<KbSearchTraceDto>(`/api/kb/${kbId}/search-debug`, params as Record<string, unknown>),

  /** 文件夹平铺列表(后端按 path 排序,前端组树)。 */
  listFolders: (kbId: string) => get<KbFolderDto[]>(`/api/kb/${kbId}/folders`),

  createFolder: (kbId: string, body: { name: string; parentId?: string }) =>
    post<KbFolderDto>(`/api/kb/${kbId}/folders`, body),

  /** 重命名/移动文件夹(后端同步重算子树 path;不支持移动到根)。 */
  updateFolder: (kbId: string, folderId: string, body: { name?: string; parentId?: string }) =>
    patch<KbFolderDto>(`/api/kb/${kbId}/folders/${folderId}`, body),

  deleteFolder: (kbId: string, folderId: string) =>
    del<void>(`/api/kb/${kbId}/folders/${folderId}`),

  /** 列文档。folderId 缺省 = 根;kw 检索时后端只返回解析 ready 的文档。 */
  listDocuments: (
    kbId: string,
    params: { folderId?: string; recursive?: boolean; kw?: string; parseStatus?: string },
  ) => get<KbDocumentDto[]>(`/api/kb/${kbId}/documents`, params as Record<string, unknown>),

  /**
   * 上传文档(multipart;chunk 参数可选)。
   *
   * <p>不走 axios:http 实例默认 JSON Content-Type,而 FormData 必须由浏览器生成
   * 带 boundary 的 multipart 头,故直接用 fetch(不手动设 Content-Type);
   * 顺带避免大文件上传被 axios 30s 超时截断。
   */
  upload: async (kbId: string, file: File, folderId: string | null, params?: ChunkParams): Promise<KbDocumentDto> => {
    const token = readToken()
    if (!token) throw new Error('登录状态失效,请重新登录')
    const form = new FormData()
    form.append('file', file)
    if (params?.chunkMaxSize !== undefined) form.append('chunkMaxSize', String(params.chunkMaxSize))
    if (params?.chunkOverlap !== undefined) form.append('chunkOverlap', String(params.chunkOverlap))
    if (params?.chunkSeparator !== undefined) form.append('chunkSeparator', params.chunkSeparator)
    const qs = folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''
    const resp = await fetch(`${baseURL}/api/kb/${kbId}/documents${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const body = (await resp.json()) as ApiResponse<KbDocumentDto>
    if (!resp.ok || !body.success) {
      throw new Error(body.error?.message ?? `上传失败(${resp.status})`)
    }
    if (body.data === null || body.data === undefined) {
      throw new Error('上传响应缺少文档数据')
    }
    return body.data
  },

  /**
   * 重新解析(从 Storage 回读原文重走抽取 → chunk → embedding 全管线;
   * chunk 参数可选,缺省沿用文档当前值;解析中后端拒绝)。
   */
  reparse: (kbId: string, docId: string, params?: ChunkParams) =>
    post<KbDocumentDto>(`/api/kb/${kbId}/documents/${docId}/reparse`, params ?? {}),

  /** 下载原文(二进制响应,不经 ApiResponse 解包;拦截器对非标准响应原样放行)。 */
  download: async (kbId: string, docId: string): Promise<Blob> => {
    const resp = await http.get(`/api/kb/${kbId}/documents/${docId}/content`, {
      responseType: 'blob',
    })
    return (resp as unknown as AxiosResponse<Blob>).data
  },

  deleteDocument: (kbId: string, docId: string) =>
    del<void>(`/api/kb/${kbId}/documents/${docId}`),
}
