import { describe, expect, it } from 'vitest'
import { applyChipPrefix, composeChipDraft, stripChipPrefix } from '../src/client/prefix.ts'

describe('stripChipPrefix', () => {
  it('剥离开头的前缀与其后的换行', () => {
    expect(stripChipPrefix('P', 'P\n正文')).toBe('正文')
  })

  it('剥离后草稿为空时返回空串', () => {
    expect(stripChipPrefix('P', 'P')).toBe('')
  })

  it('前缀不在开头(用户已改动)时返回 undefined', () => {
    expect(stripChipPrefix('P', '改动 P\n正文')).toBeUndefined()
  })

  it('空前缀原样返回草稿', () => {
    expect(stripChipPrefix('', '正文')).toBe('正文')
  })
})

describe('composeChipDraft', () => {
  it('剩余草稿为空时前缀即全文', () => {
    expect(composeChipDraft('P', '')).toBe('P')
  })

  it('前缀独占首行', () => {
    expect(composeChipDraft('P', '正文')).toBe('P\n正文')
  })
})

describe('applyChipPrefix', () => {
  it('首次选中:前缀拼接进空草稿', () => {
    expect(applyChipPrefix('', null, 'P')).toEqual({ draft: 'P', applied: true })
  })

  it('首次选中:前缀独占首行拼接进已有草稿', () => {
    expect(applyChipPrefix('已有内容', null, 'P')).toEqual({ draft: 'P\n已有内容', applied: true })
  })

  it('换选:剥掉旧前缀后拼新前缀', () => {
    expect(applyChipPrefix('A\n正文', 'A', 'B')).toEqual({ draft: 'B\n正文', applied: true })
  })

  it('旧前缀已被用户改动时不写草稿,只换状态', () => {
    expect(applyChipPrefix('改过的 A\n正文', 'A', 'B')).toEqual({ draft: '改过的 A\n正文', applied: false })
  })

  it('移除后再选(lastPrefix=null):旧前缀残留时按普通草稿拼接', () => {
    expect(applyChipPrefix('A\n正文', null, 'B')).toEqual({ draft: 'B\nA\n正文', applied: true })
  })
})
