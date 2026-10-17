/**
 * 流程实例云工作空间 API 客户端(企业员工端,design
 * 2026-10-14-instance-workspace-design.md §5.2)。
 *
 * <p>文件面端点(list/upload/delete)经本地 DSH webserver 的
 * {@code /api/enterprise/workspace} 前缀代理到 web-console 的
 * {@code /api/workspace/*},响应是 web-console 的 {@code ApiResponse} 包装;
 * pull 与 session-context 是本地 instance-workspace 插件的自有路由(不经
 * 代理),响应为普通 JSON。请求统一带企业 JWT(与 task-api/kb-api 同源)。
 *
 * <p>pull 端点解决「浏览器无法写本地磁盘」:Node 侧代理拉取云端内容落到会话
 * 工作目录内的安全相对路径(下载目标或预览缓存)。
 */
import { readToken } from './task-api.ts'

/** web-console 统一响应包装({@code ApiResponse<T>})。 */
type ApiResponse<T> = {
  success: boolean
  data: T | null
  error: { code: string; message: string } | null
}

/** 实例空间文件清单项(web-console InstanceWorkspaceFileDto)。 */
export type InstanceWorkspaceFile = {
  /** 相对实例空间根的路径(`/` 分隔,如 `reports/周报.md`)。 */
  relPath: string
  sizeBytes: number
  contentType: string | null
  /** 上传人显示名(web-console 已解析;未知为 null)。 */
  uploadedByLabel: string | null
  /** 来源任务节点 id(自动节点写入时记录;人工上传为 null)。 */
  sourceTaskId: string | null
  createdAt: string
  updatedAt: string
  /** 云端元数据在而磁盘文件缺失(web-console 本地存储被清理等)。 */
  diskMissing: boolean
}

/** 实例空间 API 请求失败;status 保留 HTTP 状态码。 */
export class InstanceWorkspaceApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'InstanceWorkspaceApiError'
  }
}

/** 本地代理前缀(webserver 路由 /api/enterprise/workspace → web-console /api/workspace)。 */
const WS_BASE = '/api/enterprise/workspace'

/** 拉取到本地端点(本地 instance-workspace 插件自有 exact 路由)。 */
const PULL_PATH = '/api/enterprise/workspace/pull'

/** 会话绑定上报端点(本地 instance-workspace 插件自有 exact 路由)。 */
const SESSION_CONTEXT_PATH = '/api/enterprise/workspace/session-context'

/** pull 落盘目标:'cwd' = 会话工作目录同名路径,'cache' = 预览缓存目录。 */
export type PullTarget = 'cwd' | 'cache'

/** pull 结果:saved 携带落盘绝对路径;existed = 目标已存在且未指定覆盖(未下载)。 */
export type PullOutcome = { kind: 'saved'; localPath: string } | { kind: 'existed' }

/**
 * relPath 逐段 URL 编码(中文/空格安全;`/` 保留为分隔符)。
 * @param relPath - 相对实例空间根的路径。
 * @returns 编码后的路径段(用于拼 URL)。
 */
export function encodeRelPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/')
}

/**
 * 解包 ApiResponse 载荷;非 2xx 或 success=false 抛 {@link InstanceWorkspaceApiError}。
 * @param res - 已结算的 fetch 响应。
 * @param path - 请求路径(错误消息定位)。
 * @returns 包装内的 data(删除端点为 null)。
 */
async function unwrap<T>(res: Response, path: string): Promise<T> {
  let body: ApiResponse<T> | null = null
  try {
    body = await res.json() as ApiResponse<T>
  } catch {
    // 载荷不是 JSON(网关错误页等)时按空错误体处理,走统一抛错路径。
  }
  if (!res.ok) {
    throw new InstanceWorkspaceApiError(res.status, body?.error?.message ?? `${res.status} ${res.statusText}: ${path}`)
  }
  if (body === null || !body.success) {
    throw new InstanceWorkspaceApiError(res.status, body?.error?.message ?? `实例空间请求失败: ${path}`)
  }
  return body.data as T
}

/**
 * 带企业 JWT 的 JSON 请求(经本地代理)并解包。
 * @param path - WS_BASE 之后的路径(含前导 /)。
 * @param init - 透传 fetch init。
 */
async function wsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return unwrap<T>(await fetch(`${WS_BASE}${path}`, { ...init, headers }), path)
}

/**
 * 列实例空间全部文件(所有节点实时共享)。
 * @param instanceId - 流程实例 id。
 * @returns 文件清单(按 web-console 返回序)。
 * @throws InstanceWorkspaceApiError 非成员(404)或网络/鉴权失败。
 */
export async function listInstanceFiles(instanceId: string): Promise<InstanceWorkspaceFile[]> {
  return wsFetch<InstanceWorkspaceFile[]>(`/instances/${encodeURIComponent(instanceId)}/files`)
}

/**
 * 删除实例空间文件。
 * @param instanceId - 流程实例 id。
 * @param relPath - 目标相对路径。
 */
export async function deleteInstanceFile(instanceId: string, relPath: string): Promise<void> {
  await wsFetch<null>(`/instances/${encodeURIComponent(instanceId)}/files/content/${encodeRelPath(relPath)}`, {
    method: 'DELETE',
  })
}

/**
 * 上传本地工作空间文件到实例空间(multipart;path 为目标相对路径)。
 * @param instanceId - 流程实例 id。
 * @param relPath - 实例空间内的目标相对路径。
 * @param file - 从本地工作空间读出的文件内容。
 * @returns 上传后的文件元数据。
 */
export async function uploadToInstanceWorkspace(
  instanceId: string,
  relPath: string,
  file: File,
): Promise<InstanceWorkspaceFile> {
  const token = readToken()
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  const form = new FormData()
  form.append('path', relPath)
  form.append('file', file)
  const res = await fetch(`${WS_BASE}/instances/${encodeURIComponent(instanceId)}/files`, {
    method: 'POST',
    headers,
    body: form,
  })
  return unwrap<InstanceWorkspaceFile>(res, `/instances/${instanceId}/files`)
}

/**
 * 拉取实例空间文件到本地(经本地 pull 端点,Node 侧落盘)。
 * @param sessionId - 当前会话 id(端点据此解析会话工作目录)。
 * @param instanceId - 流程实例 id。
 * @param relPath - 实例空间内的源相对路径。
 * @param target - 落盘目标:'cwd' 写同名路径,'cache' 写预览缓存。
 * @param overwrite - target='cwd' 且目标已存在时是否直接覆盖;false 遇冲突返回 existed。
 * @returns saved 携带落盘绝对路径(预览用它构造 dsh-resource 地址);existed 表示冲突未下载。
 * @throws InstanceWorkspaceApiError 未登录(401)/参数非法(400)/超上限(413)/云端取数失败。
 */
export async function pullInstanceFile(
  sessionId: string,
  instanceId: string,
  relPath: string,
  target: PullTarget,
  overwrite = false,
): Promise<PullOutcome> {
  const token = readToken()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(PULL_PATH.slice(1), {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, instanceId, relPath, target, overwrite }),
  })
  const payload = await res.json().catch(() => null) as
    | { localPath?: unknown; existed?: unknown; error?: unknown }
    | null
  if (res.status === 409) return { kind: 'existed' }
  if (!res.ok || payload === null || typeof payload.localPath !== 'string') {
    const message = typeof payload?.error === 'string' ? payload.error : `${res.status} ${res.statusText}`
    throw new InstanceWorkspaceApiError(res.status, message)
  }
  return { kind: 'saved', localPath: payload.localPath }
}

/**
 * 上报会话与流程实例的绑定(本地插件内存映射;fire-and-forget,未登录静默
 * 跳过)。失败只损失下一轮的实例空间注入与 pull 端点的 cwd 解析,由下一次
 * 重放/重绑自愈,不打断工作台。
 * @param sessionId - 会话 id。
 * @param processInstanceId - 待办所属流程实例 id。
 */
export function reportSessionWorkspaceContext(sessionId: string, processInstanceId: string): void {
  const token = readToken()
  if (token === null) return
  void fetch(SESSION_CONTEXT_PATH.slice(1), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, processInstanceId }),
  }).catch((error: unknown) => {
    console.warn('实例空间会话绑定上报失败(下一次重放自愈)', error)
  })
}
