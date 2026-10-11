import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_BACKLOG_MAX, AUDIT_BATCH_SIZE, AuditBacklog, parseAuditEvent, resolveWebConsoleBaseUrl } from '../src/audit.ts'

/** web-console 成功信封对应的 fetch Response 桩。 */
function okEnvelope(accepted: number): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ success: true, data: { accepted } }) }
}

/** 断言上报信封是对象后取出（JSON.parse 结果先验形状再使用）。 */
function parseEnvelope(raw: string): { events?: unknown } {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('上报信封不是对象')
  return parsed
}

describe('resolveWebConsoleBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('配置值 trim 并去尾斜杠', () => {
    expect(resolveWebConsoleBaseUrl(' http://wc.example.com/ ')).toBe('http://wc.example.com')
  })

  it('配置为空走 env WEB_CONSOLE_URL', () => {
    vi.stubEnv('WEB_CONSOLE_URL', 'http://from-env.test/')
    expect(resolveWebConsoleBaseUrl('')).toBe('http://from-env.test')
  })

  it('配置与 env 均为空走默认本机地址', () => {
    vi.stubEnv('WEB_CONSOLE_URL', '')
    expect(resolveWebConsoleBaseUrl('  ')).toBe('http://127.0.0.1:8080')
  })
})

describe('parseAuditEvent', () => {
  const valid = { eventType: 'POCKET_DEVICE_PAIRED', details: { deviceId: 'dev-1' }, occurredAt: 123 }

  it('接受合法事件（含 targetUserId）', () => {
    expect(parseAuditEvent(JSON.stringify({ ...valid, targetUserId: 'user-1' }))).toEqual({
      eventType: 'POCKET_DEVICE_PAIRED',
      details: { deviceId: 'dev-1' },
      occurredAt: 123,
      targetUserId: 'user-1',
    })
  })

  it('接受合法事件（无 targetUserId）', () => {
    expect(parseAuditEvent(JSON.stringify(valid))).toEqual(valid)
  })

  it('拒绝空行与非 JSON', () => {
    expect(parseAuditEvent('')).toBeNull()
    expect(parseAuditEvent('   ')).toBeNull()
    expect(parseAuditEvent('{not-json')).toBeNull()
  })

  it('拒绝非对象 JSON', () => {
    expect(parseAuditEvent('[]')).toBeNull()
    expect(parseAuditEvent('123')).toBeNull()
  })

  it('拒绝 eventType 缺失、非字符串或不在枚举', () => {
    expect(parseAuditEvent(JSON.stringify({ details: {}, occurredAt: 1 }))).toBeNull()
    expect(parseAuditEvent(JSON.stringify({ eventType: 3, details: {}, occurredAt: 1 }))).toBeNull()
    expect(parseAuditEvent(JSON.stringify({ eventType: 'NOT_A_TYPE', details: {}, occurredAt: 1 }))).toBeNull()
  })

  it('拒绝 details 缺失、数组或标量', () => {
    expect(parseAuditEvent(JSON.stringify({ eventType: 'POCKET_ENABLED', occurredAt: 1 }))).toBeNull()
    expect(parseAuditEvent(JSON.stringify({ eventType: 'POCKET_ENABLED', details: [], occurredAt: 1 }))).toBeNull()
    expect(parseAuditEvent(JSON.stringify({ eventType: 'POCKET_ENABLED', details: 'x', occurredAt: 1 }))).toBeNull()
  })

  it('拒绝 occurredAt 缺失或非有限数字', () => {
    expect(parseAuditEvent(JSON.stringify({ eventType: 'POCKET_ENABLED', details: {} }))).toBeNull()
    expect(parseAuditEvent(JSON.stringify({ eventType: 'POCKET_ENABLED', details: {}, occurredAt: Number.NaN }))).toBeNull()
    expect(parseAuditEvent(JSON.stringify({ eventType: 'POCKET_ENABLED', details: {}, occurredAt: Number.POSITIVE_INFINITY }))).toBeNull()
  })

  it('拒绝 targetUserId 非字符串', () => {
    expect(parseAuditEvent(JSON.stringify({ ...valid, targetUserId: 7 }))).toBeNull()
  })
})

describe('AuditBacklog', () => {
  let dir: string
  let filePath: string
  let token: string | undefined
  let backlog: AuditBacklog | null

  /** 构造绑定临时文件与递增时钟的 backlog（登录态经外部 token 变量控制）。 */
  function makeBacklog(logger: { warn: (...args: unknown[]) => void }): AuditBacklog {
    let tick = 0
    return new AuditBacklog(
      { logger, getWebConsoleBaseUrl: () => 'http://wc.test', getToken: () => token },
      filePath,
      () => 1_700_000_000_000 + tick++,
    )
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pocket-access-audit-'))
    filePath = path.join(dir, 'audit-backlog.jsonl')
    token = undefined
    backlog = null
  })

  afterEach(async () => {
    if (backlog !== null) await backlog.dispose()
    backlog = null
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it('record 全量重写 backlog 文件；未登录时不发请求', async () => {
    const logger = { warn: vi.fn() }
    const instance = makeBacklog(logger)
    backlog = instance
    const fetchMock = vi.fn(async () => okEnvelope(1))
    vi.stubGlobal('fetch', fetchMock)

    await instance.record('POCKET_ENABLED', { port: 3081 })
    await instance.record('POCKET_DEVICE_PAIRED', { deviceId: 'dev-1' }, 'user-1')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await instance.backlogCount()).toBe(2)
    const lines = (await readFile(filePath, 'utf8')).split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(2)
    const first = parseAuditEvent(lines[0] ?? '')
    expect(first?.eventType).toBe('POCKET_ENABLED')
    expect(first?.occurredAt).toBe(1_700_000_000_000)
    const second = parseAuditEvent(lines[1] ?? '')
    expect(second?.targetUserId).toBe('user-1')
  })

  it('登录后 maybeFlush 批量上报并清空 backlog', async () => {
    const instance = makeBacklog({ warn: vi.fn() })
    backlog = instance
    await instance.record('POCKET_ENABLED', {})
    await instance.record('POCKET_DISABLED', {})

    token = 'jwt'
    const reportedUrls: string[] = []
    const bodies: Array<{ events?: unknown }> = []
    const fetchMock = vi.fn(async (url: URL | string, init?: { body?: unknown }) => {
      reportedUrls.push(typeof url === 'string' ? url : url.href)
      bodies.push(parseEnvelope(typeof init?.body === 'string' ? init.body : '{}'))
      return okEnvelope(2)
    })
    vi.stubGlobal('fetch', fetchMock)

    instance.maybeFlush()
    await instance.dispose()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(reportedUrls[0]).toBe('http://wc.test/api/pocket/access-events')
    expect(bodies[0]?.events).toHaveLength(2)
    expect(await instance.backlogCount()).toBe(0)
    expect(await readFile(filePath, 'utf8')).toBe('')
  })

  it('上报失败事件留 backlog 并告警，重放成功后清空', async () => {
    const logger = { warn: vi.fn() }
    const instance = makeBacklog(logger)
    backlog = instance
    token = 'jwt'
    let fail = true
    const fetchMock = vi.fn(async () => (fail ? { ok: false, status: 500 } : okEnvelope(1)))
    vi.stubGlobal('fetch', fetchMock)

    await instance.record('POCKET_ENABLED', {})
    await instance.dispose()
    expect(await instance.backlogCount()).toBe(1)
    expect(logger.warn).toHaveBeenCalled()

    fail = false
    instance.maybeFlush()
    await instance.dispose()
    expect(await instance.backlogCount()).toBe(0)
    expect(await readFile(filePath, 'utf8')).toBe('')
  })

  it('响应信封非成功时事件留 backlog', async () => {
    const logger = { warn: vi.fn() }
    const instance = makeBacklog(logger)
    backlog = instance
    token = 'jwt'
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: 'x' }) }))
    vi.stubGlobal('fetch', fetchMock)

    await instance.record('POCKET_ENABLED', {})
    await instance.dispose()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await instance.backlogCount()).toBe(1)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('超过单批上限时分多批上报', async () => {
    const instance = makeBacklog({ warn: vi.fn() })
    backlog = instance
    const lines = Array.from({ length: AUDIT_BATCH_SIZE + 20 }, (_, index) =>
      JSON.stringify({ eventType: 'POCKET_ENABLED', details: { index }, occurredAt: index }))
    await writeFile(filePath, `${lines.join('\n')}\n`)
    token = 'jwt'
    const bodies: Array<{ events?: unknown }> = []
    const fetchMock = vi.fn(async (_url: URL | string, init?: { body?: unknown }) => {
      bodies.push(parseEnvelope(typeof init?.body === 'string' ? init.body : '{}'))
      return okEnvelope(1)
    })
    vi.stubGlobal('fetch', fetchMock)

    instance.maybeFlush()
    await instance.dispose()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies[0]?.events).toHaveLength(AUDIT_BATCH_SIZE)
    expect(bodies[1]?.events).toHaveLength(20)
    expect(await instance.backlogCount()).toBe(0)
  })

  it('backlog 超过上限时丢弃最旧事件并告警', async () => {
    const logger = { warn: vi.fn() }
    const instance = makeBacklog(logger)
    backlog = instance
    const lines = Array.from({ length: AUDIT_BACKLOG_MAX }, (_, index) =>
      JSON.stringify({ eventType: 'POCKET_ENABLED', details: { index }, occurredAt: index }))
    await writeFile(filePath, `${lines.join('\n')}\n`)

    await instance.record('POCKET_LAN_DISABLED_HIT', { ip: '10.0.0.1' })
    await instance.dispose()

    expect(await instance.backlogCount()).toBe(AUDIT_BACKLOG_MAX)
    expect(logger.warn).toHaveBeenCalled()
    const saved = (await readFile(filePath, 'utf8')).split('\n').filter(line => line !== '')
    expect(saved).toHaveLength(AUDIT_BACKLOG_MAX)
    const first = parseAuditEvent(saved[0] ?? '')
    expect(first?.details).toEqual({ index: 1 })
    const last = parseAuditEvent(saved[saved.length - 1] ?? '')
    expect(last?.eventType).toBe('POCKET_LAN_DISABLED_HIT')
  })

  it('启动读文件回填内存，坏行跳过并告警', async () => {
    const logger = { warn: vi.fn() }
    const instance = makeBacklog(logger)
    backlog = instance
    const good = [
      JSON.stringify({ eventType: 'POCKET_TUNNEL_STARTED', details: { mode: 'quick' }, occurredAt: 1 }),
      JSON.stringify({ eventType: 'POCKET_DISABLED', details: {}, occurredAt: 2, targetUserId: 'user-2' }),
    ]
    await writeFile(filePath, `${good[0]}\n{not-json\n${good[1]}\n`)

    expect(await instance.backlogCount()).toBe(2)
    expect(logger.warn).toHaveBeenCalledOnce()
  })
})
