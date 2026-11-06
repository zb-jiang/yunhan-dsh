import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ppt-client host marker', () => {
  it('宿主半为空实现,可安全加载', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
