/**
 * 模板库(设计 2026-11-05 统一 style 语义):出厂模板(包
 * `assets/templates/`,只读)与用户新增 style(`$DSH_HOME/ppt-templates/
 * styles/`,读写)两棵目录,slug 全域唯一,id 即 style_id。出厂模板的
 * 磁盘布局:`<root>/<slug>/{template.json, spec.md, preview/page-NN.jpg}`;
 * 新增 style:`<root>/<slug>/{template.json, design_spec.md, preview/}`。
 * 对 AI 的本质是 style_id(经 skill 的 styles_index.json 解析),UI 只是选择器。
 *
 * 新增 style 上限 10 套;登记经暂存目录校验后原子落位(跨卷 rename 失败
 * 回退 copy+delete)。删除时联动摘除 skill 树副本与 index 条目。
 *
 * @module
 */

import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeFromSkillTree } from './stylesSync.ts'

/** 新增 style 数量上限;超限拒绝登记并提示先删。 */
export const MAX_CUSTOM_TEMPLATES = 10

/** 模板分类(设置页/画廊的分类 tab 数据源,设计 §5.1)。 */
export type TemplateCategory = 'business' | 'marketing' | 'consulting' | 'academic' | 'work' | 'personal'

/** 固定分类清单(顺序即画廊 tab 顺序)。 */
export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ['business', 'marketing', 'consulting', 'academic', 'work', 'personal']

/** 模板来源:出厂(随包分发)或用户新增;两者在画廊同为「内置」语义,仅删除权限不同。 */
export type PptTemplateOrigin = 'factory' | 'added'

/** 一套模板的统一数据模型(出厂与新增同构)。 */
export interface PptTemplate {
  /** style_id,即目录 slug;出厂与新增全域唯一。 */
  id: string
  name: string
  category: TemplateCategory
  origin: PptTemplateOrigin
  /** preview/ 下的页图数量(页图缺失时为 0)。 */
  pageCount: number
  /** 一句话描述,来自 template.json;缺省时为 undefined。 */
  description?: string
}

/** template.json 的声明形状(名字与分类必填)。 */
export interface TemplateMetaJson {
  name: string
  category: TemplateCategory
  description?: string
}

/** style slug 规则:小写字母开头,3–64 个字符,只含小写字母/数字/中划线。 */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,63}$/

/**
 * 解析单套模板目录;`template.json` 缺失/损坏、规格文档缺失时返回
 * undefined(坏模板跳过,不炸整张清单)。规格文档出厂为 `spec.md`,
 * 新增 style 为 skill 契约的 `design_spec.md`,两者都接受。
 *
 * @param dir - 模板目录绝对路径(对应一套模板)。
 * @param id - 模板 id,即目录 slug(style_id)。
 * @param origin - 模板来源(出厂或用户新增)。
 * @returns 统一模板数据;元数据或规格文档不合法时为 undefined。
 */
export function parseTemplateMeta(dir: string, id: string, origin: PptTemplateOrigin): PptTemplate | undefined {
  let meta: TemplateMetaJson
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record['name'] !== 'string' || typeof record['category'] !== 'string') return undefined
    if (!TEMPLATE_CATEGORIES.includes(record['category'] as TemplateCategory)) return undefined
    meta = {
      name: record['name'],
      category: record['category'] as TemplateCategory,
      ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
    }
  } catch {
    return undefined
  }
  if (!existsSync(join(dir, 'spec.md')) && !existsSync(join(dir, 'design_spec.md'))) return undefined
  let pageCount = 0
  try {
    pageCount = readdirSync(join(dir, 'preview')).filter(file => /^page-\d+\.jpg$/.test(file)).length
  } catch {
    // 无 preview 目录:清单仍列出该模板,页数为 0(画廊出占位卡)。
  }
  return {
    id,
    name: meta.name,
    category: meta.category,
    origin,
    pageCount,
    ...(meta.description === undefined ? {} : { description: meta.description }),
  }
}

/**
 * 扫描两棵目录组成清单;出厂在前、新增在后。目录缺失按空处理,坏模板
 * 目录跳过。slug 唯一性由登记校验保证,此处不做去重。
 *
 * @param builtinRoot - 出厂模板根目录(包 assets)。
 * @param stylesRoot - 用户新增 style 真身根目录。
 * @returns 出厂在前、新增在后的模板清单。
 */
export function listTemplates(builtinRoot: string, stylesRoot: string): PptTemplate[] {
  const scan = (root: string, origin: PptTemplateOrigin): PptTemplate[] => {
    if (!existsSync(root)) return []
    const templates: PptTemplate[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const template = parseTemplateMeta(join(root, entry.name), entry.name, origin)
      if (template !== undefined) templates.push(template)
    }
    return templates
  }
  return [...scan(builtinRoot, 'factory'), ...scan(stylesRoot, 'added')]
}

/**
 * 把模板 id(style_id)解析回磁盘目录:出厂目录存在即出厂,否则按新增
 * 根解析。slug 全域唯一(登记校验),存在性判定安全;非法 slug 返回
 * undefined。只做路由,不保证结果目录存在——调用方按文件逐个判定。
 *
 * @param builtinRoot - 出厂模板根目录。
 * @param stylesRoot - 用户新增 style 真身根目录。
 * @param id - 模板 id(style_id)。
 * @returns 解析到的目录路径;非法 slug 返回 undefined,新增候选不保证存在。
 */
export function resolveTemplateDir(builtinRoot: string, stylesRoot: string, id: string): string | undefined {
  if (!SLUG_PATTERN.test(id)) return undefined
  const factoryDir = join(builtinRoot, id)
  if (existsSync(factoryDir)) return factoryDir
  return join(stylesRoot, id)
}

/** 删除结果:`refused` = 出厂模板或 slug 非法,`missing` = 真身目录不存在。 */
export type DeleteOutcome = 'deleted' | 'missing' | 'refused'

/**
 * 删除一套用户新增 style:移除真身目录,并联动摘除 skill 树副本与
 * `styles_index.json` 条目。出厂模板拒删(磁盘只读,无副本可摘)。
 *
 * @param builtinRoot - 出厂模板根目录(拒删对照)。
 * @param stylesRoot - 用户新增 style 真身根目录。
 * @param skillDir - ppt-master 运行期副本目录(联动摘除目标)。
 * @param id - 待删除的模板 id(style_id)。
 * @returns `'deleted'` 已删除并联动摘除,`'missing'` 真身目录不存在,`'refused'` 出厂模板或 slug 非法。
 */
export function deleteTemplate(builtinRoot: string, stylesRoot: string, skillDir: string, id: string): DeleteOutcome {
  if (!SLUG_PATTERN.test(id)) return 'refused'
  if (existsSync(join(builtinRoot, id))) return 'refused'
  const dir = join(stylesRoot, id)
  if (!existsSync(dir)) return 'missing'
  rmSync(dir, { recursive: true, force: true })
  removeFromSkillTree(skillDir, id)
  return 'deleted'
}

/** 登记载荷的一张图:文件名 + base64 内容。 */
export interface ImportFile {
  /** 文件名(`page-01.jpg` 或 `example.pptx`),只取 basename。 */
  name: string
  /** base64 内容。 */
  data: string
}

/** 登记载荷:style slug + 元数据 + design_spec 全文 + 预览页图 + 可选示例成品。 */
export interface TemplateImport {
  /** style_id,来自 design_spec.md frontmatter;登记前已通过唯一性校验。 */
  slug: string
  meta: TemplateMetaJson
  /** design_spec.md 全文。 */
  designSpec: string
  /** preview/ 页图,文件名须为 `page-NN.jpg`。 */
  previews: ImportFile[]
  /** 可选示例成品。 */
  examplePptx?: ImportFile
}

/** 登记结果:`slug-conflict` = 与出厂或已有新增 slug 撞名,`limit-reached` = 新增已满。 */
export type ImportOutcome =
  | { kind: 'imported'; id: string }
  | { kind: 'invalid-meta' }
  | { kind: 'slug-conflict' }
  | { kind: 'limit-reached' }

/**
 * 校验通过后先写暂存目录 `.staging-<slug>`,再 rename 落位为 `<slug>`;
 * 中途任何失败都留在暂存态由调用方清理,不产生半套模板。
 *
 * @param stylesRoot - 用户新增 style 真身根目录。
 * @param payload - 登记载荷(slug/元数据/规格全文/页图/可选示例)。
 * @returns 登记结果,kind 语义见 {@link ImportOutcome};`imported` 携带新 style id。
 */
export function importTemplate(stylesRoot: string, payload: TemplateImport): ImportOutcome {
  if (!SLUG_PATTERN.test(payload.slug)) return { kind: 'invalid-meta' }
  if (payload.meta.name.trim() === '') return { kind: 'invalid-meta' }
  if (!TEMPLATE_CATEGORIES.includes(payload.meta.category)) return { kind: 'invalid-meta' }
  if (typeof payload.designSpec !== 'string' || payload.designSpec === '') return { kind: 'invalid-meta' }
  if (!Array.isArray(payload.previews) || payload.previews.length === 0) return { kind: 'invalid-meta' }
  if (!existsSync(stylesRoot)) mkdirSync(stylesRoot, { recursive: true })
  if (readdirSync(stylesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.staging-')).length >= MAX_CUSTOM_TEMPLATES) {
    return { kind: 'limit-reached' }
  }
  if (existsSync(join(stylesRoot, payload.slug))) return { kind: 'slug-conflict' }
  const staged = join(stylesRoot, `.staging-${payload.slug}`)
  try {
    installStaged(stylesRoot, staged, payload)
  } catch {
    rmSync(staged, { recursive: true, force: true })
    return { kind: 'invalid-meta' }
  }
  return { kind: 'imported', id: payload.slug }
}

/**
 * 写暂存目录并落位;抛错时由 {@link importTemplate} 统一清理。
 * @param stylesRoot - 用户新增 style 真身根目录(落位目标所在根)。
 * @param staged - 暂存目录绝对路径(`.staging-<slug>`)。
 * @param payload - 登记载荷。
 */
export function installStaged(stylesRoot: string, staged: string, payload: TemplateImport): void {
  mkdirSync(join(staged, 'preview'), { recursive: true })
  writeFileSync(join(staged, 'template.json'), `${JSON.stringify(payload.meta, null, 2)}\n`, 'utf8')
  writeFileSync(join(staged, 'design_spec.md'), payload.designSpec, 'utf8')
  for (const file of payload.previews) {
    writeFileSync(join(staged, 'preview', file.name), Buffer.from(file.data, 'base64'))
  }
  if (payload.examplePptx !== undefined) {
    writeFileSync(join(staged, 'example.pptx'), Buffer.from(payload.examplePptx.data, 'base64'))
  }
  const finalDir = join(stylesRoot, payload.slug)
  try {
    renameSync(staged, finalDir)
  } catch {
    // rename 跨卷(真身目录在别的盘)时 EXDEV:回退 copy + 删暂存。
    cpSync(staged, finalDir, { recursive: true })
    rmSync(staged, { recursive: true, force: true })
  }
}
