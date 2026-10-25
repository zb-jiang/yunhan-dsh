import { describe, expect, it } from 'vitest'
import { kbDocRule } from '../src/client/kb-doc-decorator.tsx'

/** A well-formed wire text with a server-shaped UUID docid. */
const WIRE_A = '知识库文档 docid: 12345678-1234-1234-1234-123456789abc'
const WIRE_B = '知识库文档 docid: 87654321-4321-4321-4321-cba987654321'

describe('kbDocRule', () => {
  it('claims the nearest wire candidate at or after from', () => {
    const text = `前缀 ${WIRE_A} 中缀 ${WIRE_B}`
    const first = kbDocRule.match(text, 0, {} as Parameters<typeof kbDocRule.match>[2])
    expect(first?.id).toBe('kb-doc')
    expect(first?.start).toBe('前缀 '.length)
    expect(first?.end).toBe('前缀 '.length + WIRE_A.length)
    expect(first && first.id === 'kb-doc' ? first.data.docId : undefined).toBe('12345678-1234-1234-1234-123456789abc')

    const second = kbDocRule.match(text, first?.end ?? 0, {} as Parameters<typeof kbDocRule.match>[2])
    expect(second && second.id === 'kb-doc' ? second.data.docId : undefined).toBe('87654321-4321-4321-4321-cba987654321')
  })

  it('returns undefined when no candidate exists at or after from', () => {
    const text = `仅一条 ${WIRE_A}`
    const after = kbDocRule.match(text, text.length, {} as Parameters<typeof kbDocRule.match>[2])
    expect(after).toBeUndefined()
    expect(kbDocRule.match('没有候选的普通文本', 0, {} as Parameters<typeof kbDocRule.match>[2])).toBeUndefined()
  })

  it('does not claim hand-typed lookalikes outside the UUID shape', () => {
    const text = '知识库文档 docid: not-a-uuid 以及知识库文档 docid: 12345678-1234-1234-1234-123456789ab'
    expect(kbDocRule.match(text, 0, {} as Parameters<typeof kbDocRule.match>[2])).toBeUndefined()
  })

  it('keeps a stable id and finite order', () => {
    expect(kbDocRule.id).toBe('kb-doc')
    expect(Number.isFinite(kbDocRule.order)).toBe(true)
  })
})
