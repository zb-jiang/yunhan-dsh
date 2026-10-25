/**
 * Global-rules settings plugin, browser half. It registers the Global Rules
 * page that edits the user-global instruction file injected into every
 * session. The Host settings contract stays behind its existing wire API.
 * Export discipline: packages/client/AGENTS.md.
 */
import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconGlobeOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the global-rules remotes into
// this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { GlobalRulesSection, type GlobalRulesSectionInjected } from './GlobalRulesSection.tsx'
import { createGlobalRulesOperations } from './operations.ts'
import { en, zh, type GlobalRulesKey } from './locales.ts'

export type { GlobalRulesSectionInjected, GlobalRulesSectionProps } from './GlobalRulesSection.tsx'
export type { GlobalRulesOperations, GlobalRulesReadOutcome, GlobalRulesWriteOutcome } from './operations.ts'
export type { GlobalRulesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Global-rules page copy. */
    'settings.globalRules': GlobalRulesKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.globalRules'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on each slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.settings']

/**
 * Register the Global-rules section once the `settings.section` declaration
 * is on the ledger; the section reads and writes on mount through its own
 * inject faces.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-global-rules: copy dictionaries')

  // Bound once here, where the Remote namespaces are declared in this plugin's
  // own `inject`; the section receives callbacks and never a context.
  const operations = createGlobalRulesOperations(ctx)
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS)
  const injected = (): GlobalRulesSectionInjected => ({
    read: operations.read,
    write: operations.write,
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'global-rules',
    order: 5,
    label: () => t('nav'),
    icon: () => createElement(IconGlobeOutlineMedium, { size: 16 }),
    locale: NS,
    inject: injected,
  }, GlobalRulesSection))
}
