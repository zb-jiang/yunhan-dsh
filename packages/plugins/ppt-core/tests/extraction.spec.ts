import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildExtractionPrompt, importFromWorkspace } from '../src/extraction.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-extraction-'))
  roots.push(dir)
  return dir
}

const VALID_SPEC = '---\nstyle_id: distilled\nkind: style\nsummary: 一句话定位\nkeywords: [a, b, c]\n---\n正文'

/** 造一份合法的提炼产物(style 契约三件套,example.pptx 可选);返回工作空间根。 */
function makeTemplateOutput(
  workspace: string,
  options?: { withExample?: boolean; extraPreview?: string; spec?: string; slug?: string },
): string {
  const dir = join(workspace, 'ppt-template')
  mkdirSync(join(dir, 'preview'), { recursive: true })
  writeFileSync(join(dir, 'template.json'), JSON.stringify({ name: '提炼模板', category: 'business', description: '说明' }), 'utf8')
  writeFileSync(join(dir, 'design_spec.md'), options?.spec ?? VALID_SPEC, 'utf8')
  writeFileSync(join(dir, 'preview', 'page-01.jpg'), 'jpg1', 'utf8')
  if (options?.extraPreview !== undefined) {
    if (options.extraPreview === '<dir>') mkdirSync(join(dir, 'preview', 'sub'), { recursive: true })
    else writeFileSync(join(dir, 'preview', options.extraPreview), 'x', 'utf8')
  }
  if (options?.withExample === true) writeFileSync(join(dir, 'example.pptx'), 'pptx', 'utf8')
  return workspace
}

/** 装配一个最小宿主环境:出厂根 + 新增真身根 + skill 副本。 */
function makeHost(): { stylesRoot: string; builtinRoot: string; skillDir: string } {
  const root = scratch()
  const builtinRoot = join(root, 'builtin')
  const stylesRoot = join(root, 'styles')
  const skillDir = join(root, 'skill')
  mkdirSync(join(builtinRoot), { recursive: true })
  mkdirSync(join(skillDir, 'templates', 'styles'), { recursive: true })
  writeFileSync(join(skillDir, 'templates', 'styles', 'styles_index.json'), JSON.stringify({}), 'utf8')
  return { builtinRoot, stylesRoot, skillDir }
}

describe('buildExtractionPrompt', () => {
  it('指令指向 style 契约文档、上传路径、slug 与 ppt-template 产出', () => {
    const prompt = buildExtractionPrompt('/home/ppt/skills/ppt-master', '/ws/upload.pptx', { slug: 'distilled', name: '提炼模板', category: 'business' })
    expect(prompt).toContain('/home/ppt/skills/ppt-master/templates/styles/README.md')
    expect(prompt).toContain('/ws/upload.pptx')
    expect(prompt).toContain('ppt-template/')
    expect(prompt).toContain('style_id: distilled')
    expect(prompt).toContain('提炼模板')
    expect(prompt).toContain('design_spec.md')
  })
})

describe('importFromWorkspace', () => {
  it('完整产物登记成功并带上 example.pptx', () => {
    const host = makeHost()
    const workspace = makeTemplateOutput(scratch(), { withExample: true })
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, workspace)).toEqual({ kind: 'imported', id: 'distilled' })
    expect(readFileSync(join(host.skillDir, 'templates', 'styles', 'distilled', 'templates', 'design_spec.md'), 'utf8')).toBe(VALID_SPEC)
  })

  it('产物目录缺失回 invalid-meta', () => {
    const host = makeHost()
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, scratch())).toEqual({ kind: 'invalid-meta' })
  })

  it('template.json 不是对象/缺字段回 invalid-meta', () => {
    const host = makeHost()
    const ws1 = scratch()
    makeTemplateOutput(ws1)
    writeFileSync(join(ws1, 'ppt-template', 'template.json'), '[1]', 'utf8')
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, ws1)).toEqual({ kind: 'invalid-meta' })
    const ws2 = scratch()
    makeTemplateOutput(ws2)
    writeFileSync(join(ws2, 'ppt-template', 'template.json'), JSON.stringify({ category: 'business' }), 'utf8')
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, ws2)).toEqual({ kind: 'invalid-meta' })
  })

  it('frontmatter 违反 style 契约回 invalid-meta', () => {
    const host = makeHost()
    const ws = scratch()
    makeTemplateOutput(ws, { spec: '缺 frontmatter' })
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, ws)).toEqual({ kind: 'invalid-meta' })
  })

  it('slug 非法或与出厂撞名', () => {
    const host = makeHost()
    mkdirSync(join(host.builtinRoot, 'corp'), { recursive: true })
    const ws = scratch()
    makeTemplateOutput(ws, { spec: VALID_SPEC.replace('style_id: distilled', 'style_id: corp') })
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, ws)).toEqual({ kind: 'slug-conflict' })
  })

  it('design_spec.md 缺失回 invalid-meta', () => {
    const host = makeHost()
    const ws = scratch()
    makeTemplateOutput(ws)
    rmSync(join(ws, 'ppt-template', 'design_spec.md'))
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, ws)).toEqual({ kind: 'invalid-meta' })
  })

  it('preview 目录缺失回 invalid-meta', () => {
    const host = makeHost()
    const ws = scratch()
    makeTemplateOutput(ws)
    rmSync(join(ws, 'ppt-template', 'preview'), { recursive: true })
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, ws)).toEqual({ kind: 'invalid-meta' })
  })

  it('preview 里无关子目录被忽略;页图名被目录占用时读取失败回 invalid-meta', () => {
    const host = makeHost()
    const ws1 = makeTemplateOutput(scratch(), { extraPreview: '<dir>' })
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, ws1)).toEqual({ kind: 'imported', id: 'distilled' })
    const ws2 = makeTemplateOutput(scratch())
    mkdirSync(join(ws2, 'ppt-template', 'preview', 'page-02.jpg'), { recursive: true })
    expect(importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, ws2)).toEqual({ kind: 'invalid-meta' })
  })

  it('登记后 template.json 落盘与产物同构', () => {
    const host = makeHost()
    const workspace = makeTemplateOutput(scratch())
    const outcome = importFromWorkspace(host.stylesRoot, host.builtinRoot, host.skillDir, workspace)
    expect(outcome.kind).toBe('imported')
    if (outcome.kind !== 'imported') throw new Error('expected imported')
    expect(JSON.parse(readFileSync(join(host.stylesRoot, outcome.id, 'template.json'), 'utf8'))).toEqual({ name: '提炼模板', category: 'business', description: '说明' })
  })
})
