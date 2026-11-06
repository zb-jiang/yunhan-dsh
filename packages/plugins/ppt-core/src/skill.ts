/**
 * ppt-master skill 集成(设计 2026-11-04 §5.3,注册模式参照
 * dsh-guizang-design 的 SkillProvider 实现)。
 *
 * 与 guizang 的差异:本插件要写 `.env`(生图配置注入),包安装目录
 * (pnpm 硬链接)不应运行时改写,因此启动时把 vendored 资产复制到
 * `$DSH_HOME/ppt/skills/ppt-master/`,provider 与 `.env` 都落在副本上;
 * 版本戳(manifest commit)变化时整体重拷。SKILL.md 修正只在
 * `get()` 返回的内存文本上做,磁盘原件保持上游原样——ppt-master 的
 * `attribution_guard.py` 校验 frontmatter 与 LICENSE 哈希,改盘会炸。
 *
 * 同名让位:本 provider 用 `BUNDLED_SKILL_RANK`(600);员工在
 * `~/.dsh/skills`(400)或项目 `.dsh/skills`(100/200)自装同名
 * skill 时 rank 更小自动胜出,无需额外过滤。
 *
 * @module
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillDefinition, type SkillLookupOptions, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { renderDotEnv, type ImageSettings } from './settings.ts'

/** 随包分发的 skill 名(上游 frontmatter 的 name 字段)。 */
export const PPT_SKILL_NAME = 'ppt-master'

/**
 * 包内 vendored skill 目录(`packageRoot` 为 lib 产物根,assets 在其上一级)。
 * @param packageRoot - 插件 lib 产物根目录。
 * @returns 包内 `assets/skills/ppt-master` 的绝对路径。
 */
export function packageSkillDir(packageRoot: string): string {
  return join(packageRoot, '..', 'assets', 'skills', PPT_SKILL_NAME)
}

/**
 * 运行期 skill 副本目录。
 * @param dshHome - DSH 主目录,仅测试注入;缺省走 `dshHomePath`。
 * @returns `$DSH_HOME/ppt/skills/ppt-master` 的绝对路径。
 */
export function targetSkillDir(dshHome?: string): string {
  return dshHome === undefined
    ? dshHomePath('ppt', 'skills', PPT_SKILL_NAME)
    : join(dshHome, 'ppt', 'skills', PPT_SKILL_NAME)
}

/**
 * 包资产版本戳:manifest 记录的上游 commit;manifest 缺失退化为 `'unknown'`(触发一次性重拷)。
 * @param packageDir - 包内 vendored skill 目录({@link packageSkillDir} 的返回值)。
 * @returns 上游 commit 字符串;manifest 缺失/损坏时为 `'unknown'`。
 */
export function skillStamp(packageDir: string): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(packageDir, '..', 'manifest.json'), 'utf8'))
    if (typeof manifest === 'object' && manifest !== null && Array.isArray((manifest as Record<string, unknown>)['skills'])) {
      const skill = (manifest as Record<string, unknown>)['skills'] as Record<string, unknown>[]
      const commit = skill.length === 1 ? skill[0]?.['commit'] : undefined
      if (typeof commit === 'string') return commit
    }
  } catch {
    // manifest 缺失/损坏时退化为 unknown,触发一次性重拷,不阻塞启动。
  }
  return 'unknown'
}

const STAMP_FILE = '.ppt-plugin-stamp'

/**
 * 确保运行期副本与包资产一致:戳不同或缺失时整体重拷。
 * @param packageDir - 包内 vendored skill 目录(版本戳来源)。
 * @param targetDir - 运行期副本目录(重拷目标)。
 * @returns `'copied'` 实际发生了拷贝,`'current'` 副本已最新。
 */
export function ensureSkillCopy(packageDir: string, targetDir: string): 'copied' | 'current' {
  const stamp = skillStamp(packageDir)
  try {
    if (readFileSync(join(targetDir, STAMP_FILE), 'utf8') === `${stamp}\n`) return 'current'
  } catch {
    // 无戳(首次安装或旧版残留)→ 重拷。
  }
  rmSync(targetDir, { recursive: true, force: true })
  cpSync(packageDir, targetDir, { recursive: true })
  writeFileSync(join(targetDir, STAMP_FILE), `${stamp}\n`, 'utf8')
  return 'copied'
}

/**
 * 把员工设置渲染成副本 `.env`;未配置时删除遗留 `.env`(走无图降级)。
 * @param targetDir - 运行期 skill 副本目录。
 * @param settings - 员工设置的归一化配置。
 */
export function applyDotEnv(targetDir: string, settings: ImageSettings): void {
  const content = renderDotEnv(settings)
  const envFile = join(targetDir, '.env')
  if (content === '') {
    rmSync(envFile, { force: true })
    return
  }
  writeFileSync(envFile, content, 'utf8')
}

/** SKILL.md 解析结果:name/description 与正文起点。 */
export interface ParsedSkillMd {
  name: string
  description: string
  /** 正文(frontmatter 结束后的全部文本)。 */
  body: string
}

/**
 * 提取 SKILL.md frontmatter 的 name/description;不完整返回 undefined。
 * @param raw - SKILL.md 全文(CRLF 自动归一化)。
 * @returns 解析结果;frontmatter 缺失或 name/description 缺一时为 undefined。
 */
export function parseFrontmatter(raw: string): ParsedSkillMd | undefined {
  // Windows 检出(git autocrlf)与 npm 打包都可能带入 CRLF,统一归一化再解析。
  const text = raw.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (match === null) return undefined
  const lines = match[1]?.split('\n') ?? []
  const field = (key: string): string | undefined => {
    const start = lines.findIndex(line => line.startsWith(`${key}:`))
    const startLine = start === -1 ? undefined : lines[start]
    if (startLine === undefined) return undefined
    const inline = startLine.slice(key.length + 1).trim()
    if (inline !== '' && inline !== '>' && inline !== '>-' && inline !== '|' && inline !== '|-') {
      return inline.replace(/^(["'])(.*)\1$/, '$2')
    }
    // YAML 块标量(`description: >` 折叠样式):收集缩进续行,折叠为单行。
    const parts: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '' || !/^\s/.test(line)) break
      parts.push(line.trim())
    }
    const folded = parts.join(' ')
    return folded === '' ? undefined : folded
  }
  const name = field('name')
  const description = field('description')
  if (name === undefined || description === undefined) return undefined
  return { name, description, body: text.slice(match[0].length) }
}

/**
 * `get()` 时的正文补充:插件环境的依赖与生图配置说明,替代上游写给
 * 手工 clone 用户的 `.env` 配置指引。
 *
 * @param skillDir - ppt-master 运行期副本目录(补充文本引用其路径)。
 * @returns 追加在正文之后的说明文本。
 */
export function skillAddendum(skillDir: string): string {
  return [
    '',
    '---',
    '',
    '## 在 DSH PPT 插件里使用',
    '',
    `- 本 skill 的目录是 \`${skillDir}\`,上文的 \`scripts/\`、\`references/\`、\`templates/\` 都相对这个目录。`,
    '- Python 依赖由宿主插件检测并在引导页安装,不需要在此目录手工运行 pip install。',
    '- 生图配置(API Key、模型)由插件写入本目录的 `.env`,脚本直接读取即可;不要新建或修改 `.env`,也不要向用户提起这个文件。',
    '- 用户未配置生图后端时,按上游说明走 image_search.py 网络图搜或无图降级。',
  ].join('\n')
}

/** registry 合并所需的候选元数据。 */
function toCandidate(skillDir: string, parsed: ParsedSkillMd): SkillCandidate {
  return {
    name: parsed.name,
    description: parsed.description,
    path: join(skillDir, 'SKILL.md'),
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'ppt-core',
    rank: BUNDLED_SKILL_RANK,
    locator: skillDir,
    resourceBase: { kind: 'directory', path: skillDir },
  }
}

/**
 * 创建 ppt-master 的 SkillProvider,注册进 `ctx.skills`。
 * @param skillDir - ppt-master 运行期副本目录。
 * @returns provider;SKILL.md 缺失/不可解析时 `list()` 返回空、`get()` 返回 undefined。
 */
export function createPptSkillProvider(skillDir: string): SkillProvider {
  const readSkill = (): ParsedSkillMd | undefined => {
    const skillFile = join(skillDir, 'SKILL.md')
    if (!existsSync(skillFile)) return undefined
    return parseFrontmatter(readFileSync(skillFile, 'utf8'))
  }
  return {
    name: 'ppt-core',
    list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
      const parsed = readSkill()
      if (parsed === undefined || parsed.name !== PPT_SKILL_NAME) return Promise.resolve([])
      return Promise.resolve([toCandidate(skillDir, parsed)])
    },
    get(_candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      const parsed = readSkill()
      if (parsed === undefined) return Promise.resolve(undefined)
      const { rank: _rank, locator: _locator, ...summary } = toCandidate(skillDir, parsed)
      return Promise.resolve({ ...summary, content: `${parsed.body}${skillAddendum(skillDir)}` })
    },
  }
}
