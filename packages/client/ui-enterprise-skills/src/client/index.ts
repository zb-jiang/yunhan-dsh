/**
 * Enterprise skills panel, browser half: the **Skills** entry of the sidebar
 * and the governance page it opens in the main column. The page lists the
 * skill-sync catalog (process-required, locally uploaded, market skills) and
 * installs, imports (zip), and uninstalls through the local webserver's
 * governance endpoints, which enforce the employee JWT.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the root `main` keyed slot the page registers into, declared by
// ui-layout with the panel id brand, and the `sidebar.panellist` list the
// entry registers into, declared by ui-sidebar.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SkillsPanelPage } from './SkillsPanelPage.tsx'
import { SkillsPanelIcon } from './SkillsPanelIcon.tsx'
import { en, zh, type SkillsPanelLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Enterprise skill governance panel copy. */
    'enterpriseSkills': SkillsPanelLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'enterpriseSkills'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'enterprise-skills' as MainPanelId

/** Services required by the sidebar registration and the page. */
export const inject = ['slots', 'locale']

/**
 * Contribute the Skills entry to the sidebar with the governance page it
 * opens, right below the Plugins entry.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-enterprise-skills: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, SkillsPanelPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 5,
    label: () => t('panel'),
    locale: NS,
  }, SkillsPanelIcon))
}
