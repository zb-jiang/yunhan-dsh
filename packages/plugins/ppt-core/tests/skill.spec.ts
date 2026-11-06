import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyDotEnv, createPptSkillProvider, ensureSkillCopy, packageSkillDir, parseFrontmatter, PPT_SKILL_NAME, skillAddendum, skillStamp, targetSkillDir } from '../src/skill.ts'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'

/** 造一个最小 skill 资产目录:assets/skills/ppt-master/SKILL.md + assets/skills/manifest.json。 */
function makeSkillAsset(root: string, description = 'upstream description'): { assetsRoot: string; skillDir: string } {
  const assetsRoot = join(root, 'assets', 'skills')
  const skillDir = join(assetsRoot, PPT_SKILL_NAME)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${PPT_SKILL_NAME}\ndescription: ${description}\n---\n\n# ppt-master\n\n上游正文。\n`, 'utf8')
  writeFileSync(join(assetsRoot, 'manifest.json'), JSON.stringify({ skills: [{ commit: 'cafe1234' }] }), 'utf8')
  return { assetsRoot, skillDir }
}

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-skill-'))
  roots.push(dir)
  return dir
}

describe('packageSkillDir / targetSkillDir', () => {
  it('包 skill 目录在 lib 上一级的 assets/skills 下', () => {
    expect(packageSkillDir('/pkg/lib')).toBe(join('/pkg', 'assets', 'skills', PPT_SKILL_NAME))
  })

  it('运行期副本在 dshHome 的 ppt/skills 下', () => {
    expect(targetSkillDir('/home')).toBe(join('/home', 'ppt', 'skills', PPT_SKILL_NAME))
  })
})

describe('skillStamp', () => {
  it('读 manifest 里唯一的 commit', () => {
    const { assetsRoot } = makeSkillAsset(scratch())
    expect(skillStamp(join(assetsRoot, PPT_SKILL_NAME))).toBe('cafe1234')
  })

  it('manifest 缺失退化 unknown', () => {
    const root = scratch()
    const packageDir = join(root, 'lib')
    mkdirSync(join(packageDir, '..', 'assets', 'skills', PPT_SKILL_NAME), { recursive: true })
    expect(skillStamp(join(packageDir, '..', 'assets', 'skills', PPT_SKILL_NAME))).toBe('unknown')
  })
})

describe('ensureSkillCopy', () => {
  it('首次拷贝写版本戳', () => {
    const root = scratch()
    const { skillDir: source } = makeSkillAsset(root)
    const target = join(root, 'target')
    expect(ensureSkillCopy(source, target)).toBe('copied')
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('上游正文')
    expect(readFileSync(join(target, '.ppt-plugin-stamp'), 'utf8')).toBe('cafe1234\n')
  })

  it('戳一致时跳过重拷', () => {
    const root = scratch()
    const { skillDir: source } = makeSkillAsset(root)
    const target = join(root, 'target')
    ensureSkillCopy(source, target)
    writeFileSync(join(target, 'SKILL.md'), 'local drift', 'utf8')
    expect(ensureSkillCopy(source, target)).toBe('current')
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('local drift')
  })

  it('版本变化时整体重拷覆盖本地漂移', () => {
    const root = scratch()
    const { skillDir: source, assetsRoot } = makeSkillAsset(root)
    const target = join(root, 'target')
    ensureSkillCopy(source, target)
    writeFileSync(join(assetsRoot, 'manifest.json'), JSON.stringify({ skills: [{ commit: 'dead5678' }] }), 'utf8')
    expect(ensureSkillCopy(source, target)).toBe('copied')
    expect(readFileSync(join(target, '.ppt-plugin-stamp'), 'utf8')).toBe('dead5678\n')
  })
})

describe('applyDotEnv', () => {
  it('已配置时写 .env', () => {
    const target = scratch()
    applyDotEnv(target, { imageBackend: 'openai', imageApiKey: 'k', imageBaseUrl: '', imageModel: 'gpt' })
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('IMAGE_BACKEND=openai\nOPENAI_API_KEY=k\nOPENAI_MODEL=gpt\n')
  })

  it('未配置时删除遗留 .env', () => {
    const target = scratch()
    writeFileSync(join(target, '.env'), 'IMAGE_BACKEND=openai\n', 'utf8')
    applyDotEnv(target, { imageBackend: '', imageApiKey: '', imageBaseUrl: '', imageModel: '' })
    expect(() => readFileSync(join(target, '.env'), 'utf8')).toThrow()
  })
})

describe('parseFrontmatter', () => {
  it('解析单行 name/description 与正文', () => {
    const parsed = parseFrontmatter('---\nname: demo\ndescription: 描述\n---\n\n正文开始\n')
    expect(parsed).toEqual({ name: 'demo', description: '描述', body: '\n正文开始\n' })
  })

  it('归一化 CRLF 行尾(Windows 检出)', () => {
    const parsed = parseFrontmatter('---\r\nname: demo\r\ndescription: "quoted"\r\n---\r\n\r\nbody\r\n')
    expect(parsed).toEqual({ name: 'demo', description: 'quoted', body: '\nbody\n' })
  })

  it('支持折叠块标量(description: >)', () => {
    const raw = '---\nname: ppt-master\ndescription: >\n  第一行说明。\n  第二行说明。\n---\n\n# 标题\n'
    expect(parseFrontmatter(raw)).toEqual({ name: 'ppt-master', description: '第一行说明。 第二行说明。', body: '\n# 标题\n' })
  })

  it('缺字段回 undefined', () => {
    expect(parseFrontmatter('---\nname: only-name\n---\n')).toBeUndefined()
  })

  it('无 frontmatter 回 undefined', () => {
    expect(parseFrontmatter('# 纯正文')).toBeUndefined()
  })
})

describe('skillAddendum', () => {
  it('补充插件环境说明且不泄露 .env 的存在给模型用户', () => {
    const text = skillAddendum('/home/ppt/skills/ppt-master')
    expect(text).toContain('/home/ppt/skills/ppt-master')
    expect(text).toContain('不要新建或修改 `.env`')
  })
})

describe('createPptSkillProvider', () => {
  const options = { scope: undefined } as never

  it('list 返回单一候选', async () => {
    const root = scratch()
    const { skillDir: source } = makeSkillAsset(root)
    const target = join(root, 'target')
    ensureSkillCopy(source, target)
    const provider = createPptSkillProvider(target)
    expect(provider.name).toBe('ppt-core')
    const candidates = await provider.list(options) as SkillCandidate[]
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ name: PPT_SKILL_NAME, source: 'bundled', provider: 'ppt-core', rank: 600 })
    expect(candidates[0]?.resourceBase).toEqual({ kind: 'directory', path: target })
  })

  it('get 返回去掉 rank/locator 的摘要 + 正文与补充', async () => {
    const root = scratch()
    const { skillDir: source } = makeSkillAsset(root, 'folded desc')
    const target = join(root, 'target')
    ensureSkillCopy(source, target)
    const provider = createPptSkillProvider(target)
    const candidates = await provider.list(options) as SkillCandidate[]
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('expected ppt-master candidate')
    const skill = await provider.get(candidate, options)
    expect(skill).toMatchObject({ name: PPT_SKILL_NAME, description: 'folded desc', source: 'bundled' })
    expect(skill?.content).toContain('上游正文')
    expect(skill?.content).toContain('在 DSH PPT 插件里使用')
  })

  it('副本缺失 SKILL.md 时 list 为空、get 为 undefined', async () => {
    const provider = createPptSkillProvider(join(scratch(), 'absent'))
    const listed = await provider.list(options)
    expect(Array.isArray(listed) ? listed : []).toEqual([])
    const candidate = { name: PPT_SKILL_NAME } as Parameters<typeof provider.get>[0]
    await expect(provider.get(candidate, options)).resolves.toBeUndefined()
  })
})
