/**
 * Skill governance API client for the enterprise skills panel.
 *
 * <p>All endpoints live under {@code /api/enterprise/skills} on the local DSH
 * webserver, served by the skill-sync plugin. Requests carry the enterprise
 * JWT from localStorage when present: catalog includes the process-required
 * group only when authenticated, while install/import/uninstall work
 * anonymously (the employee drawer is a loopback-local directory). This
 * module re-declares the wire types locally: feature plugins must not
 * runtime-import other feature plugins' values.
 */

const TOKEN_KEY = 'dsh.enterprise.token'

/** 技能安装来源;与 skill-sync 的账本/目录扫描溯源一致(manual 为手工放入、无账本记录)。 */
export type SkillSource = 'required' | 'upload' | 'skillhub' | 'manual'

/** 本地已装技能条目(catalog 响应的 local 分组;source 缺省视为 required)。 */
export type InstalledSkill = {
  name: string
  source: SkillSource
  namespace?: string
  description?: string
}

/** 市场目录条目(单 namespace 清单的一行)。 */
export type CatalogSkill = {
  namespace: string
  slug: string
  fingerprint: string
  downloadUrl: string
  version?: string
  summary?: string
  updatedAt?: string
  installed: boolean
  source?: SkillSource
}

/** 单个市场 namespace 的拉取结果;该组失败时 error 非空、skills 为空。 */
export type CatalogNamespace = {
  namespace: string
  error?: string
  skills: CatalogSkill[]
}

/** `GET /api/enterprise/skills/catalog` 响应。 */
export type SkillCatalog = {
  /** 请求携带有效员工 JWT;false = 匿名浏览(local 不含 required 条目)。 */
  authenticated: boolean
  catalogOpen: boolean
  namespaces: CatalogNamespace[]
  local: InstalledSkill[]
}

/** 治理端点非 2xx 响应;status 供面板区分登录失效(401)与其他失败。 */
export class SkillRequestError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(describeErrorBody(body))
    this.name = 'SkillRequestError'
  }
}

/** 从响应体提取面向用户展示的 error 文本;非 JSON 或无 error 字段时回退原文。 */
function describeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error
  } catch {
    // 非 JSON body 按原文展示
  }
  return body
}

/**
 * 读取企业 JWT。
 * @returns localStorage 中的令牌;无令牌或非浏览器环境为 null。
 */
function readToken(): string | null {
  /* v8 ignore next -- SSR guard: the jsdom test lane always defines window */
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_KEY)
}

/**
 * 请求治理端点并解包 JSON;非 2xx 时抛出携带状态码的 {@link SkillRequestError}。
 * @param path - 同域相对路径。
 * @param init - fetch 初始化参数。
 * @returns 响应 JSON。
 */
async function skillsFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = readToken()
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) throw new SkillRequestError(res.status, await res.text())
  return await res.json() as T
}

/**
 * 拉取技能目录(本地已装 + 各市场 namespace)。
 * @returns 目录快照。
 */
export async function getSkillsCatalog(): Promise<SkillCatalog> {
  return skillsFetch<SkillCatalog>('api/enterprise/skills/catalog')
}

/**
 * 从市场安装技能(已装且同指纹时端点幂等)。
 * @param namespace - 市场 namespace。
 * @param slug - 技能裸名。
 */
export async function installSkillhubSkill(namespace: string, slug: string): Promise<void> {
  await skillsFetch('api/enterprise/skills/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace, slug }),
  })
}

/**
 * 卸载技能(流程要求的技能端点返回 403)。
 * @param slug - 技能裸名。
 */
export async function uninstallSkill(slug: string): Promise<void> {
  await skillsFetch('api/enterprise/skills/uninstall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  })
}

/**
 * 上传导入技能 zip 包(原始字节体;同名冲突时端点返回 409)。
 * @param bytes - zip 文件字节(须为 ArrayBuffer 承载,DOM BodyInit 不接受 SharedArrayBuffer 视图)。
 * @returns 端点解析出的技能名。
 */
export async function importSkillZip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const res = await skillsFetch<{ name: string }>('api/enterprise/skills/import', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: bytes,
  })
  return res.name
}
