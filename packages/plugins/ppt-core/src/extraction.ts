/**
 * 上传提炼编排(设计 2026-11-05):员工上传参考 .pptx 后,插件不自行
 * 解析,而是构造一条指向 ppt-master style 契约的任务指令,由新会话产出
 * 合法的 style 工作区(`ppt-template/`:`design_spec.md` + `template.json`
 * + preview 页图);登记是显式的第二步(`/api/ppt/templates/import`),宿主
 * 从会话工作空间读产物,校验 frontmatter 后落真身并同步 skill 树。
 *
 * @module
 */

import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { importTemplate, SLUG_PATTERN, type ImportOutcome, type ImportFile, type TemplateCategory, type TemplateMetaJson } from './templates.ts'
import { parseStyleFrontmatter, syncAddedStyles } from './stylesSync.ts'

/** 提炼指令的参数:slug/显示名/分类,全部来自「新增模板」对话框表单。 */
export interface ExtractionSpec {
  slug: string
  name: string
  category: TemplateCategory
}

/**
 * 构造提炼任务指令:让会话按 skill 的 style 工作区契约分析上传文件并
 * 产出产物。style_id 用表单 slug,登记时以产物 frontmatter 为准。
 *
 * @param skillDir - ppt-master 运行期副本目录(契约文档与示例相对它)。
 * @param uploadPath - 上传文件在工作空间的落盘绝对路径。
 * @param spec - 对话框表单参数。
 * @returns 直接作为新会话首条用户消息的完整指令文本。
 */
export function buildExtractionPrompt(skillDir: string, uploadPath: string, spec: ExtractionSpec): string {
  const stylesDir = join(skillDir, 'templates', 'styles')
  return [
    '请把下面的参考文件提炼成一套可复用的 PPT style(风格工作区)。严格按以下步骤执行:',
    '',
    `1. 读取并遵循 \`${skillDir}/templates/styles/README.md\` 中 style 工作区的 \`design_spec.md\` 契约(frontmatter 与正文 I–VII 节的完整要求);可参考已有 style 的写法,如 \`${stylesDir}/product-launch/templates/design_spec.md\`。`,
    `2. 分析参考文件 \`${uploadPath}\`(可能是 .pptx 或 .pdf):归纳其版式结构、配色、字体与图文布局,提炼出可复用的沟通方法与设计默认值;PDF 按页读取内容与版面特征。`,
    '3. 在当前工作空间产出 `ppt-template/` 目录,包含三件:',
    `   - \`design_spec.md\`:符合上述契约的完整设计规格。frontmatter 必须含 \`style_id: ${spec.slug}\`、\`kind: style\`、一句话 \`summary\`、3–5 个 \`keywords\`(内联数组形式);正文按契约的 I–VII 节组织。`,
    `   - \`template.json\`:元数据,内容固定为 {"name": "${spec.name}", "category": "${spec.category}", "description": "一句话描述"};`,
    '   - `preview/`:提炼自参考文件的示例页图,命名 `page-01.jpg`、`page-02.jpg` 递增(至少 1 张)。',
    '',
    '全部产出完成后,单独一行输出当前工作空间的绝对路径,供用户回填登记。',
  ].join('\n')
}

/** 工作空间登记结果:`invalid-meta` = 产物缺失/不可解析/契约不符,`slug-conflict` = 撞名,`limit-reached` = 新增已满。 */
export type WorkspaceImportOutcome = Extract<ImportOutcome, { kind: 'invalid-meta' | 'slug-conflict' | 'limit-reached' | 'imported' }>

/** 预览页图文件名约束(与 parseTemplateMeta 的清点规则一致)。 */
const PREVIEW_NAME = /^page-\d+\.jpg$/

/**
 * 从会话工作空间读取提炼产物并登记为新增 style。产物目录固定为
 * `<workspace>/ppt-template/`;style_id 取自 design_spec.md frontmatter
 * (slug 唯一性在此校验),登记成功后把新 style 同步进 skill 树与
 * `styles_index.json`。preview 里非 `page-N.jpg` 命名的文件与子目录一律
 * 忽略,页图名被目录占用导致读取失败(EISDIR)视为产物不合法。
 *
 * @param stylesRoot - 新增 style 真身根目录。
 * @param builtinRoot - 出厂模板根目录(slug 唯一性对照)。
 * @param skillDir - ppt-master 运行期副本目录(同步目标)。
 * @param workspace - 会话工作空间根目录。
 * @returns 登记结果,kind 语义见 {@link WorkspaceImportOutcome};`imported` 已同步进 skill 树。
 */
export function importFromWorkspace(stylesRoot: string, builtinRoot: string, skillDir: string, workspace: string): WorkspaceImportOutcome {
  const dir = join(workspace, 'ppt-template')
  try {
    const meta: unknown = JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8'))
    if (typeof meta !== 'object' || meta === null) return { kind: 'invalid-meta' }
    const record = meta as Record<string, unknown>
    if (typeof record['name'] !== 'string' || typeof record['category'] !== 'string') return { kind: 'invalid-meta' }
    const designSpec = readFileSync(join(dir, 'design_spec.md'), 'utf8')
    const frontmatter = parseStyleFrontmatter(designSpec)
    if (!SLUG_PATTERN.test(frontmatter.styleId)) return { kind: 'invalid-meta' }
    if (existsSync(join(builtinRoot, frontmatter.styleId))) return { kind: 'slug-conflict' }
    const previewFiles = readdirSync(join(dir, 'preview')).filter(name => PREVIEW_NAME.test(name))
    const previews: ImportFile[] = previewFiles.map(name => ({
      name,
      data: readFileSync(join(dir, 'preview', name)).toString('base64'),
    }))
    const examplePath = join(dir, 'example.pptx')
    const outcome = importTemplate(stylesRoot, {
      slug: frontmatter.styleId,
      meta: {
        name: record['name'],
        category: record['category'] as TemplateCategory,
        ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
      } satisfies TemplateMetaJson,
      designSpec,
      previews,
      ...(existsSync(examplePath) ? { examplePptx: { name: 'example.pptx', data: readFileSync(examplePath).toString('base64') } } : {}),
    })
    if (outcome.kind === 'imported') syncAddedStyles(skillDir, stylesRoot)
    return outcome
  } catch {
    // 产物缺失/损坏/frontmatter 违反 style 契约统一按 invalid-meta 拒绝。
    return { kind: 'invalid-meta' }
  }
}
