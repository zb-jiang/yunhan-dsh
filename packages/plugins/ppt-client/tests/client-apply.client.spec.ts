import { describe, expect, it } from 'vitest'
import { PptSettingsCard } from '../src/client/PptSettingsCard.tsx'
import { PptHeroToggle } from '../src/client/PptHeroToggle.tsx'
import { TemplateChip } from '../src/client/TemplateChip.tsx'
import { TemplateGallery } from '../src/client/TemplateGallery.tsx'
import { apply } from '../src/client/index.ts'

/** slots 服务桩:记录 inject 请求与全部 register 注册项。 */
function stubSlots() {
  const injected: string[] = []
  const registered: { name: string; id?: string; order?: number; component?: unknown }[] = []
  return {
    injected,
    registered,
    inject: (name: string, factory: () => void) => {
      injected.push(name)
      factory()
      return () => {}
    },
    register: (options: { name: string; id?: string; order?: number }, component: unknown) => {
      registered.push({ ...options, component })
      return () => {}
    },
  }
}

/** 按注册序取座位;缺失即抛出,收窄下标访问的 undefined 联合。 */
function rowOf(registered: { name: string; id?: string; order?: number; component?: unknown }[], index: number) {
  const row = registered[index]
  if (row === undefined) throw new Error(`expected registration at index ${index}`)
  return row
}

describe('ppt-client', () => {
  it('注册设置卡片、输入工具行画廊入口与 dock 的 chip/画廊座位', () => {
    const slots = stubSlots()
    const ctx = {
      slots,
      // effect 立即执行工厂并返回注销函数;locale 注册只记录不消费。
      effect: (factory: () => () => void) => factory(),
      locale: { register: () => () => {} },
    }
    apply(ctx as never)
    expect(slots.injected).toEqual([
      'settings.section',
      'conversation.input.left',
      'conversation.input.dock',
      'conversation.input.dock',
    ])
    expect(rowOf(slots.registered, 0)).toMatchObject({ name: 'settings.section', id: 'ppt-image-config', order: 40 })
    expect(rowOf(slots.registered, 0).component).toBe(PptSettingsCard)
    expect(rowOf(slots.registered, 1)).toMatchObject({ name: 'conversation.input.left', id: 'ppt-gallery-toggle', order: 10 })
    expect(rowOf(slots.registered, 1).component).toBe(PptHeroToggle)
    expect(rowOf(slots.registered, 2)).toMatchObject({ name: 'conversation.input.dock', id: 'ppt-chip', order: 5 })
    expect(rowOf(slots.registered, 2).component).toBe(TemplateChip)
    expect(rowOf(slots.registered, 3)).toMatchObject({ name: 'conversation.input.dock', id: 'ppt-gallery', order: 6 })
    expect(rowOf(slots.registered, 3).component).toBe(TemplateGallery)
  })
})
