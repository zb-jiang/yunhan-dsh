import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultState, DeviceStore, parseState } from '../src/state.ts'

function validDeviceJson(): string {
  return JSON.stringify({
    secret: 'a'.repeat(64),
    devices: [
      { id: 'dev-1', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z', ua: 'iPhone', revokedAt: null },
      { id: 'dev-2', createdAt: '2026-01-03T00:00:00.000Z', lastSeenAt: '2026-01-04T00:00:00.000Z', ua: 'Android', revokedAt: '2026-01-05T00:00:00.000Z' },
    ],
  })
}

describe('createDefaultState', () => {
  it('生成 64 位十六进制配对密钥与空设备清单', () => {
    const state = createDefaultState()
    expect(state.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(state.devices).toEqual([])
  })

  it('两次生成密钥不同', () => {
    expect(createDefaultState().secret).not.toBe(createDefaultState().secret)
  })
})

describe('parseState', () => {
  it('接受合法结构（含 revokedAt 为 null 与已撤销设备）', () => {
    const parsed = parseState(validDeviceJson())
    expect(parsed).not.toBeNull()
    expect(parsed?.secret).toBe('a'.repeat(64))
    expect(parsed?.devices).toHaveLength(2)
    expect(parsed?.devices[0]).toEqual({
      id: 'dev-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-02T00:00:00.000Z',
      ua: 'iPhone',
      revokedAt: null,
    })
    // 旧记录无 source 字段：解析后保持缺失（UI 显示未知）
    expect(parsed?.devices[0]?.source).toBeUndefined()
  })

  it('source 非法值视为缺失，不拒整文件', () => {
    const parsed = parseState(JSON.stringify({
      secret: 'abc',
      devices: [{
        id: 'dev-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-02T00:00:00.000Z',
        ua: 'iPhone',
        revokedAt: null,
        source: 'bogus',
      }],
    }))
    expect(parsed).not.toBeNull()
    expect(parsed?.devices[0]?.source).toBeUndefined()
  })

  it('允许空设备清单', () => {
    const parsed = parseState(JSON.stringify({ secret: 'abc', devices: [] }))
    expect(parsed).toEqual({ secret: 'abc', devices: [] })
  })

  it('拒绝非法 JSON', () => {
    expect(parseState('{not-json')).toBeNull()
  })

  it('拒绝非对象 JSON', () => {
    expect(parseState('[]')).toBeNull()
    expect(parseState('"text"')).toBeNull()
    expect(parseState('123')).toBeNull()
  })

  it('拒绝缺失或空 secret', () => {
    expect(parseState(JSON.stringify({ devices: [] }))).toBeNull()
    expect(parseState(JSON.stringify({ secret: '', devices: [] }))).toBeNull()
  })

  it('拒绝 devices 非数组', () => {
    expect(parseState(JSON.stringify({ secret: 'abc', devices: {} }))).toBeNull()
    expect(parseState(JSON.stringify({ secret: 'abc' }))).toBeNull()
  })

  it('拒绝缺字段或字段类型错误的设备记录', () => {
    const base = { id: 'dev-1', createdAt: 't', lastSeenAt: 't', ua: 'u', revokedAt: null }
    for (const key of ['id', 'createdAt', 'lastSeenAt'] as const) {
      const broken = { ...base, [key]: undefined }
      expect(parseState(JSON.stringify({ secret: 'abc', devices: [broken] }))).toBeNull()
    }
    expect(parseState(JSON.stringify({ secret: 'abc', devices: [{ ...base, ua: null }] }))).toBeNull()
    expect(parseState(JSON.stringify({ secret: 'abc', devices: [null] }))).toBeNull()
  })

  it('拒绝 revokedAt 非 string/null', () => {
    const base = { id: 'dev-1', createdAt: 't', lastSeenAt: 't', ua: 'u' }
    expect(parseState(JSON.stringify({ secret: 'abc', devices: [{ ...base, revokedAt: 123 }] }))).toBeNull()
    expect(parseState(JSON.stringify({ secret: 'abc', devices: [{ ...base, revokedAt: '' }] }))).toBeNull()
  })
})

describe('DeviceStore', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pocket-access-state-'))
    filePath = path.join(dir, 'devices.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('文件缺失：以默认状态起底并落盘，不告警', async () => {
    const logger = { warn: vi.fn() }
    const store = new DeviceStore(logger, filePath)
    await store.load()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(store.state.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(store.state.devices).toEqual([])
    const raw = await readFile(filePath, 'utf8')
    expect(parseState(raw)).not.toBeNull()
  })

  it('合法文件：原样加载且不告警', async () => {
    await writeFile(filePath, `${validDeviceJson()}\n`)
    const logger = { warn: vi.fn() }
    const store = new DeviceStore(logger, filePath)
    await store.load()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(store.state.secret).toBe('a'.repeat(64))
    expect(store.state.devices.map(device => device.id)).toEqual(['dev-1', 'dev-2'])
  })

  it('损坏文件：告警并以默认状态覆盖落盘', async () => {
    await writeFile(filePath, '{not-json')
    const logger = { warn: vi.fn() }
    const store = new DeviceStore(logger, filePath)
    await store.load()
    expect(logger.warn).toHaveBeenCalledOnce()
    const parsed = parseState(await readFile(filePath, 'utf8'))
    expect(parsed?.devices).toEqual([])
    expect(parsed?.secret).toBe(store.state.secret)
  })

  it('合法 JSON 但结构不合法：同样告警并重置', async () => {
    await writeFile(filePath, JSON.stringify({ secret: '', devices: 'no' }))
    const logger = { warn: vi.fn() }
    const store = new DeviceStore(logger, filePath)
    await store.load()
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(store.state.devices).toEqual([])
  })

  it('变更后 save 持久化，新实例 load 恢复', async () => {
    const store = new DeviceStore({ warn: vi.fn() }, filePath)
    await store.load()
    store.state.devices.push({
      id: 'dev-new',
      createdAt: '2026-02-01T00:00:00.000Z',
      lastSeenAt: '2026-02-01T00:00:00.000Z',
      ua: 'Safari iOS',
      revokedAt: null,
      source: 'wan',
    })
    store.state.devices[0]!.revokedAt = '2026-02-02T00:00:00.000Z'
    await store.save()

    const second = new DeviceStore({ warn: vi.fn() }, filePath)
    await second.load()
    expect(second.state.devices).toHaveLength(1)
    expect(second.state.devices[0]).toEqual({
      id: 'dev-new',
      createdAt: '2026-02-01T00:00:00.000Z',
      lastSeenAt: '2026-02-01T00:00:00.000Z',
      ua: 'Safari iOS',
      revokedAt: '2026-02-02T00:00:00.000Z',
      source: 'wan',
    })
  })

  it('save 后目录无临时文件残留，内容以单个换行结尾', async () => {
    const store = new DeviceStore({ warn: vi.fn() }, filePath)
    await store.load()
    const files = await readdir(dir)
    expect(files).toEqual(['devices.json'])
    const raw = await readFile(filePath, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.endsWith('\n\n')).toBe(false)
  })

  it('POSIX 上落盘权限为 0600', async () => {
    if (process.platform === 'win32') return // Windows 忽略 POSIX 权限位
    const store = new DeviceStore({ warn: vi.fn() }, filePath)
    await store.load()
    const info = await stat(filePath)
    expect(info.mode & 0o777).toBe(0o600)
  })
})
