/**
 * AI 生成 PPT 插件宿主侧(可安装插件,设计 2026-11-04 §4.2)。
 *
 * 职责:vendored ppt-master skill 的副本管理与注册(§5.3)、systemPrompt
 * 能力说明、模板库与生图配置/Python 检测的 RPC 全集(§5.1/§5.2/§5.5)。
 * 生图配置以设置页写入的 `$DSH_HOME/ppt/settings.json` 为准,cordis.yml
 * 的 Config 字段只在文件缺失时作为种子默认值。
 *
 * @module @deepseek-ai/dsh-ppt-core
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { nodeCommandRunner } from './python.ts'
import { registerPptRoutes } from './rpc.ts'
import { applyDotEnv, createPptSkillProvider, ensureSkillCopy, packageSkillDir, targetSkillDir } from './skill.ts'
import { readSettings, settingsFile, writeSettings, type ImageSettings } from './settings.ts'
import { syncAddedStyles } from './stylesSync.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ppt-core'

/** 等待 webserver、skill 注册表与 systemPrompt 服务就绪后才挂载。 */
export const inject = ['webServer', 'skills', 'systemPrompt']

/** 插件配置;全部可空,空串 = 未配置。文件缺失时作为设置种子默认值。 */
export interface Config {
  /** 生图后端(ppt-master IMAGE_BACKEND 取值,如 openai/gemini)。 */
  imageBackend?: string
  /** 生图服务商 API Key(只存员工本机,GET 响应永不回传明文)。 */
  imageApiKey?: string
  /** OpenAI 兼容中转基地址;官方端点留空。 */
  imageBaseUrl?: string
  /** 生图模型名。 */
  imageModel?: string
}

export const Config: z<Config> = z.object({
  imageBackend: z.string().default(''),
  imageApiKey: z.string().default(''),
  imageBaseUrl: z.string().default(''),
  imageModel: z.string().default(''),
})

/** `GET /api/ppt/status` 的响应体。 */
export interface PptStatus {
  ok: true
  plugin: 'ppt'
}

/**
 * 健康端点载荷(纯函数,安装闭环验证的观测点)。
 * @returns 固定的健康载荷 `{ ok: true, plugin: 'ppt' }`。
 */
export function statusPayload(): PptStatus {
  return { ok: true, plugin: 'ppt' }
}

/** systemPrompt 能力说明段名。 */
const PROMPT_SECTION_NAME = 'ppt:capability'

/** systemPrompt 能力说明:路由规则 + 模板锚点 + 生图降级。 */
function promptSectionText(skillDir: string, builtinRoot: string, stylesRoot: string): string {
  const stylesIndex = join(skillDir, 'templates', 'styles')
  return [
    '## PPT 生成(插件)',
    '',
    '本环境装有 ppt-master skill,用于生成**原生可编辑的 .pptx**(非图片贴片)。',
    `- 用户要求制作/生成/美化 PPT、幻灯片、课件时,优先加载并遵循 \`${skillDir}/SKILL.md\` 的路由与工作流;不要用其他通用 office/pptx 技能做同类工作。`,
    `- 用户消息附带「模板指令」时,按其中括号内的样式引用进入该 skill 的模板模式:引用是 style_id,经 \`${stylesIndex}/styles_index.json\` 解析到 \`${stylesIndex}/<style_id>/\` 并读取其 templates/design_spec.md,严格按该设计规格制作全部页面。`,
    `- 用户指名某套模板中文名(未带模板指令)时,同样视为显式模板使用请求:出厂模板在 \`${builtinRoot}\` 各模板目录的 template.json 按 name 匹配得到 style_id(目录名即 style_id);用户新增模板在 \`${stylesRoot}\` 各目录按 name 匹配,目录名即 style_id。`,
    '- 用户上传 .pptx 要求提炼模板时,按消息中的提炼任务指令产出符合 style 契约的产物到指定目录。',
    '- 生图配置由插件注入;未配置时按 skill 自带规则走网络图搜或无图降级。',
    '- Python 依赖缺失时告知用户在插件设置里完成环境检测引导,不要尝试替用户安装 Python。',
  ].join('\n')
}

/**
 * 挂载 PPT 宿主插件:skill 副本与注册、systemPrompt 说明、`/api/ppt` 路由。
 *
 * @param ctx - 携带 webServer/skills/systemPrompt 的 Cordis 上下文。
 * @param config - 插件配置(设置文件缺失时的种子默认值)。
 */
export function apply(ctx: Context, config: Config): void {
  const packageRoot = dirname(fileURLToPath(import.meta.url))
  const builtinRoot = join(packageRoot, '..', 'assets', 'templates')
  const customRoot = dshHomePath('ppt-templates')
  const stylesRoot = join(customRoot, 'styles')
  const uploadsDir = dshHomePath('ppt', 'uploads')

  const skillSource = packageSkillDir(packageRoot)
  const skillDir = targetSkillDir()
  ensureSkillCopy(skillSource, skillDir)
  // 副本重拷会抹掉用户新增 style 的运行期视图:每次启动回放同步真身。
  syncAddedStyles(skillDir, stylesRoot)
  const settingsPath = settingsFile()
  const seed: ImageSettings = {
    imageBackend: config.imageBackend ?? '',
    imageApiKey: config.imageApiKey ?? '',
    imageBaseUrl: config.imageBaseUrl ?? '',
    imageModel: config.imageModel ?? '',
  }
  const readCurrent = (): ImageSettings => existsSync(settingsPath) ? readSettings(settingsPath) : seed
  applyDotEnv(skillDir, readCurrent())

  ctx.effect(() => ctx.skills.registerProvider(() => createPptSkillProvider(skillDir)), 'ppt-core: skill provider')
  ctx.effect(() => ctx.systemPrompt.section({ name: PROMPT_SECTION_NAME, text: promptSectionText(skillDir, builtinRoot, stylesRoot), order: 700 }), 'ppt-core: prompt section')
  ctx.effect(() => registerPptRoutes(ctx, {
    builtinRoot,
    stylesRoot,
    uploadsDir,
    skillDir,
    readSettings: readCurrent,
    writeSettings: (settings) => {
      writeSettings(settingsPath, settings)
      applyDotEnv(skillDir, settings)
    },
    commandRunner: nodeCommandRunner(),
  }), 'ppt-core: /api/ppt routes')
}

export { buildExtractionPrompt } from './extraction.ts'
