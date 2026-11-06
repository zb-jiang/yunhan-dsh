import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseStyleFrontmatter, removeFromSkillTree, StyleSpecError, syncAddedStyles } from '../src/stylesSync.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-styles-'))
  roots.push(dir)
  return dir
}

const VALID_SPEC = '---\nstyle_id: distilled\nkind: style\nsummary: 一句话定位\nkeywords: [a, b, c]\n---\n正文'

describe('parseStyleFrontmatter', () => {
  it('解析三字段', () => {
    expect(parseStyleFrontmatter(VALID_SPEC)).toEqual({ styleId: 'distilled', summary: '一句话定位', keywords: ['a', 'b', 'c'] })
  })

  it('缺 frontmatter / 缺字段 / kind 不对 / keywords 越界都抛 StyleSpecError', () => {
    expect(() => parseStyleFrontmatter('无 frontmatter')).toThrow(StyleSpecError)
    expect(() => parseStyleFrontmatter('---\nkind: style\nsummary: s\nkeywords: [a, b, c]\n---\n')).toThrow(StyleSpecError)
    expect(() => parseStyleFrontmatter('---\nstyle_id: x\nsummary: s\nkeywords: [a, b, c]\n---\n')).toThrow(StyleSpecError)
    expect(() => parseStyleFrontmatter('---\nstyle_id: x\nkind: brand\nsummary: s\nkeywords: [a, b, c]\n---\n')).toThrow(StyleSpecError)
    expect(() => parseStyleFrontmatter('---\nstyle_id: x\nkind: style\nkeywords: [a, b, c]\n---\n')).toThrow(StyleSpecError)
    expect(() => parseStyleFrontmatter('---\nstyle_id: x\nkind: style\nsummary: s\nkeywords: [a, b]\n---\n')).toThrow(StyleSpecError)
    expect(() => parseStyleFrontmatter('---\nstyle_id: x\nkind: style\nsummary: s\nkeywords: [a, b, c, d, e, f]\n---\n')).toThrow(StyleSpecError)
  })

  it('空关键词项被剔除后不足 3 个抛错', () => {
    expect(() => parseStyleFrontmatter('---\nstyle_id: x\nkind: style\nsummary: s\nkeywords: [a, , b]\n---\n')).toThrow(StyleSpecError)
  })
})

describe('syncAddedStyles', () => {
  it('真身 design_spec.md 同步进 skill 树并合并 index', () => {
    const root = scratch()
    const stylesRoot = join(root, 'styles')
    const skillDir = join(root, 'skill')
    mkdirSync(join(stylesRoot, 'distilled'), { recursive: true })
    writeFileSync(join(stylesRoot, 'distilled', 'design_spec.md'), VALID_SPEC, 'utf8')
    mkdirSync(join(skillDir, 'templates', 'styles'), { recursive: true })
    writeFileSync(join(skillDir, 'templates', 'styles', 'styles_index.json'), JSON.stringify({ corp: { summary: '出厂', keywords: ['x', 'y', 'z'] } }), 'utf8')
    syncAddedStyles(skillDir, stylesRoot)
    expect(readFileSync(join(skillDir, 'templates', 'styles', 'distilled', 'templates', 'design_spec.md'), 'utf8')).toBe(VALID_SPEC)
    expect(JSON.parse(readFileSync(join(skillDir, 'templates', 'styles', 'styles_index.json'), 'utf8'))).toEqual({
      corp: { summary: '出厂', keywords: ['x', 'y', 'z'] },
      distilled: { summary: '一句话定位', keywords: ['a', 'b', 'c'] },
    })
  })

  it('回放是幂等的:已有 index 条目不覆盖', () => {
    const root = scratch()
    const stylesRoot = join(root, 'styles')
    const skillDir = join(root, 'skill')
    mkdirSync(join(stylesRoot, 'distilled'), { recursive: true })
    writeFileSync(join(stylesRoot, 'distilled', 'design_spec.md'), VALID_SPEC, 'utf8')
    mkdirSync(join(skillDir, 'templates', 'styles', 'distilled', 'templates'), { recursive: true })
    writeFileSync(join(skillDir, 'templates', 'styles', 'distilled', 'templates', 'design_spec.md'), '旧内容', 'utf8')
    syncAddedStyles(skillDir, stylesRoot)
    // spec 文件随真身刷新,index 条目保持首次登记值。
    expect(readFileSync(join(skillDir, 'templates', 'styles', 'distilled', 'templates', 'design_spec.md'), 'utf8')).toBe(VALID_SPEC)
  })

  it('坏 spec 跳过不阻塞回放', () => {
    const root = scratch()
    const stylesRoot = join(root, 'styles')
    const skillDir = join(root, 'skill')
    mkdirSync(join(stylesRoot, 'broken'), { recursive: true })
    writeFileSync(join(stylesRoot, 'broken', 'design_spec.md'), '缺 frontmatter', 'utf8')
    mkdirSync(join(stylesRoot, 'good'), { recursive: true })
    writeFileSync(join(stylesRoot, 'good', 'design_spec.md'), VALID_SPEC, 'utf8')
    syncAddedStyles(skillDir, stylesRoot)
    expect(existsSync(join(skillDir, 'templates', 'styles', 'good'))).toBe(true)
    expect(existsSync(join(skillDir, 'templates', 'styles', 'broken'))).toBe(false)
  })

  it('根目录缺失与无 index 时不抛错', () => {
    const root = scratch()
    expect(() => { syncAddedStyles(join(root, 'skill'), join(root, 'nope')) }).not.toThrow()
    expect(() => { syncAddedStyles(join(root, 'skill'), join(root, 'empty')) }).not.toThrow()
  })
})

describe('removeFromSkillTree', () => {
  it('删副本目录与 index 条目;不存在时无副作用', () => {
    const root = scratch()
    const skillDir = join(root, 'skill')
    const stylesDir = join(skillDir, 'templates', 'styles')
    mkdirSync(join(stylesDir, 'distilled', 'templates'), { recursive: true })
    writeFileSync(join(stylesDir, 'distilled', 'templates', 'design_spec.md'), 'copy', 'utf8')
    writeFileSync(join(stylesDir, 'styles_index.json'), JSON.stringify({ distilled: { summary: 's', keywords: ['a', 'b', 'c'] } }), 'utf8')
    removeFromSkillTree(skillDir, 'distilled')
    expect(existsSync(join(stylesDir, 'distilled'))).toBe(false)
    expect(JSON.parse(readFileSync(join(stylesDir, 'styles_index.json'), 'utf8'))).toEqual({})
    expect(() => { removeFromSkillTree(skillDir, 'ghost') }).not.toThrow()
  })
})
