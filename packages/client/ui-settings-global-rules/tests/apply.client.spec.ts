// @vitest-environment jsdom
/** Global-rules operations in the shipped client composition: seat registration and outcome mapping. */
import { expect } from 'vitest'
import type { GlobalInstructionsValue } from '@deepseek-ai/dsh-api-remotes/client'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { GlobalRulesSectionInjected } from '../src/client/index.ts'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-global-rules'

/** One Host view of the user-global instructions file; `maxBytes` is present only when a budget is configured. */
function makeView(options: {
  readonly content?: string
  readonly exists?: boolean
  readonly maxBytes?: number
} = {}): GlobalInstructionsValue {
  const view: GlobalInstructionsValue = {
    path: '/home/user/.dsh/AGENTS.md',
    homeDisplay: '~/.dsh',
    exists: options.exists ?? true,
    content: options.content ?? '# Standing rules\n',
  }
  if (options.maxBytes !== undefined) return { ...view, maxBytes: options.maxBytes }
  return view
}

/** The Global-rules seat in the shipped settings section list. */
function globalRulesEntry(c: TestClient) {
  return c.ctx.slots.entries('settings.section').find(entry => entry.options.id === 'global-rules')
}

/** The section's injected remote surface, read through the same object-narrowing the renderer uses. */
function operations(c: TestClient): GlobalRulesSectionInjected {
  const injected: object = globalRulesEntry(c)!.inject!()
  return injected as GlobalRulesSectionInjected
}

it('registers the Global-rules section and frees the seat when it unloads', async ({ start }) => {
  const c = await start()
  const entry = globalRulesEntry(c)
  expect(entry).toBeDefined()
  expect(entry!.options).toMatchObject({ id: 'global-rules', order: 5 })
  // jsdom reports en-US, so the locale-following nav label resolves to the English copy.
  expect(resolveSlotLabel(entry!.options.label)).toBe('Global rules')
  const ops = operations(c)
  expect(ops.read).toBeTypeOf('function')
  expect(ops.write).toBeTypeOf('function')
  await c.unload(SELF)
  expect(globalRulesEntry(c)).toBeUndefined()
}, 60_000)

it('maps read and write responses onto the section outcome vocabulary', async ({ start, mock }) => {
  const c = await start()
  const ops = operations(c)
  const remote = mock.remote.settings
  const view = makeView()

  remote.readGlobalInstructions.mockResolvedValueOnce(ok(view))
  await expect(ops.read()).resolves.toEqual({ kind: 'loaded', view })
  remote.readGlobalInstructions.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  await expect(ops.read()).resolves.toEqual({ kind: 'failed', message: 'offline' })
  expect(remote.readGlobalInstructions).toHaveBeenCalledTimes(2)

  const changed = makeView({ content: '# Changed\n' })
  remote.writeGlobalInstructions.mockResolvedValueOnce(ok(changed))
  await expect(ops.write('# Changed\n')).resolves.toEqual({ kind: 'written', view: changed })
  remote.writeGlobalInstructions.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'too large', {}) })
  await expect(ops.write('# Changed\n')).resolves.toEqual({ kind: 'too-large', message: 'too large' })
  remote.writeGlobalInstructions.mockResolvedValueOnce({ ok: false, error: new RemoteError('globalRules/rejected', 'disk full', { path: view.path }) })
  await expect(ops.write('# Changed\n')).resolves.toEqual({ kind: 'refused', message: 'disk full' })
  expect(remote.writeGlobalInstructions).toHaveBeenCalledTimes(3)
  expect(remote.writeGlobalInstructions).toHaveBeenLastCalledWith('# Changed\n')
}, 60_000)
