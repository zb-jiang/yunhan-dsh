/**
 * SkillHub 清单/下载纯函数:skill-sync daemon、治理端点与 dsh-backend-task
 * 的同步路径共用。经 `./skillhub` 子路径跨包共享,entry 不重导出
 * (verify-plugin-entry-exports)。
 *
 * @module @deepseek-ai/dsh-skill-sync/skillhub
 */

import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

/** SkillHub 清单端点返回非 2xx;status 供调用方区分「namespace 不存在」与网络/服务错误。SkillHub 当前对未知 namespace 抛业务校验异常映射为 400(非 404),两者均视为不存在。 */
export class SkillhubManifestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`SkillHub 命名空间清单返回 ${status}${detail === '' ? '' : `: ${detail}`}`)
    this.name = 'SkillhubManifestError'
  }
}

/** SkillHub 命名空间清单的单个 skill 条目(CliNamespaceSyncItemResponse)。 */
export interface SkillHubItem {
  slug: string
  fingerprint: string
  downloadUrl: string
  /** 最新发布版本号;市场目录展示用,同步路径不读。 */
  version?: string
  /** SKILL.md frontmatter description;市场目录展示用,同步路径不读。 */
  summary?: string
  /** 最新发布时间;市场目录展示用,同步路径不读。 */
  updatedAt?: string
}

/** SkillHub 命名空间清单单页上限(服务端 CLI 端点上限 100)。 */
const SKILLHUB_PAGE_LIMIT = 100

/**
 * 拉取 SkillHub 命名空间的已发布 skill 清单(翻页取全量)。
 *
 * <p>导出供 dsh-backend-task 复用(其同步源是 web-console 注册表聚合而非
 * flowable 待办,但 SkillHub 清单/下载是同一套)。
 *
 * @param skillhubBaseUrl - SkillHub 后端 API 基地址(无尾斜杠)。
 * @param skillhubToken - SkillHub 只读分发 token。
 * @param namespace - 命名空间名。
 * @returns slug → 清单条目的索引。
 */
export async function fetchSkillhubManifest(
  skillhubBaseUrl: string,
  skillhubToken: string,
  namespace: string,
): Promise<Map<string, SkillHubItem>> {
  const index = new Map<string, SkillHubItem>()
  let cursor: string | undefined = '0'
  while (cursor !== undefined && cursor !== '') {
    const response = await fetch(
      `${skillhubBaseUrl}/api/cli/v1/namespaces/${encodeURIComponent(namespace)}/skills`
        + `?cursor=${encodeURIComponent(cursor)}&limit=${SKILLHUB_PAGE_LIMIT}`,
      { headers: { authorization: `Bearer ${skillhubToken}` } },
    )
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new SkillhubManifestError(response.status, detail)
    }
    const body = await response.json() as {
      code?: number
      data?: { items?: SkillHubItem[]; nextCursor?: string | null }
    }
    if (body.code !== 0 || body.data === undefined) {
      throw new Error(`SkillHub 响应信封异常: code=${body.code ?? 'missing'}`)
    }
    for (const item of body.data.items ?? []) {
      index.set(item.slug, item)
    }
    cursor = body.data.nextCursor ?? undefined
  }
  return index
}

/**
 * 下载并安装单个 skill 包:zip 根即 SKILL.md(SkillHub 打包已剥外层目录),
 * 解压到临时目录后原子改名到 `<skillDir>/<name>`。导出供 dsh-backend-task 复用。
 *
 * @param skillhubBaseUrl - SkillHub 后端 API 基地址(无尾斜杠)。
 * @param skillhubToken - SkillHub 只读分发 token。
 * @param skillDir - 缓存根目录(已存在)。
 * @param name - skill 裸名(安装目录名)。
 * @param item - 清单条目(带 downloadUrl)。
 */
export async function installSkillZip(
  skillhubBaseUrl: string,
  skillhubToken: string,
  skillDir: string,
  name: string,
  item: SkillHubItem,
): Promise<void> {
  const downloadUrl = new URL(item.downloadUrl, `${skillhubBaseUrl}/`)
  const response = await fetch(downloadUrl, {
    headers: { authorization: `Bearer ${skillhubToken}` },
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`下载 skill 包返回 ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
  await installZipEntries(skillDir, name, entries)
}

/**
 * 把已解压的 zip 条目安装进缓存根:写入临时目录后原子改名到 `<skillDir>/<name>`
 * (任一条目失败整包回滚)。SkillHub 下载与员工上传两条安装路径共用。
 *
 * @param skillDir - 缓存根目录(已存在)。
 * @param name - skill 裸名(安装目录名)。
 * @param entries - fflate 解压出的条目表(路径 → 内容)。
 */
export async function installZipEntries(
  skillDir: string,
  name: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  const tempDir = await mkdtemp(join(skillDir, `.tmp-${name}-`))
  try {
    for (const [entryPath, content] of Object.entries(entries)) {
      if (entryPath === '' || entryPath.endsWith('/')) continue
      const target = safeJoin(tempDir, entryPath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    const dest = join(skillDir, name)
    await rm(dest, { recursive: true, force: true })
    await rename(tempDir, dest)
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * 把 zip 条目名安全映射到解压根目录下;绝对路径或 `..` 段(zip 炸弹/路径
 * 穿越特征)抛错拒绝整个安装。
 */
function safeJoin(root: string, entryPath: string): string {
  const normalized = entryPath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`zip 条目路径不安全: ${entryPath}`)
  }
  return join(root, normalized)
}
