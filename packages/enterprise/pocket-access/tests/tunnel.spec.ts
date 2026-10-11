/**
 * 公网隧道层单元测试（pocket-access-design M3 §9）：argv 构造、URL 正则、
 * hostname 归一化、失败摘要、二进制解析（配置路径直通 / PATH 探测 / 缺失报错）、
 * Token/标记存储、TunnelManager 生命周期（单飞、stop/start 竞态、意外退出、
 * 自动恢复）与就绪等待。
 *
 * 子进程经 TunnelSubprocessStub 替身注入：手控 done settle 与流推送，
 * 显式 cloudflaredPath 绕过 PATH 探测；PATH 探测结果由替身字段控制。
 *
 * @module tests/tunnel
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import {
  TUNNEL_URL_PATTERN,
  TunnelManager,
  TunnelMarkerStore,
  TunnelRequestError,
  TunnelTokenStore,
  normalizeTunnelHostname,
  resolveCloudflaredBinary,
  summarizeTunnelFailure,
  tunnelArgv,
  waitForTunnelReady,
} from '../src/tunnel.ts'
import type { TunnelLogger, TunnelManagerOptions } from '../src/tunnel.ts'

const WAIT = { timeout: 2000, interval: 10 } as const

/** FakeHandle 在 SubprocessHandle 之上的测试操控面。 */
interface FakeHandle extends SubprocessHandle {
  emitStdout(chunk: string): void
  emitStderr(chunk: string): void
  /** 以给定退出事实 settle done（未 settle 时）并关闭输出流。 */
  exit(outcome: SubprocessOutcome): void
  /** 以错误 reject done（模拟 spawn/provider 失败）。 */
  failSpawn(error: Error): void
  terminated: boolean
}

function makeFakeHandle(): FakeHandle {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  let settled = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const handle: FakeHandle = {
    stdin: undefined,
    stdout,
    stderr,
    control: undefined,
    collected: {},
    done,
    terminated: false,
    terminate(): void {
      handle.terminated = true
      if (!settled) {
        settled = true
        resolveDone({ exitCode: null, signal: 'SIGTERM' })
      }
    },
    waitForExit: () => Promise.resolve(true),
    emitStdout(chunk) {
      stdout.push(chunk)
    },
    emitStderr(chunk) {
      stderr.push(chunk)
    },
    exit(outcome) {
      if (settled) return
      settled = true
      stdout.push(null)
      stderr.push(null)
      resolveDone(outcome)
    },
    failSpawn(error) {
      if (settled) return
      settled = true
      rejectDone(error)
    },
  }
  return handle
}

/** SubprocessRuntime 测试替身：记录 spawn spec，测试不触达终端分配。 */
class TunnelSubprocessStub extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  /** 下一次 spawn 同步抛出的错误（单次生效，模拟 spawn 前置失败）。 */
  nextHandleError: Error | null = null
  /** PATH 探测命中返回的路径；null 模拟 PATH 未命中（resolveExecutable 抛错）。 */
  resolveExecutableResult: string | null = null
  readonly fakes: FakeHandle[] = []

  resolveExecutable(): Promise<string> {
    if (this.resolveExecutableResult === null) {
      throw new Error('PATH 中未找到 cloudflared')
    }
    return Promise.resolve(this.resolveExecutableResult)
  }

  terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    throw new Error('测试替身不检查终端环境')
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    if (this.nextHandleError !== null) {
      const error = this.nextHandleError
      this.nextHandleError = null
      throw error
    }
    const fake = makeFakeHandle()
    this.fakes.push(fake)
    return fake
  }

  spawnTerminal(): Promise<SubprocessTerminalHandle> {
    throw new Error('测试替身不分配终端')
  }

  lastFake(): FakeHandle | undefined {
    return this.fakes[this.fakes.length - 1]
  }
}

let tempDirs: string[] = []

afterEach(async () => {
  const dirs = tempDirs
  tempDirs = []
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pocket-access-tunnel-'))
  tempDirs.push(dir)
  return dir
}

async function makeHarness(overrides: Partial<TunnelManagerOptions> = {}) {
  const dir = await makeTempDir()
  const tokenPath = path.join(dir, 'tunnel-token.json')
  const markerPath = path.join(dir, 'tunnel-marker.json')
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies TunnelLogger
  const tokenStore = new TunnelTokenStore(logger, tokenPath)
  const markerStore = new TunnelMarkerStore(markerPath)
  const runtime = new TunnelSubprocessStub(new Context())
  const options: TunnelManagerOptions = {
    subprocess: runtime,
    logger,
    mode: () => 'quick',
    hostname: () => 'dsh.example.com',
    cloudflaredPath: () => '/opt/cloudflared-fake',
    proxyRunning: () => true,
    proxyPort: () => 3081,
    tokenStore,
    markerStore,
    ...overrides,
  }
  return {
    manager: new TunnelManager(options),
    runtime,
    logger,
    options,
    tokenStore,
    markerStore,
    tokenPath,
    markerPath,
  }
}

type Harness = Awaited<ReturnType<typeof makeHarness>>

/** 拉起隧道到 running：注入就绪输出并等待 start 完成。 */
async function startReady(h: Harness, readyOutput: string): Promise<void> {
  const startPromise = h.manager.start({ disclaimer: true })
  await vi.waitFor(() => {
    expect(h.runtime.specs).toHaveLength(1)
  }, WAIT)
  h.runtime.lastFake()!.emitStdout(readyOutput)
  await expect(startPromise).resolves.toBeUndefined()
  expect(h.manager.state).toBe('running')
}

describe('tunnelArgv', () => {
  it('quick 模式回源本地代理端口', () => {
    expect(tunnelArgv('/usr/bin/cloudflared', 'quick', 3081)).toEqual([
      '/usr/bin/cloudflared',
      '--no-autoupdate',
      'tunnel',
      '--url',
      'http://127.0.0.1:3081',
      '--protocol',
      'http2',
    ])
  })

  it('named 模式走 run 子命令，token 不出现在 argv', () => {
    expect(tunnelArgv('/usr/bin/cloudflared', 'named', 3081)).toEqual([
      '/usr/bin/cloudflared',
      '--no-autoupdate',
      'tunnel',
      'run',
      '--protocol',
      'http2',
    ])
  })
})

describe('TUNNEL_URL_PATTERN', () => {
  it('命中标准快速隧道 URL', () => {
    const line = '|  https://random-words-here.trycloudflare.com  |'
    expect(TUNNEL_URL_PATTERN.exec(line)?.[0]).toBe('https://random-words-here.trycloudflare.com')
  })

  it('不命中 api.trycloudflare.com', () => {
    expect(TUNNEL_URL_PATTERN.exec('https://api.trycloudflare.com/quick-tunnel')).toBeNull()
  })

  it('混合输出中跳过 api 命中真实 URL', () => {
    const text = 'connect https://api.trycloudflare.com then https://real-name-1.trycloudflare.com'
    expect(TUNNEL_URL_PATTERN.exec(text)?.[0]).toBe('https://real-name-1.trycloudflare.com')
  })
})

describe('normalizeTunnelHostname', () => {
  it.each([
    ['Tunnel.Example.COM', 'tunnel.example.com'],
    ['  spaced.example.com  ', 'spaced.example.com'],
    ['https://tunnel.example.com/extra/path', 'tunnel.example.com'],
    ['http://Tunnel.Example.com:8443', 'tunnel.example.com'],
    ['example.com:8443', 'example.com'],
    ['a.b', 'a.b'],
  ])('归一化：%s → %s', (raw, expected) => {
    expect(normalizeTunnelHostname(raw)).toBe(expected)
  })

  it.each([
    [''],
    ['   '],
    ['localhost'],
    ['192.168.1.1'],
    ['bad!.example.com'],
    ['-bad.example.com'],
    ['bad-.example.com'],
  ])('拒绝不合法地址：%s', (raw) => {
    expect(normalizeTunnelHostname(raw)).toBeNull()
  })
})

describe('summarizeTunnelFailure', () => {
  it('参数错误行优先单独返回', () => {
    const output = ['2026-10-10 INF Starting tunnel', 'flag provided but not defined: -bogus', 'line three', 'line four', 'line five'].join('\n')
    expect(summarizeTunnelFailure(output)).toBe('flag provided but not defined: -bogus')
  })

  it('无参数错误取尾部 4 行', () => {
    expect(summarizeTunnelFailure(['one', 'two', 'three', 'four', 'five'].join('\n'))).toBe('two | three | four | five')
  })

  it('摘要超过 500 字符截断', () => {
    expect(summarizeTunnelFailure('x'.repeat(600))).toHaveLength(500)
  })

  it('空输入返回空串', () => {
    expect(summarizeTunnelFailure('')).toBe('')
  })
})

describe('resolveCloudflaredBinary', () => {
  it('显式配置路径直通返回（trim 后），不做 PATH 探测', async () => {
    const h = await makeHarness()
    const resolved = await resolveCloudflaredBinary({
      configuredPath: '  /opt/cloudflared-fake  ',
      subprocess: h.runtime,
      logger: h.logger,
    })
    expect(resolved).toBe('/opt/cloudflared-fake')
  })

  it("'' 走 PATH 探测命中时返回探测路径", async () => {
    const h = await makeHarness()
    h.runtime.resolveExecutableResult = 'C:\\tools\\cloudflared.exe'
    const resolved = await resolveCloudflaredBinary({ configuredPath: '', subprocess: h.runtime, logger: h.logger })
    expect(resolved).toBe('C:\\tools\\cloudflared.exe')
  })

  it("'' 且 PATH 未命中抛 TunnelRequestError，消息含手工安装指引", async () => {
    const h = await makeHarness()
    await expect(
      resolveCloudflaredBinary({ configuredPath: '', subprocess: h.runtime, logger: h.logger }),
    ).rejects.toThrow(/未在 PATH 中找到 cloudflared/)
    await expect(
      resolveCloudflaredBinary({ configuredPath: '', subprocess: h.runtime, logger: h.logger }),
    ).rejects.toThrow(TunnelRequestError)
    expect(h.logger.info).toHaveBeenCalled()
  })
})

describe('TunnelTokenStore', () => {
  it('set 后新实例 load 恢复 token 且落盘内容精确', async () => {
    const h = await makeHarness()
    await h.tokenStore.set('eye-jay-token-123')
    expect(await readFile(h.tokenPath, 'utf8')).toBe(`${JSON.stringify({ token: 'eye-jay-token-123' }, null, 2)}\n`)
    const fresh = new TunnelTokenStore(h.logger, h.tokenPath)
    await fresh.load()
    expect(fresh.hasToken()).toBe(true)
    expect(fresh.currentToken()).toBe('eye-jay-token-123')
  })

  it('set 空白 token 抛 TunnelRequestError 且不落盘', async () => {
    const h = await makeHarness()
    await expect(h.tokenStore.set('   ')).rejects.toThrow(TunnelRequestError)
    await expect(stat(h.tokenPath)).rejects.toThrow()
  })

  it('损坏 JSON 载入时告警并忽略', async () => {
    const h = await makeHarness()
    await writeFile(h.tokenPath, '{not-json')
    await h.tokenStore.load()
    expect(h.tokenStore.hasToken()).toBe(false)
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('损坏'))
  })

  it('结构不合法（token 非字符串）告警忽略', async () => {
    const h = await makeHarness()
    await writeFile(h.tokenPath, JSON.stringify({ token: 42 }))
    await h.tokenStore.load()
    expect(h.tokenStore.hasToken()).toBe(false)
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('结构不合法'))
  })

  it('文件缺失静默加载不告警', async () => {
    const h = await makeHarness()
    await h.tokenStore.load()
    expect(h.tokenStore.hasToken()).toBe(false)
    expect(h.logger.warn).not.toHaveBeenCalled()
  })

  it('clear 删除文件且幂等', async () => {
    const h = await makeHarness()
    await h.tokenStore.set('tok')
    await h.tokenStore.clear()
    expect(h.tokenStore.hasToken()).toBe(false)
    await expect(stat(h.tokenPath)).rejects.toThrow()
    await h.tokenStore.clear()
    expect(h.tokenStore.hasToken()).toBe(false)
  })
})

describe('TunnelMarkerStore', () => {
  it('write 后 present 且落盘内容精确', async () => {
    const h = await makeHarness()
    await h.markerStore.write('quick', 42)
    expect(await h.markerStore.present()).toBe(true)
    expect(await readFile(h.markerPath, 'utf8')).toBe(`${JSON.stringify({ mode: 'quick', startedAt: 42 }, null, 2)}\n`)
  })

  it('remove 后 present false 且幂等', async () => {
    const h = await makeHarness()
    await h.markerStore.write('named', 7)
    await h.markerStore.remove()
    expect(await h.markerStore.present()).toBe(false)
    await h.markerStore.remove()
    expect(await h.markerStore.present()).toBe(false)
  })

  it.each([
    ['{broken', '损坏 JSON'],
    [JSON.stringify({ mode: 'other', startedAt: 1 }), 'mode 不合法'],
    [JSON.stringify({ mode: 'quick' }), '缺 startedAt'],
  ])('%s → present false（%s）', async (raw, _reason) => {
    const h = await makeHarness()
    await writeFile(h.markerPath, raw)
    expect(await h.markerStore.present()).toBe(false)
  })

  it('文件缺失 present false', async () => {
    const h = await makeHarness()
    expect(await h.markerStore.present()).toBe(false)
  })
})

describe('TunnelManager.validateStart', () => {
  it('缺 disclaimer 抛 TunnelRequestError', async () => {
    const h = await makeHarness()
    expect(() => h.manager.validateStart({ disclaimer: false, autoRestore: false })).toThrow(TunnelRequestError)
  })

  it('autoRestore 免除 disclaimer 并返回端口与模式', async () => {
    const h = await makeHarness()
    expect(h.manager.validateStart({ disclaimer: false, autoRestore: true })).toEqual({ proxyPort: 3081, mode: 'quick' })
  })

  it('代理未运行抛 TunnelRequestError', async () => {
    const h = await makeHarness({ proxyRunning: () => false })
    expect(() => h.manager.validateStart({ disclaimer: true, autoRestore: false })).toThrow(TunnelRequestError)
  })

  it('代理端口不可用抛 TunnelRequestError', async () => {
    const h = await makeHarness({ proxyPort: () => null })
    expect(() => h.manager.validateStart({ disclaimer: true, autoRestore: false })).toThrow(TunnelRequestError)
  })

  it('named 模式地址无效抛 TunnelRequestError', async () => {
    const h = await makeHarness({ mode: () => 'named', hostname: () => '192.168.1.1' })
    await h.tokenStore.set('tok')
    expect(() => h.manager.validateStart({ disclaimer: true, autoRestore: false })).toThrow(TunnelRequestError)
  })

  it('named 模式缺 token 抛 TunnelRequestError', async () => {
    const h = await makeHarness({ mode: () => 'named' })
    expect(() => h.manager.validateStart({ disclaimer: true, autoRestore: false })).toThrow(TunnelRequestError)
  })

  it('named 全配置通过校验', async () => {
    const h = await makeHarness({ mode: () => 'named' })
    await h.tokenStore.set('tok')
    expect(h.manager.validateStart({ disclaimer: true, autoRestore: false })).toEqual({ proxyPort: 3081, mode: 'named' })
  })

  it('quick 全配置通过校验', async () => {
    const h = await makeHarness()
    expect(h.manager.validateStart({ disclaimer: true, autoRestore: false })).toEqual({ proxyPort: 3081, mode: 'quick' })
  })
})

describe('TunnelManager 生命周期', () => {
  it('手动启动：quick 就绪进入 running，spec 精确且写入标记', async () => {
    const h = await makeHarness()
    const startPromise = h.manager.start({ disclaimer: true })
    await vi.waitFor(() => {
      expect(h.runtime.specs).toHaveLength(1)
    }, WAIT)
    const spec = h.runtime.specs[0]!
    expect(spec.argv).toEqual([...tunnelArgv('/opt/cloudflared-fake', 'quick', 3081)])
    expect(spec.env).toBeUndefined()
    expect(spec.stdio).toEqual({ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    expect(spec.graceMs).toBe(3000)
    expect(spec.cwd).toContain('pocket-access')
    h.runtime.lastFake()!.emitStdout('INF  |  https://fresh-tunnel.trycloudflare.com  |')
    await expect(startPromise).resolves.toBeUndefined()
    expect(h.manager.state).toBe('running')
    expect(h.manager.url).toBe('https://fresh-tunnel.trycloudflare.com')
    expect(await h.markerStore.present()).toBe(true)
  })

  it('named 启动：token 走环境变量不进 argv，stderr 注册行就绪', async () => {
    const h = await makeHarness({ mode: () => 'named' })
    await h.tokenStore.set('eye-jay-token-123')
    const startPromise = h.manager.start({ disclaimer: true })
    await vi.waitFor(() => {
      expect(h.runtime.specs).toHaveLength(1)
    }, WAIT)
    const spec = h.runtime.specs[0]!
    expect(spec.argv).toEqual([...tunnelArgv('/opt/cloudflared-fake', 'named', 3081)])
    expect(spec.argv.join(' ')).not.toContain('eye-jay-token-123')
    expect(spec.env).toEqual({ TUNNEL_TOKEN: 'eye-jay-token-123' })
    h.runtime.lastFake()!.emitStderr('INF Registered tunnel connection connID=abc')
    await expect(startPromise).resolves.toBeUndefined()
    expect(h.manager.state).toBe('running')
    expect(h.manager.url).toBeNull()
  })

  it('并发 start 单飞：复用同一 promise 且只 spawn 一次', async () => {
    const h = await makeHarness()
    const p1 = h.manager.start({ disclaimer: true })
    const p2 = h.manager.start({ disclaimer: false })
    expect(p1).toBe(p2)
    await vi.waitFor(() => {
      expect(h.runtime.specs).toHaveLength(1)
    }, WAIT)
    h.runtime.lastFake()!.emitStdout('https://single-flight.trycloudflare.com ok')
    await expect(p1).resolves.toBeUndefined()
    expect(h.runtime.specs).toHaveLength(1)
  })

  it('启动期间 stop：收敛 idle、终止子进程且不写自动恢复标记', async () => {
    const h = await makeHarness()
    const startPromise = h.manager.start({ disclaimer: true })
    await vi.waitFor(() => {
      expect(h.runtime.specs).toHaveLength(1)
    }, WAIT)
    await h.manager.stop()
    await expect(startPromise).resolves.toBeUndefined()
    expect(h.manager.state).toBe('idle')
    expect(h.manager.url).toBeNull()
    expect(await h.markerStore.present()).toBe(false)
    expect(h.runtime.lastFake()!.terminated).toBe(true)
  })

  it('启动就绪瞬间被 stop 接管：不进入 running 也不写标记', async () => {
    const h = await makeHarness()
    const startPromise = h.manager.start({ disclaimer: true })
    await vi.waitFor(() => {
      expect(h.runtime.specs).toHaveLength(1)
    }, WAIT)
    h.runtime.lastFake()!.emitStdout('https://lost-race.trycloudflare.com ok')
    await h.manager.stop()
    await expect(startPromise).resolves.toBeUndefined()
    expect(h.manager.state).toBe('idle')
    expect(h.manager.url).toBeNull()
    expect(await h.markerStore.present()).toBe(false)
    expect(h.runtime.lastFake()!.terminated).toBe(true)
  })

  it('running 期进程意外退出：error 态携带退出事实并保留标记', async () => {
    const h = await makeHarness()
    await startReady(h, 'https://dying-tunnel.trycloudflare.com ok')
    h.runtime.lastFake()!.exit({ exitCode: 1, signal: null })
    await vi.waitFor(() => {
      expect(h.manager.state).toBe('error')
    }, WAIT)
    const snapshot = h.manager.snapshot(true)
    expect(snapshot.detail).toContain('exit=1 signal=null')
    expect(snapshot.detail).toContain('自动恢复标记')
    expect(await h.markerStore.present()).toBe(true)
  })

  it('running 后手动 stop：删标记、终止进程、收敛 idle', async () => {
    const h = await makeHarness()
    await startReady(h, 'https://stoppable.trycloudflare.com ok')
    await h.manager.stop()
    expect(h.manager.state).toBe('idle')
    expect(h.manager.url).toBeNull()
    expect(h.runtime.lastFake()!.terminated).toBe(true)
    expect(await h.markerStore.present()).toBe(false)
  })

  it('stop 幂等：重复 stop 不抛且保持 idle', async () => {
    const h = await makeHarness()
    await startReady(h, 'https://idempotent-stop.trycloudflare.com ok')
    await h.manager.stop()
    await h.manager.stop()
    expect(h.manager.state).toBe('idle')
    expect(await h.markerStore.present()).toBe(false)
  })

  it('disposeKeepMarker：终止进程但保留自动恢复标记', async () => {
    const h = await makeHarness()
    await startReady(h, 'https://disposed.trycloudflare.com ok')
    await h.manager.disposeKeepMarker()
    expect(h.manager.state).toBe('idle')
    expect(h.runtime.lastFake()!.terminated).toBe(true)
    expect(await h.markerStore.present()).toBe(true)
  })

  it('spawn 失败：error 态、detail 为错误消息且 start promise 拒绝', async () => {
    const h = await makeHarness()
    h.runtime.nextHandleError = new Error('云函数启动失败')
    await expect(h.manager.start({ disclaimer: true })).rejects.toThrow('云函数启动失败')
    expect(h.manager.state).toBe('error')
    expect(h.manager.snapshot(true).detail).toBe('云函数启动失败')
    expect(await h.markerStore.present()).toBe(false)
  })

  it('长噪音输出后 URL 仍在尾部窗口命中', async () => {
    const h = await makeHarness()
    const startPromise = h.manager.start({ disclaimer: true })
    await vi.waitFor(() => {
      expect(h.runtime.specs).toHaveLength(1)
    }, WAIT)
    h.runtime.lastFake()!.emitStdout(`${'noise '.repeat(4000)}\nhttps://window-hit.trycloudflare.com ok\n`)
    await expect(startPromise).resolves.toBeUndefined()
    expect(h.manager.url).toBe('https://window-hit.trycloudflare.com')
  })
})

describe('TunnelManager.autoRestore', () => {
  it('无标记不启动', async () => {
    const h = await makeHarness()
    await h.manager.autoRestore()
    expect(h.runtime.specs).toHaveLength(0)
  })

  it('有标记免 disclaimer 拉起且不重写标记', async () => {
    const h = await makeHarness()
    await h.markerStore.write('quick', 42)
    const restorePromise = h.manager.autoRestore()
    await vi.waitFor(() => {
      expect(h.runtime.specs).toHaveLength(1)
    }, WAIT)
    h.runtime.lastFake()!.emitStdout('https://restored-tunnel.trycloudflare.com ok')
    await expect(restorePromise).resolves.toBeUndefined()
    expect(h.manager.state).toBe('running')
    expect(await readFile(h.markerPath, 'utf8')).toBe(`${JSON.stringify({ mode: 'quick', startedAt: 42 }, null, 2)}\n`)
  })

  it('代理未运行时自动恢复失败：告警、保留标记、不抛出', async () => {
    const h = await makeHarness({ proxyRunning: () => false })
    await h.markerStore.write('quick', 42)
    await expect(h.manager.autoRestore()).resolves.toBeUndefined()
    expect(h.runtime.specs).toHaveLength(0)
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('自动恢复失败'), expect.anything())
    expect(await h.markerStore.present()).toBe(true)
  })
})

describe('waitForTunnelReady', () => {
  it('named 模式 stderr 注册行就绪', async () => {
    const handle = makeFakeHandle()
    const readyPromise = waitForTunnelReady(handle, { mode: 'named', timeoutMs: 1000 })
    handle.emitStderr('INF Registered tunnel connection connID=abc')
    const ready = await readyPromise
    expect(ready.url).toBeNull()
    expect(ready.tail).toContain('Registered tunnel connection')
  })

  it('进程提前退出 reject 携带退出事实', async () => {
    const handle = makeFakeHandle()
    const readyPromise = waitForTunnelReady(handle, { mode: 'quick', timeoutMs: 1000 })
    handle.exit({ exitCode: 1, signal: null })
    await expect(readyPromise).rejects.toThrow('隧道进程提前退出（exit=1 signal=null）')
  })

  it('spawn 失败 reject 携带原因', async () => {
    const handle = makeFakeHandle()
    const readyPromise = waitForTunnelReady(handle, { mode: 'quick', timeoutMs: 1000 })
    handle.failSpawn(new Error('无法创建进程'))
    await expect(readyPromise).rejects.toThrow('隧道进程启动失败：无法创建进程')
  })

  it('超时 reject 携带输出摘要', async () => {
    const handle = makeFakeHandle()
    const readyPromise = waitForTunnelReady(handle, { mode: 'quick', timeoutMs: 20 })
    handle.emitStderr('cloudflared 启动中，还没有 URL')
    await expect(readyPromise).rejects.toThrow(/等待隧道就绪超时（20ms）。输出摘要：cloudflared 启动中/)
  })
})

describe('隧道状态文件权限', () => {
  it('token 与标记文件权限为 0600', async () => {
    if (process.platform === 'win32') return // Windows 忽略 POSIX 权限位
    const h = await makeHarness()
    await h.tokenStore.set('tok')
    await h.markerStore.write('quick', 42)
    expect((await stat(h.tokenPath)).mode & 0o777).toBe(0o600)
    expect((await stat(h.markerPath)).mode & 0o777).toBe(0o600)
  })
})
