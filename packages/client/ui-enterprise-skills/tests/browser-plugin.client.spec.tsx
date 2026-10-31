// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAllAccess, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS, PANEL_ID } from '../src/client/index.ts'
import { SkillsPanelIcon } from '../src/client/SkillsPanelIcon.tsx'
import { SkillsPanelPage } from '../src/client/SkillsPanelPage.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

/** 挂载 SlotRegistry 与 LocaleRuntime 的最小客户端上下文。 */
async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'localeHolder')
    }
  }
  new LocaleHolder(ctx)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/** 声明页面注册所需的根槽位。 */
function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-enterprise-skills browser plugin', () => {
  it('注册侧边栏入口与其主面板,locale 跟随语言切换', async () => {
    const b = await bench()
    const removeRoot = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('main')[0]!
    expect(entry.component).toBe(SkillsPanelPage)
    expect(entry.options).toMatchObject({ key: PANEL_ID })
    expect(entry.locale).toBe(NS)

    const icon = b.slots.entries('sidebar.panellist')[0]!
    expect(icon.component).toBe(SkillsPanelIcon)
    expect(icon.options).toMatchObject({ id: PANEL_ID, order: 5 })
    expect(icon.locale).toBe(NS)
    expect(resolveSlotLabel(icon.options.label)).toBe('技能库')
    const glyph = render(<SkillsPanelIcon size={18} active={false}
      usePanelInfo={() => { throw new Error('The sidebar icon must not read application state') }}
      useSessions={() => { throw new Error('The sidebar icon must not read application state') }}
      useSessionStatus={() => { throw new Error('The sidebar icon must not read application state') }}
      useSessionRetainInfo={() => { throw new Error('The sidebar icon must not read application state') }}
      useWorkspaces={() => { throw new Error('The sidebar icon must not read application state') }}
      useResource={() => { throw new Error('The sidebar icon must not read application state') }}
      {...allowAllAccess} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')

    b.locale.setLocale('en')
    expect(resolveSlotLabel(icon.options.label)).toBe('Skills')

    removeRoot()
    await b.ctx.fiber.dispose()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
  })

  it('只声明页面用到的服务,node 半区为空 apply', () => {
    expect(inject).toEqual(['slots', 'locale'])
    expect(() => { hostApply() }).not.toThrow()
  })
})
