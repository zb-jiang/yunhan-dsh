import { describe, expect, it, vi } from 'vitest'
import { PairingExpiryWatcher, probePairingViaGate, type PairingExpiry } from '../src/client/pocket/pocket-pairing-expiry.ts'
import type { ConnectionState, ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'

/** 手工驱动的连接状态源假件：set 直接改快照并同步触发订阅回调。 */
function fakeConnectionState(initial: ConnectionState | undefined): {
  source: ConnectionStateSource
  set: (next: ConnectionState | undefined) => void
} {
  const listeners = new Set<() => void>()
  let state = initial
  return {
    source: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(next) {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

/** 固定响应的探测 fetch 假件。 */
function respondWith(status: number, body: string): () => Promise<Response> {
  return () => Promise.resolve(new Response(body, { status }))
}

/** 排空微任务队列（watcher 的 probe().then 回调落地）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('probePairingViaGate', () => {
  it('401 + device-revoked code 解析为撤销并取响应体文案', async () => {
    const actual = probePairingViaGate(respondWith(401, JSON.stringify({
      error: '该设备的配对已被撤销，请重新扫码配对。',
      code: 'device-revoked',
    })))
    await expect(actual).resolves.toEqual({ kind: 'revoked', message: '该设备的配对已被撤销，请重新扫码配对。' })
  })

  it('401 + device-revoked 但响应体缺 error 时回退默认文案', async () => {
    const actual = probePairingViaGate(respondWith(401, JSON.stringify({ code: 'device-revoked' })))
    await expect(actual).resolves.toEqual({ kind: 'revoked', message: '该设备的配对已被撤销，请重新扫码配对。' })
  })

  it('401 无 code 归为未配对并取响应体文案', async () => {
    const actual = probePairingViaGate(respondWith(401, JSON.stringify({ error: '未配对文案' })))
    await expect(actual).resolves.toEqual({ kind: 'unpaired', message: '未配对文案' })
  })

  it('401 非 JSON 响应体回退到未配对默认文案', async () => {
    const actual = probePairingViaGate(respondWith(401, '<html>gateway error</html>'))
    await expect(actual).resolves.toEqual({
      kind: 'unpaired',
      message: '本设备尚未配对，或电脑端已退出登录导致配对失效，请重新扫码配对。',
    })
  })

  it('403 解析为局域网关闭并取响应体文案', async () => {
    const actual = probePairingViaGate(respondWith(403, JSON.stringify({
      error: '局域网访问已关闭，请在电脑上的手机访问设置中开启。',
    })))
    await expect(actual).resolves.toEqual({ kind: 'blocked', message: '局域网访问已关闭，请在电脑上的手机访问设置中开启。' })
  })

  it('闸门放行(200)不构成失效证据', async () => {
    const actual = probePairingViaGate(respondWith(200, JSON.stringify({ ok: true })))
    await expect(actual).resolves.toBeNull()
  })

  it('网络异常解析为 unreachable 并使用回退文案', async () => {
    const actual = probePairingViaGate(() => Promise.reject(new Error('network down')))
    await expect(actual).resolves.toEqual({
      kind: 'unreachable',
      message: '手机访问连接已断开：电脑端可能已关闭手机访问、电脑已关机或网络不可达，请检查后重试。',
    })
  })
})

describe('PairingExpiryWatcher', () => {
  it('初始 connected 不探测', () => {
    const { source } = fakeConnectionState('connected')
    const probe = vi.fn((): Promise<PairingExpiry | null> => Promise.resolve(null))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    expect(probe).not.toHaveBeenCalled()
    expect(watcher.getExpiry()).toBeNull()
    watcher.dispose()
  })

  it('初始断开即探测并置失效结论、通知监听者', async () => {
    const { source } = fakeConnectionState('disconnected')
    const probe = vi.fn((): Promise<PairingExpiry | null> => Promise.resolve({ kind: 'revoked', message: '已撤销' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    const seen: Array<PairingExpiry | null> = []
    watcher.subscribe(() => { seen.push(watcher.getExpiry()) })
    await vi.waitFor(() => { expect(watcher.getExpiry()).not.toBeNull() })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(watcher.getExpiry()).toEqual({ kind: 'revoked', message: '已撤销' })
    expect(seen).toEqual([{ kind: 'revoked', message: '已撤销' }])
    watcher.dispose()
  })

  it('连接由 connected 转断开时触发探测', async () => {
    const { source, set } = fakeConnectionState('connected')
    const probe = vi.fn((): Promise<PairingExpiry | null> => Promise.resolve({ kind: 'blocked', message: '已关闭' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    expect(probe).not.toHaveBeenCalled()
    set('disconnected')
    await vi.waitFor(() => { expect(watcher.getExpiry()).toEqual({ kind: 'blocked', message: '已关闭' }) })
    expect(probe).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('失效是终态：结论落地后状态再变化不再探测', async () => {
    const { source, set } = fakeConnectionState('disconnected')
    const probe = vi.fn((): Promise<PairingExpiry | null> => Promise.resolve({ kind: 'unpaired', message: '失效' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    await vi.waitFor(() => { expect(watcher.getExpiry()).not.toBeNull() })
    expect(probe).toHaveBeenCalledTimes(1)
    set('disconnected')
    expect(probe).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('探测进行中的断开信号被去重，不并发探测', () => {
    const { source, set } = fakeConnectionState('disconnected')
    let resolveProbe!: (value: PairingExpiry | null) => void
    const probe = vi.fn((): Promise<PairingExpiry | null> => new Promise((resolve) => { resolveProbe = resolve }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    expect(probe).toHaveBeenCalledTimes(1)
    set('connecting')
    expect(probe).toHaveBeenCalledTimes(1)
    resolveProbe(null)
    watcher.dispose()
  })

  it('探测返回时连接已恢复则丢弃过时结论', async () => {
    const { source, set } = fakeConnectionState('disconnected')
    let resolveProbe!: (value: PairingExpiry | null) => void
    const probe = vi.fn((): Promise<PairingExpiry | null> => new Promise((resolve) => { resolveProbe = resolve }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    set('connected')
    resolveProbe({ kind: 'unpaired', message: '过时结论' })
    await flushMicrotasks()
    expect(watcher.getExpiry()).toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('探测返回 null 后再次断开信号会重新探测', async () => {
    const { source, set } = fakeConnectionState('disconnected')
    const probe = vi.fn((): Promise<PairingExpiry | null> => Promise.resolve(null))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    await flushMicrotasks()
    expect(probe).toHaveBeenCalledTimes(1)
    set('connecting')
    await flushMicrotasks()
    expect(probe).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })

  it('从未连接成功时 unreachable 结论被忽略', async () => {
    const { source } = fakeConnectionState('disconnected')
    const probe = vi.fn((): Promise<PairingExpiry | null> =>
      Promise.resolve({ kind: 'unreachable', message: '连接已断开' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    await flushMicrotasks()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(watcher.getExpiry()).toBeNull()
    watcher.dispose()
  })

  it('曾连接成功后断开且探测 unreachable 则采纳失效结论', async () => {
    const { source, set } = fakeConnectionState('connected')
    const probe = vi.fn((): Promise<PairingExpiry | null> =>
      Promise.resolve({ kind: 'unreachable', message: '连接已断开' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    expect(probe).not.toHaveBeenCalled()
    set('disconnected')
    await vi.waitFor(() => { expect(watcher.getExpiry()).toEqual({ kind: 'unreachable', message: '连接已断开' }) })
    expect(probe).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('探测挂起无响应时超时收敛为 unreachable', async () => {
    const { source, set } = fakeConnectionState('connected')
    // 永挂的探测模拟对已死端口的 fetch 挂在 TCP 重试上迟迟不失败
    const probe = vi.fn((): Promise<PairingExpiry | null> => new Promise(() => {}))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe, probeTimeoutMs: 10 })
    set('disconnected')
    await vi.waitFor(() => {
      expect(watcher.getExpiry()).toEqual({
        kind: 'unreachable',
        message: '手机访问连接已断开：电脑端可能已关闭手机访问、电脑已关机或网络不可达，请检查后重试。',
      })
    })
    watcher.dispose()
  })

  it('unreachable 失效页期间恢复轮询：代理恢复后失效页卸载并通知监听者', async () => {
    const { source, set } = fakeConnectionState('connected')
    const probe = vi.fn((): Promise<PairingExpiry | null> =>
      Promise.resolve({ kind: 'unreachable', message: '连接已断开' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe, recoveryPollMs: 10 })
    set('disconnected')
    await vi.waitFor(() => { expect(watcher.getExpiry()).toEqual({ kind: 'unreachable', message: '连接已断开' }) })
    const seen: Array<PairingExpiry | null> = []
    watcher.subscribe(() => { seen.push(watcher.getExpiry()) })
    probe.mockResolvedValue(null)
    await vi.waitFor(() => { expect(watcher.getExpiry()).toBeNull() })
    expect(seen).toEqual([null])
    watcher.dispose()
  })

  it('unreachable 失效页期间恢复轮询：闸门改为拒绝则切换为对应终态', async () => {
    const { source, set } = fakeConnectionState('connected')
    const probe = vi.fn((): Promise<PairingExpiry | null> =>
      Promise.resolve({ kind: 'unreachable', message: '连接已断开' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe, recoveryPollMs: 10 })
    set('disconnected')
    await vi.waitFor(() => { expect(watcher.getExpiry()).toEqual({ kind: 'unreachable', message: '连接已断开' }) })
    probe.mockResolvedValue({ kind: 'unpaired', message: '失效' })
    await vi.waitFor(() => { expect(watcher.getExpiry()).toEqual({ kind: 'unpaired', message: '失效' }) })
    watcher.dispose()
  })

  it('unreachable 失效页期间代理仍不可达则保持失效页并持续轮询', async () => {
    const { source, set } = fakeConnectionState('connected')
    const probe = vi.fn((): Promise<PairingExpiry | null> =>
      Promise.resolve({ kind: 'unreachable', message: '连接已断开' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe, recoveryPollMs: 10 })
    set('disconnected')
    await vi.waitFor(() => { expect(watcher.getExpiry()).toEqual({ kind: 'unreachable', message: '连接已断开' }) })
    const callCount = probe.mock.calls.length
    await vi.waitFor(() => { expect(probe.mock.calls.length).toBeGreaterThan(callCount) })
    expect(watcher.getExpiry()).toEqual({ kind: 'unreachable', message: '连接已断开' })
    watcher.dispose()
  })

  it('dispose 后恢复轮询停止', async () => {
    const { source, set } = fakeConnectionState('connected')
    const probe = vi.fn((): Promise<PairingExpiry | null> =>
      Promise.resolve({ kind: 'unreachable', message: '连接已断开' }))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe, recoveryPollMs: 10 })
    set('disconnected')
    await vi.waitFor(() => { expect(watcher.getExpiry()).toEqual({ kind: 'unreachable', message: '连接已断开' }) })
    await vi.waitFor(() => { expect(probe.mock.calls.length).toBeGreaterThan(1) })
    const callCount = probe.mock.calls.length
    watcher.dispose()
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(probe.mock.calls.length).toBe(callCount)
  })

  it('dispose 后状态变化不再探测', () => {
    const { source, set } = fakeConnectionState('connected')
    const probe = vi.fn((): Promise<PairingExpiry | null> => Promise.resolve(null))
    const watcher = new PairingExpiryWatcher({ connectionState: source, probe })
    watcher.dispose()
    set('disconnected')
    expect(probe).not.toHaveBeenCalled()
  })
})
