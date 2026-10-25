/** Remote form operations over real Cordis profile configuration. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SettingsController from '../src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'

async function boot() {
  const fixture = await configurationFixture()
  await fixture.ctx.plugin(SettingsController)
  return { ...fixture, controller: fixture.ctx.settingsController }
}

describe('settings Remote', () => {
  it('publishes form operations and the credentials namespace', async () => {
    const { ctx, controller } = await boot()
    expect(controller.typertRemote.namespace).toBe('settings')
    expect(remoteMethods(controller).map(method => method.method)).toEqual([
      'describe', 'update', 'replace', 'mutate', 'openSettingsDocument',
      'readGlobalInstructions', 'writeGlobalInstructions',
    ])
    expect(ctx.get('credentialsController')).toBeDefined()
  })

  it('redacts every described layer and applies mutations through the consumer', async () => {
    const { controller, ctx } = await boot()
    const describe = controller.describe()
    expect(describe).toMatchObject({ writable: true, hasDocument: true })
    expect(JSON.stringify(describe)).not.toContain('private')
    const model = describe.namespaces.find(row => row.ns === 'default-model')!
    const saved = await controller.mutate(model.ns, [{ op: 'set', path: ['model'], value: 'next' }], model.revision)
    expect(saved.value).toEqual({ provider: 'test', model: 'next' })
    expect(ctx.agentDefaultModel.currentSelection().model).toBe('next')
    await expect(controller.update(model.ns, { model: 'stale' }, model.revision)).rejects.toMatchObject({ code: 'settings/conflict' })
    await expect(controller.update('first', { count: 0 }, undefined)).rejects.toMatchObject({ code: 'settings/rejected' })
    await expect(controller.update('', {}, undefined)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.update('missing', {}, undefined)).rejects.toMatchObject({ code: 'settings/rejected' })
    expect((await controller.replace('default-model', {}, undefined)).value).toEqual({ provider: 'test', model: 'original' })
  })

  it('reports an absent Config form service', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const controller = new SettingsController(ctx)
    expect(() => controller.describe()).toThrow('settings service is absent')
    const failure = await controller.update('missing', {}, undefined).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)?.code).toBe('gateway/internal')
  })

  it('opens the profile patch and contains opener failure and cancellation', async () => {
    const { ctx, profile } = await configurationFixture()
    const openTextFile = vi.fn(async (_path: string, _signal: AbortSignal) => {})
    const controller = new SettingsController(ctx, { openTextFile })
    const abort = new AbortController()
    await controller.openSettingsDocument(abort.signal)
    expect(openTextFile).toHaveBeenCalledWith(profile.patchPath, abort.signal)
    openTextFile.mockRejectedValueOnce(new Error('no editor'))
    await expect(controller.openSettingsDocument(abort.signal)).rejects.toMatchObject({ code: 'gateway/internal' })
    abort.abort()
    await expect(controller.openSettingsDocument(abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })

  it('does not open a patch cancelled while preparation is pending', async () => {
    const { ctx } = await configurationFixture()
    const prepared = Promise.withResolvers<string>()
    vi.spyOn(ctx.settings, 'prepareDocument').mockReturnValue(prepared.promise)
    const openTextFile = vi.fn(async (_path: string, _signal: AbortSignal) => {})
    const controller = new SettingsController(ctx, { openTextFile })
    const abort = new AbortController()
    const opening = controller.openSettingsDocument(abort.signal)
    abort.abort()
    prepared.resolve('/tmp/cordis.patch.yml')
    await expect(opening).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(openTextFile).not.toHaveBeenCalled()
  })

})

it('omits absent optional descriptor fields and contains primitive write failures', async () => {
  const { ctx, controller } = await boot()
  vi.spyOn(ctx.settings, 'describe').mockReturnValue([{ ns: 'first' as never, schema: {}, value: {}, autoGenerate: true, applies: 'live', revision: 0 }])
  expect(controller.describe().namespaces[0]).toEqual({ ns: 'first', schema: {}, value: {}, autoGenerate: true, applies: 'live', revision: 0, secrets: [] })
  vi.spyOn(ctx.settings, 'update').mockRejectedValueOnce('storage unavailable')
  await expect(controller.update('first', {}, undefined)).rejects.toMatchObject({ code: 'settings/rejected' })
})

it('reports a form removed after its write committed', async () => {
  const { ctx, controller } = await boot()
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  vi.spyOn(ctx.settings, 'update').mockImplementation(async () => { entry.parent.remove(entry.options.id) })
  await expect(controller.update('first', {}, undefined)).rejects.toMatchObject({ code: 'gateway/internal' })
})

it('classifies document preparation failures and cancellation during opening', async () => {
  const { ctx } = await configurationFixture({ hmr: false })
  let abort = new AbortController()
  const controller = new SettingsController(ctx, { openTextFile: async () => {
    abort.abort(); throw new Error('opening cancelled')
  } })
  const prepare = vi.spyOn(ctx.settings, 'prepareDocument')
  prepare.mockRejectedValueOnce(new Error('unreadable profile'))
  await expect(controller.openSettingsDocument(abort.signal)).rejects.toMatchObject({ code: 'gateway/internal' })
  prepare.mockImplementationOnce(async () => { abort.abort(); throw new Error('preparation cancelled') })
  await expect(controller.openSettingsDocument(abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
  abort = new AbortController()
  await expect(controller.openSettingsDocument(abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
})

/** Points DSH_HOME at a fresh temp directory and restores the previous value afterwards. */
async function withTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-global-rules-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  onTestFinished(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  return home
}

describe('global instructions Remote', () => {
  it('reads an absent file as empty and omits the injection budget without a configured entry', async () => {
    const { controller } = await boot()
    const home = await withTempHome()
    const view = await controller.readGlobalInstructions()
    expect(view).toEqual({ path: join(home, 'AGENTS.md'), homeDisplay: '$DSH_HOME', exists: false, content: '' })
  })

  it('creates missing home directories and writes the rules file', async () => {
    const { controller } = await boot()
    const home = await withTempHome()
    process.env.DSH_HOME = join(home, 'nested')
    const written = await controller.writeGlobalInstructions('# My rules\n')
    expect(written).toEqual({
      path: join(home, 'nested', 'AGENTS.md'), homeDisplay: '$DSH_HOME', exists: true, content: '# My rules\n',
    })
    expect(await readFile(join(home, 'nested', 'AGENTS.md'), 'utf8')).toBe('# My rules\n')
  })

  it('reads back a file written earlier', async () => {
    const { controller } = await boot()
    const home = await withTempHome()
    await controller.writeGlobalInstructions('# Roundtrip\n')
    const view = await controller.readGlobalInstructions()
    expect(view).toEqual({ path: join(home, 'AGENTS.md'), homeDisplay: '$DSH_HOME', exists: true, content: '# Roundtrip\n' })
  })

  it('rejects non-string payloads and content beyond the wire ceiling', async () => {
    const { controller } = await boot()
    await withTempHome()
    await expect(controller.writeGlobalInstructions(42 as never)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.writeGlobalInstructions('a'.repeat(1_048_577))).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(await readFile(join(process.env.DSH_HOME!, 'AGENTS.md'), 'utf8').catch(() => null)).toBeNull()
  })

  it('reports filesystem failures on both read and write', async () => {
    const { controller } = await boot()
    const home = await withTempHome()
    await mkdir(join(home, 'AGENTS.md'))
    await expect(controller.readGlobalInstructions()).rejects.toMatchObject({
      code: 'globalRules/rejected', details: { path: join(home, 'AGENTS.md') },
    })
    await expect(controller.writeGlobalInstructions('# blocked\n')).rejects.toMatchObject({
      code: 'globalRules/rejected', details: { path: join(home, 'AGENTS.md') },
    })
  })

  it('exposes the agent-instructions injection budget when the loader declares it', async () => {
    await boot()
    await withTempHome()
    const ctx = new Context()
    ctx.provide('loader', {
      entries: function* () {
        yield { options: { id: 'agent-instructions' }, fiber: { config: { maxBytes: 4096 } } }
      },
    })
    const budgeted = new SettingsController(ctx)
    expect((await budgeted.readGlobalInstructions()).maxBytes).toBe(4096)
  })
})
