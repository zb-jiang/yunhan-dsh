/** The `write` endpoint: workspace confinement, the version guard, and the size cap. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-enterprise-file-write-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  await harness.dispose()
})

const endpoint = (caps?: { maxWriteBytes?: number }): ReturnType<Harness['endpoint']> => harness.endpoint(caps)

/** Create a link to a directory: a Windows junction where junctions exist, a directory symlink elsewhere. */
const directoryLink = (target: string, link: string): Promise<void> =>
  symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')

describe('enterpriseFiles.write — the happy path', () => {
  it('creates a new file and reports its absolute path and version', async () => {
    const result = await endpoint().write(harness.sessionId, { path: 'notes.md', content: '# hello' }, signal())
    expect(result.operation).toBe('create')
    expect(result.absolutePath).toBe(harness.ctx.fs.processPath(await harness.ctx.fs.resolve(join(workspace, 'notes.md'))))
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('# hello')
    expect(result.version).toBeTruthy()
  })

  it('updates through the version guard and reports the new version', async () => {
    const service = endpoint()
    const created = await service.write(harness.sessionId, { path: 'notes.md', content: 'v1' }, signal())
    const updated = await service.write(harness.sessionId, { path: 'notes.md', content: 'v2', expectedVersion: created.version }, signal())
    expect(updated.operation).toBe('update')
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('v2')
  })

  it('overwrites without a version guard', async () => {
    const service = endpoint()
    await service.write(harness.sessionId, { path: 'notes.md', content: 'v1' }, signal())
    const result = await service.write(harness.sessionId, { path: 'notes.md', content: 'v2' }, signal())
    expect(result.operation).toBe('update')
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('v2')
  })

  it('writes into a nested workspace directory', async () => {
    await mkdir(join(workspace, 'src'), { recursive: true })
    const result = await endpoint().write(harness.sessionId, { path: 'src/main.ts', content: 'const x = 1' }, signal())
    expect(result.operation).toBe('create')
    expect(await readFile(join(workspace, 'src', 'main.ts'), 'utf8')).toBe('const x = 1')
  })
})

describe('enterpriseFiles.write — the version guard', () => {
  it('rejects a save against a version that is no longer current, leaving the file untouched', async () => {
    const service = endpoint()
    const created = await service.write(harness.sessionId, { path: 'notes.md', content: 'v1' }, signal())
    await service.write(harness.sessionId, { path: 'notes.md', content: 'v2' }, signal())
    const failure = await failureOf(service.write(harness.sessionId, { path: 'notes.md', content: 'v3', expectedVersion: created.version }, signal()))
    expect(failure.code).toBe('enterprise-file/stale-version')
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('v2')
  })

  it('rejects a guard naming a file that does not exist', async () => {
    const failure = await failureOf(endpoint().write(harness.sessionId, { path: 'absent.md', content: 'x', expectedVersion: 'nope' }, signal()))
    expect(failure.code).toBe('enterprise-file/stale-version')
  })
})

describe('enterpriseFiles.write — workspace confinement', () => {
  it('rejects an absolute path outside the workspace', async () => {
    await writeFile(join(outside, 'seed.txt'), 'outside', 'utf8')
    const failure = await failureOf(endpoint().write(harness.sessionId, { path: join(outside, 'seed.txt'), content: 'x' }, signal()))
    expect(failure.code).toBe('enterprise-file/outside-workspace')
  })

  it('rejects a traversal that climbs out of the workspace', async () => {
    const failure = await failureOf(endpoint().write(harness.sessionId, { path: '../outside/escape.txt', content: 'x' }, signal()))
    expect(failure.code).toBe('enterprise-file/outside-workspace')
  })

  it('rejects a directory link that resolves outside the workspace', async () => {
    await directoryLink(outside, join(workspace, 'escape'))
    const failure = await failureOf(endpoint().write(harness.sessionId, { path: 'escape/escape.txt', content: 'x' }, signal()))
    expect(failure.code).toBe('enterprise-file/outside-workspace')
  })
})

describe('enterpriseFiles.write — request validation', () => {
  it('rejects a write above the byte cap instead of shortening it', async () => {
    const failure = await failureOf(endpoint({ maxWriteBytes: 8 }).write(harness.sessionId, { path: 'big.txt', content: 'x'.repeat(9) }, signal()))
    expect(failure.code).toBe('enterprise-file/too-large')
    expect(failure.details).toMatchObject({ path: 'big.txt', limit: 8 })
  })

  it('rejects an empty path', async () => {
    const failure = await failureOf(endpoint().write(harness.sessionId, { path: '', content: 'x' }, signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })

  it('rejects a path with a NUL byte', async () => {
    const failure = await failureOf(endpoint().write(harness.sessionId, { path: 'a\0b.txt', content: 'x' }, signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })

  it('rejects a session it cannot resolve', async () => {
    const failure = await failureOf(endpoint().write(SessionId('s-missing'), { path: 'x.txt', content: 'x' }, signal()))
    expect(failure.code).toBe('enterprise-file/session-not-found')
    expect(failure.details).toMatchObject({ sessionId: 's-missing' })
  })
})
