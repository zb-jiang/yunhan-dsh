/**
 * 用户新增 style 与 ppt-master skill 运行期副本的同步(设计 2026-11-05):
 *
 * 真身常驻 `$DSH_HOME/ppt-templates/styles/<slug>/`,skill 树只是运行期
 * 视图——插件升级时 `ensureSkillCopy` 会整体重拷副本,因此每次启动与每次
 * 登记后都执行回放同步:扫描真身目录,把合法的 `design_spec.md` 写进
 * `templates/styles/<slug>/templates/`,并把 frontmatter 元数据合并进
 * `styles_index.json`(只增不覆盖)。对 AI 的解析链保持 skill 原生约定:
 * styles_index.json → 目录 → design_spec.md,不引入第二条规则。
 *
 * @module
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** design_spec.md frontmatter 中与登记相关的字段。 */
export interface StyleFrontmatter {
  styleId: string
  summary: string
  keywords: string[]
}

/** styles_index.json 的单条元数据(与 skill 上游格式一致)。 */
export interface StyleIndexEntry {
  summary: string
  keywords: string[]
}

/** frontmatter 解析结果不合法:缺字段、keywords 数量越界或含空项。 */
export class StyleSpecError extends Error {}

/**
 * 提取 design_spec.md 的 frontmatter 三字段。YAML 取子集解析:标量行 +
 * 内联数组,不支持块标量——提炼指令要求 AI 按此格式产出。
 *
 * @param raw - design_spec.md 全文。
 * @returns 解析出的三字段。
 * @throws {@link StyleSpecError} frontmatter 缺失或字段不满足 style 契约。
 */
export function parseStyleFrontmatter(raw: string): StyleFrontmatter {
  const text = raw.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const block = match?.[1]
  if (block === undefined) throw new StyleSpecError('design_spec.md has no frontmatter block')
  const field = (key: string): string | undefined => {
    const line = block.split('\n').find(candidate => candidate.startsWith(`${key}:`))
    return line === undefined ? undefined : line.slice(key.length + 1).trim()
  }
  const styleId = field('style_id')
  const kind = field('kind')
  const summary = field('summary')
  const keywordsRaw = field('keywords')
  if (styleId === undefined || styleId === '') throw new StyleSpecError('frontmatter style_id is missing')
  if (kind !== 'style') throw new StyleSpecError('frontmatter kind must be "style"')
  if (summary === undefined || summary === '') throw new StyleSpecError('frontmatter summary is missing')
  const keywords = keywordsRaw === undefined
    ? []
    : keywordsRaw.replace(/^\[|\]$/g, '').split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(item => item !== '')
  if (keywords.length < 3 || keywords.length > 5) throw new StyleSpecError('frontmatter keywords must list 3 to 5 items')
  return { styleId, summary, keywords }
}

/** styles_index.json 的磁盘路径。 */
function stylesIndexPath(skillDir: string): string {
  return join(skillDir, 'templates', 'styles', 'styles_index.json')
}

/** 读 index;缺失/损坏按空表处理(副本刚重拷过时不会发生,防御坏盘)。 */
function readStyleIndex(skillDir: string): Record<string, StyleIndexEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stylesIndexPath(skillDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Record<string, StyleIndexEntry>
  } catch {
    return {}
  }
}

/** 写回 index(与上游相同的 2 空格缩进格式)。 */
function writeStyleIndex(skillDir: string, index: Record<string, StyleIndexEntry>): void {
  writeFileSync(stylesIndexPath(skillDir), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

/**
 * 登记或刷新一条 index 元数据;已存在的条目只补缺不覆盖(skill 上游
 * 14 套的条目永不改动)。
 */
function mergeStyleIndexEntry(skillDir: string, slug: string, entry: StyleIndexEntry): void {
  const index = readStyleIndex(skillDir)
  if (index[slug] === undefined) {
    index[slug] = entry
    writeStyleIndex(skillDir, index)
  }
}

/**
 * 删除一条 index 元数据;键不存在时原样写回无副作用。
 * @param skillDir - ppt-master 运行期副本目录。
 * @param slug - 待删除条目的 style id(index 键)。
 */
export function removeStyleIndexEntry(skillDir: string, slug: string): void {
  const index = readStyleIndex(skillDir)
  if (index[slug] !== undefined) {
    // 重建对象而非 delete:delete 动态键会退化到字典模式并触发 lint 禁令。
    const rest = Object.fromEntries(Object.entries(index).filter(([key]) => key !== slug))
    writeStyleIndex(skillDir, rest)
  }
}

/** 单套新增 style 同步进 skill 树:`design_spec.md` 拷贝 + index 合并。 */
function syncOneStyle(skillDir: string, slug: string, sourceDir: string, entry: StyleIndexEntry): void {
  const targetDir = join(skillDir, 'templates', 'styles', slug, 'templates')
  mkdirSync(targetDir, { recursive: true })
  cpSync(join(sourceDir, 'design_spec.md'), join(targetDir, 'design_spec.md'))
  mergeStyleIndexEntry(skillDir, slug, entry)
}

/**
 * 回放同步:扫描真身根目录,把每套带合法 `design_spec.md` 的新增 style
 * 同步进 skill 树。回放是宽容的——坏目录跳过不报错(启动不因遗留残骸
 * 阻塞);严格校验只在登记入口做。
 *
 * @param skillDir - ppt-master 运行期副本目录。
 * @param stylesRoot - 新增 style 真身根目录(`$DSH_HOME/ppt-templates/styles`)。
 */
export function syncAddedStyles(skillDir: string, stylesRoot: string): void {
  if (!existsSync(stylesRoot)) return
  for (const entry of readdirSync(stylesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const specFile = join(stylesRoot, entry.name, 'design_spec.md')
    if (!existsSync(specFile)) continue
    try {
      const frontmatter = parseStyleFrontmatter(readFileSync(specFile, 'utf8'))
      syncOneStyle(skillDir, entry.name, join(stylesRoot, entry.name), {
        summary: frontmatter.summary,
        keywords: frontmatter.keywords,
      })
    } catch {
      // 坏 spec:回放跳过;登记入口会对同样内容报错,这里无需重复上报。
    }
  }
}

/**
 * 把一套新增 style 从 skill 树摘除:删副本目录 + 删 index 条目。
 * 真身目录由调用方(删除端点)负责。
 *
 * @param skillDir - ppt-master 运行期副本目录。
 * @param slug - 待摘除的 style id。
 */
export function removeFromSkillTree(skillDir: string, slug: string): void {
  rmSync(join(skillDir, 'templates', 'styles', slug), { recursive: true, force: true })
  removeStyleIndexEntry(skillDir, slug)
}
