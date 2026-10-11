import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FailureCounter,
  MAX_DEVICES,
  PAIRING_TTL_MS,
  PairingManager,
  constantTimeEquals,
  generatePairingCode,
} from '../src/pairing.ts'
import { DeviceStore } from '../src/state.ts'

const T0 = 1_700_000_000_000

describe('generatePairingCode', () => {
  it('生成长度为 8、全部落在字符表内的配对码', () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode()
      expect(code).toHaveLength(8)
      for (const char of code) {
        expect('23456789ABCDEFGHJKMNPQRSTUVWXYZ').toContain(char)
      }
    }
  })

  it('src 全目录禁用 Math.random（CSPRNG 源码守卫）', async () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
    const files = (await readdir(srcDir)).filter(name => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const content = await readFile(path.join(srcDir, name), 'utf8')
      expect(content, `${name} 不得使用 Math.random`).not.toContain('Math.random')
    }
  })
})

describe('constantTimeEquals', () => {
  it('相同内容返回 true，不同内容返回 false，长度不同返回 false', () => {
    expect(constantTimeEquals('AB23CD45', 'AB23CD45')).toBe(true)
    expect(constantTimeEquals('AB23CD45', 'AB23CD46')).toBe(false)
    expect(constantTimeEquals('AB23CD45', 'AB23CD4')).toBe(false)
  })
})

describe('FailureCounter', () => {
  const options = { maxFailures: 5, windowMs: 60_000, lockMs: 60_000 }

  it('窗口内未达阈值不限流', () => {
    const counter = new FailureCounter(options)
    for (let i = 0; i < 4; i++) counter.recordFailure('ip-a', T0)
    expect(counter.check('ip-a', T0 + 1)).toEqual({ limited: false, retryAfterMs: 0 })
  })

  it('窗口内达到阈值即锁定，retryAfterMs 为锁定剩余时长', () => {
    const counter = new FailureCounter(options)
    for (let i = 0; i < 5; i++) counter.recordFailure('ip-a', T0)
    expect(counter.check('ip-a', T0 + 10)).toEqual({ limited: true, retryAfterMs: 59_990 })
  })

  it('锁定期结束后窗口已滚动，条目作废重来', () => {
    const counter = new FailureCounter(options)
    for (let i = 0; i < 5; i++) counter.recordFailure('ip-a', T0)
    expect(counter.check('ip-a', T0 + 60_000).limited).toBe(false)
    counter.recordFailure('ip-a', T0 + 60_000)
    expect(counter.check('ip-a', T0 + 60_001).limited).toBe(false)
  })

  it('窗口滚动后未再失败的 key 惰性清除', () => {
    const counter = new FailureCounter(options)
    counter.recordFailure('ip-a', T0)
    counter.check('ip-a', T0 + 60_001)
    counter.recordFailure('ip-a', T0 + 60_002)
    expect(counter.check('ip-a', T0 + 60_002)).toEqual({ limited: false, retryAfterMs: 0 })
  })

  it('成功清零失败计数', () => {
    const counter = new FailureCounter(options)
    for (let i = 0; i < 4; i++) counter.recordFailure('ip-a', T0)
    counter.recordSuccess('ip-a')
    for (let i = 0; i < 4; i++) counter.recordFailure('ip-a', T0 + 1)
    expect(counter.check('ip-a', T0 + 2).limited).toBe(false)
  })
})

describe('PairingManager', () => {
  let dir: string
  let store: DeviceStore
  let now: { current: number }
  let manager: PairingManager

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pocket-access-pairing-'))
    now = { current: T0 }
    store = new DeviceStore({ warn: vi.fn() }, path.join(dir, 'devices.json'))
    await store.load()
    manager = new PairingManager(store, () => now.current)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('createPairingCode 返回码与 5 分钟过期时间', () => {
    const { code, expiresAt } = manager.createPairingCode()
    expect(code).toHaveLength(8)
    expect(expiresAt).toBe(T0 + PAIRING_TTL_MS)
  })

  it('生成新码作废旧码：旧码提交按 invalid-code 计失败', async () => {
    const old = manager.createPairingCode()
    manager.createPairingCode()
    const result = await manager.attemptPair(old.code, '192.168.1.23', 'ua')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-code' })
  })

  it('配对码过期后按 no-active-code 计失败', async () => {
    const { code } = manager.createPairingCode()
    now.current += PAIRING_TTL_MS + 1
    const result = await manager.attemptPair(code, '192.168.1.23', 'ua')
    expect(result).toMatchObject({ ok: false, reason: 'no-active-code' })
  })

  it('配对成功：设备入清单、cookie 可校验、码一次性焚毁', async () => {
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.23', 'iPhone UA', 'lan')
    if (!result.ok) throw new Error(`配对应成功：${result.reason}`)
    expect(store.state.devices).toHaveLength(1)
    expect(store.state.devices[0]).toMatchObject({ id: result.deviceId, ua: 'iPhone UA', revokedAt: null, source: 'lan' })
    expect(manager.verifyDeviceCookie(result.cookie)).toEqual({ ok: true, deviceId: result.deviceId })
    // 码焚毁后无活跃码，同码再提交按 no-active-code 计失败
    expect(await manager.attemptPair(code, '192.168.1.23', 'ua')).toMatchObject({ ok: false, reason: 'no-active-code' })
  })

  it('未传 source 的配对：记录保持来源缺失（UI 显示未知）', async () => {
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.23', 'iPhone UA')
    if (!result.ok) throw new Error(`配对应成功：${result.reason}`)
    expect(store.state.devices[0]?.source).toBeUndefined()
  })

  it('同 UA 二次配对复用设备记录：deviceId 不变、清单仍 1 条、lastSeenAt 刷新、来源覆盖为最近入口', async () => {
    const { code } = manager.createPairingCode()
    const first = await manager.attemptPair(code, '192.168.1.23', 'iPhone UA', 'lan')
    if (!first.ok) throw new Error(`首次配对应成功：${first.reason}`)
    now.current += 5_000
    const { code: secondCode } = manager.createPairingCode()
    const second = await manager.attemptPair(secondCode, '192.168.1.24', 'iPhone UA', 'wan')
    if (!second.ok) throw new Error(`二次配对应成功：${second.reason}`)
    expect(second.deviceId).toBe(first.deviceId)
    expect(store.state.devices).toHaveLength(1)
    expect(store.state.devices[0]).toMatchObject({ lastSeenAt: new Date(T0 + 5_000).toISOString(), source: 'wan' })
    // 复用后重签的 cookie 同样可校验
    expect(manager.verifyDeviceCookie(second.cookie)).toEqual({ ok: true, deviceId: first.deviceId })
  })

  it('不同 UA 二次配对新建记录：清单变 2 条', async () => {
    const { code } = manager.createPairingCode()
    const first = await manager.attemptPair(code, '192.168.1.23', 'iPhone UA')
    if (!first.ok) throw new Error(`首次配对应成功：${first.reason}`)
    const { code: secondCode } = manager.createPairingCode()
    const second = await manager.attemptPair(secondCode, '192.168.1.23', 'Android UA')
    if (!second.ok) throw new Error(`二次配对应成功：${second.reason}`)
    expect(second.deviceId).not.toBe(first.deviceId)
    expect(store.state.devices).toHaveLength(2)
  })

  it('设备满员后同 UA 配对仍复用成功：不触发 max-devices', async () => {
    const { code } = manager.createPairingCode()
    const seeded = await manager.attemptPair(code, '192.168.1.1', 'iPhone UA')
    if (!seeded.ok) throw new Error(`首台配对应成功：${seeded.reason}`)
    for (let i = 1; i < MAX_DEVICES; i++) {
      const { code: fillCode } = manager.createPairingCode()
      const result = await manager.attemptPair(fillCode, `192.168.1.${i + 1}`, `ua-${i}`)
      if (!result.ok) throw new Error(`第 ${i + 1} 台配对应成功：${result.reason}`)
    }
    expect(store.state.devices).toHaveLength(MAX_DEVICES)
    // 同 UA 经公网入口再配对：复用记录，不受设备上限约束
    const { code: reuseCode } = manager.createPairingCode()
    const reuse = await manager.attemptPair(reuseCode, '192.168.1.200', 'iPhone UA')
    if (!reuse.ok) throw new Error(`复用配对应成功：${reuse.reason}`)
    expect(reuse.deviceId).toBe(seeded.deviceId)
    expect(store.state.devices).toHaveLength(MAX_DEVICES)
  })

  it('空 UA 不参与复用：两次配对产生 2 条记录', async () => {
    const { code } = manager.createPairingCode()
    const first = await manager.attemptPair(code, '192.168.1.23', '')
    if (!first.ok) throw new Error(`首次配对应成功：${first.reason}`)
    const { code: secondCode } = manager.createPairingCode()
    const second = await manager.attemptPair(secondCode, '192.168.1.23', '')
    if (!second.ok) throw new Error(`二次配对应成功：${second.reason}`)
    expect(second.deviceId).not.toBe(first.deviceId)
    expect(store.state.devices).toHaveLength(2)
  })

  it('单 IP 5 次失败后锁定，锁定期内正确码也不比对', async () => {
    for (let i = 0; i < 5; i++) {
      await manager.attemptPair('WRONGCOD', '192.168.1.23', 'ua')
    }
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.23', 'ua')
    if (result.ok) throw new Error('锁定期内正确码应被拒绝')
    expect(result.reason).toBe('rate-limited')
    expect(result.retryAfterMs ?? 0).toBeGreaterThan(0)
  })

  it('不同 IP 各自计数，互不影响', async () => {
    for (let i = 0; i < 4; i++) {
      await manager.attemptPair('WRONGCOD', '192.168.1.23', 'ua')
    }
    const result = await manager.attemptPair('WRONGCOD', '192.168.1.24', 'ua')
    expect(result).toMatchObject({ ok: false, reason: 'no-active-code' })
  })

  it('全局 50 次失败后任何 IP 都被锁定', async () => {
    for (let i = 0; i < 50; i++) {
      await manager.attemptPair('WRONGCOD', `10.0.0.${i}`, 'ua')
    }
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.99', 'ua')
    expect(result).toMatchObject({ ok: false, reason: 'rate-limited' })
  })

  it('配对成功清零该 IP 失败计数：成功后需再满 5 次失败才锁', async () => {
    for (let i = 0; i < 4; i++) {
      await manager.attemptPair('WRONGCOD', '192.168.1.23', 'ua')
    }
    const { code } = manager.createPairingCode()
    expect((await manager.attemptPair(code, '192.168.1.23', 'ua')).ok).toBe(true)
    for (let i = 0; i < 4; i++) {
      await manager.attemptPair('WRONGCOD', '192.168.1.23', 'ua')
    }
    // 第 5 次失败触发锁定，本次请求仍按比对结果返回
    expect((await manager.attemptPair('WRONGCOD', '192.168.1.23', 'ua')).ok).toBe(false)
    expect(await manager.attemptPair('WRONGCOD', '192.168.1.23', 'ua')).toMatchObject({ ok: false, reason: 'rate-limited' })
  })

  it('设备满 10 台后配对码比对成功仍拒绝且焚码', async () => {
    for (let i = 0; i < MAX_DEVICES; i++) {
      const { code } = manager.createPairingCode()
      const result = await manager.attemptPair(code, `192.168.1.${i + 1}`, `ua-${i}`)
      if (!result.ok) throw new Error(`第 ${i + 1} 台配对应成功：${result.reason}`)
    }
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.200', 'ua-extra')
    expect(result).toMatchObject({ ok: false, reason: 'max-devices' })
    expect(store.state.devices).toHaveLength(MAX_DEVICES)
    // 码已焚毁：吊销一台后同码也不能再配
    await manager.revokeDevice(store.state.devices[0]!.id)
    expect(await manager.attemptPair(code, '192.168.1.200', 'ua-extra')).toMatchObject({ ok: false, reason: 'no-active-code' })
  })

  it('verifyDeviceCookie：篡改签名、未知设备、已吊销均拒绝', async () => {
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.23', 'ua')
    if (!result.ok) throw new Error('配对应成功')
    const deviceId = result.deviceId

    expect(manager.verifyDeviceCookie(undefined)).toEqual({ ok: false, reason: 'unpaired' })
    expect(manager.verifyDeviceCookie('')).toEqual({ ok: false, reason: 'unpaired' })
    expect(manager.verifyDeviceCookie('not-a-cookie')).toEqual({ ok: false, reason: 'unpaired' })
    expect(manager.verifyDeviceCookie(`${deviceId}.${'0'.repeat(64)}`)).toEqual({ ok: false, reason: 'unpaired' })
    expect(manager.verifyDeviceCookie(`00000000-0000-4000-8000-000000000000.${result.cookie.split('.')[1]}`))
      .toEqual({ ok: false, reason: 'unpaired' })

    await manager.revokeDevice(deviceId)
    expect(manager.verifyDeviceCookie(result.cookie)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('revokeDevice 吊销即时生效且持久化，重复吊销返回 false', async () => {
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.23', 'ua')
    if (!result.ok) throw new Error('配对应成功')

    expect(await manager.revokeDevice(result.deviceId)).toBe(true)
    expect(store.state.devices[0]?.revokedAt).not.toBeNull()

    const reloaded = new DeviceStore({ warn: vi.fn() }, path.join(dir, 'devices.json'))
    await reloaded.load()
    expect(reloaded.state.devices[0]?.revokedAt).not.toBeNull()
    expect(await manager.revokeDevice(result.deviceId)).toBe(false)
    expect(await manager.revokeDevice('00000000-0000-4000-8000-000000000000')).toBe(false)
  })

  it('clearAllDevices 清空清单并持久化', async () => {
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.23', 'ua')
    if (!result.ok) throw new Error('配对应成功')
    await manager.clearAllDevices()
    expect(store.state.devices).toEqual([])
    expect(manager.verifyDeviceCookie(result.cookie)).toEqual({ ok: false, reason: 'unpaired' })

    const reloaded = new DeviceStore({ warn: vi.fn() }, path.join(dir, 'devices.json'))
    await reloaded.load()
    expect(reloaded.state.devices).toEqual([])
  })

  it('touchDevice 更新 lastSeenAt 并持久化', async () => {
    const { code } = manager.createPairingCode()
    const result = await manager.attemptPair(code, '192.168.1.23', 'ua')
    if (!result.ok) throw new Error('配对应成功')
    now.current += 120_000
    await manager.touchDevice(result.deviceId)
    expect(store.state.devices[0]?.lastSeenAt).toBe(new Date(T0 + 120_000).toISOString())

    const reloaded = new DeviceStore({ warn: vi.fn() }, path.join(dir, 'devices.json'))
    await reloaded.load()
    expect(reloaded.state.devices[0]?.lastSeenAt).toBe(new Date(T0 + 120_000).toISOString())
  })
})
