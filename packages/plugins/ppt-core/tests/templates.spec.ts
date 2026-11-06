import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteTemplate, importTemplate, installStaged, listTemplates, MAX_CUSTOM_TEMPLATES, parseTemplateMeta, resolveTemplateDir, SLUG_PATTERN, TEMPLATE_CATEGORIES, type TemplateImport } from '../src/templates.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (mocks.failRename) throw Object.assign(new Error('cross-volume rename'), { code: 'EXDEV' })
      actual.renameSync(from, to)
    },
  }
})

const mocks = vi.hoisted(() => ({ failRename: false }))

const roots: string[] = []
afterEach(() => {
  mocks.failRename = false
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-templates-'))
  roots.push(dir)
  return dir
}

/** 在 root 下造一套合法模板。 */
function makeTemplate(root: string, dirName: string, options?: { category?: string; previews?: string[]; specFile?: 'spec.md' | 'design_spec.md' | 'none'; withDescription?: boolean }): string {
  const dir = join(root, dirName)
  mkdirSync(join(dir, 'preview'), { recursive: true })
  writeFileSync(join(dir, 'template.json'), JSON.stringify({
    name: dirName,
    category: options?.category ?? 'business',
    ...(options?.withDescription === true ? { description: '说明' } : {}),
  }), 'utf8')
  if (options?.specFile !== 'none') writeFileSync(join(dir, options?.specFile ?? 'spec.md'), 'spec body', 'utf8')
  for (const file of options?.previews ?? ['page-01.jpg', 'page-02.jpg']) writeFileSync(join(dir, 'preview', file), 'jpg', 'utf8')
  return dir
}

const validImport: TemplateImport = {
  slug: 'distilled',
  meta: { name: '提炼模板', category: 'business', description: '来自参考 PPT' },
  designSpec: '---\nstyle_id: distilled\nkind: style\nsummary: 一句话\nkeywords: [a, b, c]\n---\n正文',
  previews: [{ name: 'page-01.jpg', data: Buffer.from('jpg1').toString('base64') }],
}

describe('TEMPLATE_CATEGORIES', () => {
  it('固定六类清单', () => {
    expect(TEMPLATE_CATEGORIES).toEqual(['business', 'marketing', 'consulting', 'academic', 'work', 'personal'])
  })
})

describe('SLUG_PATTERN', () => {
  it('字母开头 3–64 位小写/数字/中划线', () => {
    expect(SLUG_PATTERN.test('abc')).toBe(true)
    expect(SLUG_PATTERN.test('a1-b2-c3')).toBe(true)
    expect(SLUG_PATTERN.test('ab')).toBe(false)
    expect(SLUG_PATTERN.test('1abc')).toBe(false)
    expect(SLUG_PATTERN.test('Abc')).toBe(false)
    expect(SLUG_PATTERN.test('a/b')).toBe(false)
    expect(SLUG_PATTERN.test('.hidden')).toBe(false)
    expect(SLUG_PATTERN.test(`a${'b'.repeat(63)}`)).toBe(true)
    expect(SLUG_PATTERN.test(`a${'b'.repeat(64)}`)).toBe(false)
  })
})

describe('parseTemplateMeta', () => {
  it('合法模板回完整元数据与页数', () => {
    const root = scratch()
    const dir = makeTemplate(root, 'sample', { withDescription: true })
    expect(parseTemplateMeta(dir, 'sample', 'factory')).toEqual({
      id: 'sample', name: 'sample', category: 'business', origin: 'factory', pageCount: 2, description: '说明',
    })
  })

  it('design_spec.md 也被接受为规格文档', () => {
    const root = scratch()
    const dir = makeTemplate(root, 'style-one', { specFile: 'design_spec.md' })
    expect(parseTemplateMeta(dir, 'style-one', 'added')?.pageCount).toBe(2)
  })

  it('template.json 缺失/损坏回 undefined', () => {
    const root = scratch()
    mkdirSync(join(root, 'a'), { recursive: true })
    expect(parseTemplateMeta(join(root, 'a'), 'a', 'added')).toBeUndefined()
    const dir = makeTemplate(root, 'b')
    writeFileSync(join(dir, 'template.json'), '{bad', 'utf8')
    expect(parseTemplateMeta(dir, 'b', 'added')).toBeUndefined()
  })

  it('规格文档缺失回 undefined', () => {
    const root = scratch()
    const dir = makeTemplate(root, 'nospec', { specFile: 'none' })
    expect(parseTemplateMeta(dir, 'nospec', 'added')).toBeUndefined()
  })

  it('分类不在固定清单回 undefined', () => {
    const root = scratch()
    const dir = makeTemplate(root, 'badcat', { category: 'other' })
    expect(parseTemplateMeta(dir, 'badcat', 'added')).toBeUndefined()
  })

  it('无 preview 目录页数为 0 仍可列出', () => {
    const root = scratch()
    const dir = makeTemplate(root, 'noprev', { previews: [] })
    rmSync(join(dir, 'preview'), { recursive: true, force: true })
    expect(parseTemplateMeta(dir, 'noprev', 'added')?.pageCount).toBe(0)
  })
})

describe('listTemplates', () => {
  it('出厂在前、新增在后,坏模板跳过', () => {
    const root = scratch()
    const builtinRoot = join(root, 'builtin')
    const stylesRoot = join(root, 'styles')
    mkdirSync(builtinRoot, { recursive: true })
    mkdirSync(stylesRoot, { recursive: true })
    makeTemplate(builtinRoot, 'corp')
    makeTemplate(stylesRoot, 'mine', { specFile: 'design_spec.md' })
    makeTemplate(stylesRoot, 'broken', { category: 'nope', specFile: 'design_spec.md' })
    const list = listTemplates(builtinRoot, stylesRoot)
    expect(list.map(template => template.id)).toEqual(['corp', 'mine'])
    expect(list.map(template => template.origin)).toEqual(['factory', 'added'])
  })

  it('目录缺失按空处理', () => {
    expect(listTemplates(join(scratch(), 'nope'), join(scratch(), 'nope2'))).toEqual([])
  })
})

describe('resolveTemplateDir', () => {
  it('出厂目录存在时路由到出厂根', () => {
    const root = scratch()
    const builtinRoot = join(root, 'builtin')
    const stylesRoot = join(root, 'styles')
    makeTemplate(builtinRoot, 'corp')
    expect(resolveTemplateDir(builtinRoot, stylesRoot, 'corp')).toBe(join(builtinRoot, 'corp'))
  })

  it('出厂不存在时按新增根解析(存在性由调用方判定)', () => {
    const root = scratch()
    const builtinRoot = join(root, 'builtin')
    const stylesRoot = join(root, 'styles')
    makeTemplate(stylesRoot, 'mine', { specFile: 'design_spec.md' })
    expect(resolveTemplateDir(builtinRoot, stylesRoot, 'mine')).toBe(join(stylesRoot, 'mine'))
    expect(existsSync(resolveTemplateDir(builtinRoot, stylesRoot, 'ghost') ?? '')).toBe(false)
  })

  it('非法 slug 回 undefined', () => {
    expect(resolveTemplateDir('r1', 'r2', 'ab')).toBeUndefined()
    expect(resolveTemplateDir('r1', 'r2', 'a/b')).toBeUndefined()
    expect(resolveTemplateDir('r1', 'r2', 'a\\b')).toBeUndefined()
    expect(resolveTemplateDir('r1', 'r2', '.hidden')).toBeUndefined()
  })
})

describe('deleteTemplate', () => {
  it('出厂模板拒删', () => {
    const root = scratch()
    const builtinRoot = join(root, 'builtin')
    makeTemplate(builtinRoot, 'corp')
    expect(deleteTemplate(builtinRoot, join(root, 'styles'), join(root, 'skill'), 'corp')).toBe('refused')
  })

  it('非法 slug 拒删', () => {
    expect(deleteTemplate(scratch(), scratch(), scratch(), '../escape')).toBe('refused')
  })

  it('不存在的真身目录回 missing', () => {
    expect(deleteTemplate(join(scratch(), 'builtin'), join(scratch(), 'styles'), scratch(), 'xyz')).toBe('missing')
  })

  it('删除真身并联动摘除 skill 树副本与 index 条目', () => {
    const root = scratch()
    const stylesRoot = join(root, 'styles')
    const skillDir = join(root, 'skill')
    makeTemplate(stylesRoot, 'mine', { specFile: 'design_spec.md' })
    mkdirSync(join(skillDir, 'templates', 'styles', 'mine', 'templates'), { recursive: true })
    writeFileSync(join(skillDir, 'templates', 'styles', 'mine', 'templates', 'design_spec.md'), 'copy', 'utf8')
    writeFileSync(join(skillDir, 'templates', 'styles', 'styles_index.json'), JSON.stringify({ corp: { summary: 's', keywords: ['a'] }, mine: { summary: 'm', keywords: ['b'] } }), 'utf8')
    expect(deleteTemplate(join(root, 'builtin'), stylesRoot, skillDir, 'mine')).toBe('deleted')
    expect(existsSync(join(stylesRoot, 'mine'))).toBe(false)
    expect(existsSync(join(skillDir, 'templates', 'styles', 'mine'))).toBe(false)
    expect(JSON.parse(readFileSync(join(skillDir, 'templates', 'styles', 'styles_index.json'), 'utf8'))).toEqual({ corp: { summary: 's', keywords: ['a'] } })
  })
})

describe('importTemplate', () => {
  it('载荷缺字段回 invalid-meta', () => {
    const root = scratch()
    expect(importTemplate(root, { ...validImport, slug: 'AB' })).toEqual({ kind: 'invalid-meta' })
    expect(importTemplate(root, { ...validImport, meta: { ...validImport.meta, name: ' ' } })).toEqual({ kind: 'invalid-meta' })
    expect(importTemplate(root, { ...validImport, designSpec: '' })).toEqual({ kind: 'invalid-meta' })
    expect(importTemplate(root, { ...validImport, previews: [] })).toEqual({ kind: 'invalid-meta' })
    expect(importTemplate(root, { ...validImport, meta: { ...validImport.meta, category: 'other' as never } })).toEqual({ kind: 'invalid-meta' })
  })

  it('新增满 10 套回 limit-reached', () => {
    const root = scratch()
    for (let i = 0; i < MAX_CUSTOM_TEMPLATES; i += 1) makeTemplate(root, `t${i}`, { specFile: 'design_spec.md' })
    expect(importTemplate(root, validImport)).toEqual({ kind: 'limit-reached' })
  })

  it('撞已有 slug 回 slug-conflict', () => {
    const root = scratch()
    makeTemplate(root, 'distilled', { specFile: 'design_spec.md' })
    expect(importTemplate(root, validImport)).toEqual({ kind: 'slug-conflict' })
  })

  it('导入成功:暂存目录消失,产物以 <slug> 落位', () => {
    const root = scratch()
    const outcome = importTemplate(root, validImport)
    expect(outcome).toEqual({ kind: 'imported', id: 'distilled' })
    expect(existsSync(join(root, 'distilled', 'design_spec.md'))).toBe(true)
    expect(readdirSync(root).filter(name => name.startsWith('.staging-'))).toEqual([])
  })

  it('rename 跨卷失败时回退 copy + 清理暂存', () => {
    const root = scratch()
    mocks.failRename = true
    const outcome = importTemplate(root, validImport)
    expect(outcome).toEqual({ kind: 'imported', id: 'distilled' })
    expect(existsSync(join(root, 'distilled', 'design_spec.md'))).toBe(true)
    expect(readdirSync(root).filter(name => name.startsWith('.staging-'))).toEqual([])
  })

  it('installStaged 直接安装含 example.pptx 与描述', () => {
    const root = scratch()
    const staged = join(root, '.staging-direct1')
    installStaged(root, staged, {
      ...validImport,
      slug: 'direct1',
      examplePptx: { name: 'example.pptx', data: Buffer.from('pptx').toString('base64') },
    })
    expect(existsSync(join(root, 'direct1', 'example.pptx'))).toBe(true)
    const written = JSON.parse(readFileSync(join(root, 'direct1', 'template.json'), 'utf8')) as { description?: string }
    expect(written.description).toBe('来自参考 PPT')
  })
})
