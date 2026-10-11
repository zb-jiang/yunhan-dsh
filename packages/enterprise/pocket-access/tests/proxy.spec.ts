/**
 * 代理管线行为测试：纯函数判定 + 真实 HTTP/WS 全链路集成。
 *
 * 集成用真实 PairingManager（真 DeviceStore 临时目录）、真实 IdentityChecker /
 * HandshakeManager（可变闭包 deps）、真实上游 http server 与真实 PocketProxyServer，
 * 共享可推进时钟 `clock` 验证限速与心跳时序。
 */
import net from 'node:net'
import { createHash } from 'node:crypto'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceStore } from '../src/state.ts'
import { PairingManager } from '../src/pairing.ts'
import { IdentityChecker, IDENTITY_REJECTION_MESSAGES } from '../src/identity.ts'
import { HandshakeManager } from '../src/handshake.ts'
import {
  KICK_REASON_DESKTOP_SIGNED_OUT,
  KICK_REASON_DEVICE_REVOKED,
  MAX_PORT_ATTEMPTS,
  LAN_DISABLED_MESSAGE,
  PAIRING_ERROR_TEXT,
  PAIRING_REJECTION_MESSAGES,
  PAIR_PATH,
  PocketProxyServer,
  WS_CLOSE_DESKTOP_SIGNED_OUT,
  WS_CLOSE_DEVICE_REVOKED,
  buildWsCloseFrame,
  DENYLIST_EXACT_PATHS,
  DENYLIST_PREFIX,
  extractCookieValue,
  isDenylisted,
  isNavigationRequest,
  isPublicHostBlocked,
  renderHandshakeLimitedPage,
  renderLanDisabledPage,
  renderPairingPage,
  renderRateLimitedPage,
  rewriteRequestHeaders,
  shouldCompressResponse,
  stripDesktopQueryParams,
} from '../src/proxy.ts'
import type { ProxyToggles } from '../src/proxy.ts'

const T0 = 1_700_000_000_000
const clock = T0

/** 标准测试 WS key（RFC 6455 示例值）。 */
const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

let harness: Harness | undefined
const openSockets: net.Socket[] = []

interface ReceivedRequest {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
}

interface HarnessOptions {
  lanEnabled?: boolean
  heartbeatEnabled?: boolean
  heartbeatIntervalMs?: number
  /** 桌面端当前登录员工 id；undefined 表示未登录。默认 'user-alice'。 */
  desktopUserId?: string | undefined
  /** token 解析出的用户 id。默认 'user-alice'。 */
  resolvedUserId?: string
  /** getUserByToken 直接 reject（验证服务不可达）。 */
  resolveReject?: boolean
  /** launch token；null 表示 getLaunchToken reject（connection 未就绪）。默认 'tok-123'。 */
  launchToken?: string | null
  upstreamHandler?: (req: IncomingMessage, res: ServerResponse) => void
  /** false 时不启动上游（upstreamPort 空闲端口，连接必然失败）。 */
  upstreamEnabled?: boolean
  bindPort?: number
  /** upstream 从该端口起找空闲（端口顺延用例避免与顺延区间重叠）。 */
  upstreamPortBase?: number
}

interface Harness {
  server: PocketProxyServer
  port: number
  upstreamPort: number
  received: ReceivedRequest[]
  upstreamHeads: Buffer[]
  pairing: PairingManager
  handshake: HandshakeManager
  getLaunchTokenCalls: () => number
  setDesktopUser: (id: string | undefined) => void
  setResolvedUser: (id: string) => void
  setResolveReject: (value: boolean) => void
  setLaunchToken: (token: string | null) => void
  setLan: (value: boolean) => void
  setHeartbeat: (value: boolean) => void
  dispose: () => Promise<void>
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('无法获取空闲端口'))
        return
      }
      probe.close(() => { resolve(address.port) })
    })
    probe.once('error', reject)
  })
}

function listenOn(server: net.Server, port: number, host: string = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { resolve() })
  })
}

/** 从 base 起顺延找第一个可监听端口。 */
async function listenFromBase(
  base: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  upgradeEcho: boolean,
  onUpgradeHead?: (head: Buffer) => void,
): Promise<{ server: HttpServer; port: number }> {
  const server = createServer(handler)
  if (upgradeEcho) {
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {})
      const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      onUpgradeHead?.(head)
      if (head.length > 0) socket.write(head)
      socket.pipe(socket)
    })
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await listenOn(server, base + attempt)
      return { server, port: base + attempt }
    } catch {
      // EADDRINUSE 顺延
    }
  }
  throw new Error('上游无可监听端口')
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pocket-proxy-'))
  const store = new DeviceStore({ warn: vi.fn() }, path.join(dir, 'devices.json'))
  await store.load()
  const pairing = new PairingManager(store, () => clock)

  let desktopUserId = 'desktopUserId' in options ? options.desktopUserId : 'user-alice'
  let resolvedUserId = options.resolvedUserId ?? 'user-alice'
  let resolveReject = options.resolveReject ?? false
  const identity = new IdentityChecker(
    {
      getCurrentUser: () => (desktopUserId === undefined ? undefined : { id: desktopUserId }),
      getUserByToken: async () => {
        if (resolveReject) throw new Error('验证服务不可达')
        return { id: resolvedUserId }
      },
    },
    () => clock,
  )

  let launchToken: string | null = 'launchToken' in options ? options.launchToken : 'tok-123'
  let launchTokenCalls = 0
  const handshake = new HandshakeManager(
    {
      getLaunchToken: async () => {
        launchTokenCalls += 1
        if (launchToken === null) throw new Error('connection 未就绪')
        return launchToken
      },
    },
    () => clock,
  )

  let lanEnabled = options.lanEnabled ?? true
  let heartbeatEnabled = options.heartbeatEnabled ?? true
  const toggles: ProxyToggles = { lanEnabled: () => lanEnabled, heartbeatEnabled: () => heartbeatEnabled }

  const received: ReceivedRequest[] = []
  const upstreamHeads: Buffer[] = []
  const defaultHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void req
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
  }
  const handler = options.upstreamHandler ?? defaultHandler
  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    received.push({ method: req.method, url: req.url, headers: req.headers })
    handler(req, res)
  }

  let upstreamServer: HttpServer | undefined
  let upstreamPort: number
  if (options.upstreamEnabled === false) {
    upstreamPort = await getFreePort()
  } else {
    const created =
      options.upstreamPortBase === undefined
        ? await listenFromBase(await getFreePort(), requestHandler, true, (head) => { upstreamHeads.push(head) })
        : await listenFromBase(options.upstreamPortBase, requestHandler, true, (head) => { upstreamHeads.push(head) })
    upstreamServer = created.server
    upstreamPort = created.port
  }

  const server = new PocketProxyServer(
    {
      pairing,
      identity,
      handshake,
      toggles,
      audit: { devicePaired: vi.fn(), identityRejected: vi.fn(), lanDisabledHit: vi.fn() },
      logger: { warn: vi.fn() },
    },
    upstreamPort,
    options.bindPort ?? (await getFreePort()),
    options.heartbeatIntervalMs ?? 30_000,
  )
  const port = await server.start()

  return {
    server,
    port,
    upstreamPort,
    received,
    upstreamHeads,
    pairing,
    handshake,
    getLaunchTokenCalls: () => launchTokenCalls,
    setDesktopUser: (id) => {
      desktopUserId = id
    },
    setResolvedUser: (id) => {
      resolvedUserId = id
    },
    setResolveReject: (value) => {
      resolveReject = value
    },
    setLaunchToken: (token) => {
      launchToken = token
    },
    setLan: (value) => {
      lanEnabled = value
    },
    setHeartbeat: (value) => {
      heartbeatEnabled = value
    },
    dispose: async () => {
      await server.dispose()
      if (upstreamServer !== undefined) {
        if (typeof upstreamServer.closeAllConnections === 'function') upstreamServer.closeAllConnections()
        await new Promise<void>((resolve) => {
          upstreamServer.close(() => { resolve() })
        })
      }
      await rmDirRetry(dir)
    },
  }
}

/** 生成配对码并完成配对，返回设备 cookie 的 `name=value` 片段。 */
async function pairAndGetCookie(h: Harness): Promise<string> {
  const { code } = h.pairing.createPairingCode()
  const res = await request(h.port, PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `code=${code}`,
  })
  expect(res.status).toBe(303)
  const setCookie = res.headers['set-cookie']
  if (setCookie === undefined) throw new Error('配对响应缺少 Set-Cookie')
  return setCookie[0]?.split(';')[0] ?? ''
}

interface RequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

function request(
  port: number,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: init.method ?? 'GET', path: requestPath, headers: init.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/**
 * 手写 WS 握手客户端：连接后写握手请求（可选立即追加首帧字节）。
 * 101 响应以 `\r\n\r\n` 分界，其后即 WS 首帧字节，切进 head 返回；
 * 带 body 的拒绝响应等 content-length 收满再 settle，body 留在 responseText；
 * close 兜底，error 静默（由断言判定结果）。
 */
function wsHandshake(
  port: number,
  requestPath: string,
  headers: Record<string, string> = {},
  afterWrite?: Buffer,
): Promise<{ socket: net.Socket; responseText: string; head: Buffer }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${requestPath} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${WS_KEY}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        '\r\n',
      ]
      socket.write(lines.join('\r\n'))
      if (afterWrite !== undefined) socket.write(afterWrite)
    })
    openSockets.push(socket)
    let responseText = ''
    let head: Buffer | null = null
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolve({ socket, responseText, head: head ?? Buffer.alloc(0) })
    }
    socket.on('data', (chunk: Buffer) => {
      if (head !== null) return
      responseText += chunk.toString('utf8')
      const index = responseText.indexOf('\r\n\r\n')
      if (index === -1) return
      if (responseText.startsWith('HTTP/1.1 101')) {
        // 升级响应分界之后是 WS 首帧字节
        head = Buffer.from(responseText.slice(index + 4), 'binary')
        responseText = responseText.slice(0, index)
        settle()
        return
      }
      // 带 body 的拒绝响应：等 content-length 收满再 settle，body 留在 responseText
      const match = /content-length: (\d+)/i.exec(responseText)
      if (match === null) {
        settle()
        return
      }
      if (responseText.length < index + 4 + Number(match[1])) return
      settle()
    })
    socket.on('close', settle)
    socket.on('error', () => {})
  })
}

/** 等待 socket 下行数据中出现匹配字节（挂独立监听器累积）。 */
async function waitForClientBytes(socket: net.Socket, matcher: (buffer: Buffer) => boolean, timeoutMs = 2000): Promise<void> {
  let buffer = Buffer.alloc(0)
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk])
  }
  socket.on('data', onData)
  await vi.waitFor(
    () => {
      expect(matcher(buffer)).toBe(true)
    },
    { timeout: timeoutMs, interval: 10 },
  )
  socket.off('data', onData)
}

function waitForClose(socket: net.Socket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    // close 事件可能在等待帧的轮询间隙已发射（destroy 即关），先查 destroyed 防漏听
    if (socket.destroyed) {
      resolve()
      return
    }
    const timer = setTimeout(() => { reject(new Error('socket 未在时限内关闭')) }, timeoutMs)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 递归删除临时目录；与后台 touchDevice 的原子写盘（open tmp → rename）并发时
 * rm 可能报 ENOTEMPTY/EBUSY（Windows 句柄释放有时序抖动），短暂重试。
 */
async function rmDirRetry(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'ENOTEMPTY' && code !== 'EBUSY')) throw error
      await sleep(50)
    }
  }
}

afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets.length = 0
  await harness?.dispose()
  harness = undefined
})

describe('isDenylisted（管理路由拒绝清单）', () => {
  it('裸根路径与前缀子路径命中', () => {
    expect(isDenylisted(DENYLIST_PREFIX)).toBe(true)
    expect(isDenylisted('/api/enterprise/pocket/status')).toBe(true)
    expect(isDenylisted('/api/enterprise/pocket/pairing?x=1')).toBe(true)
  })

  it('signout 精确命中', () => {
    expect(isDenylisted('/api/enterprise/auth/signout')).toBe(true)
    expect(DENYLIST_EXACT_PATHS.has('/api/enterprise/auth/signout')).toBe(true)
  })

  it('仅前缀相似的路径不误拒', () => {
    expect(isDenylisted('/api/enterprise/pocketX')).toBe(false)
    expect(isDenylisted('/api/enterprise/auth/signoutX')).toBe(false)
    expect(isDenylisted('/api/enterprise/pocket-access/other')).toBe(false)
  })
})

describe('extractCookieValue', () => {
  it('无 Cookie 头返回 undefined', () => {
    expect(extractCookieValue(undefined, 'dsh-pocket-device')).toBeUndefined()
  })

  it('多 cookie 中提取目标值', () => {
    expect(extractCookieValue('a=1; dsh-pocket-device=abc.def; b=2', 'dsh-pocket-device')).toBe('abc.def')
  })

  it('无等号片段跳过', () => {
    expect(extractCookieValue('novalue; name=x', 'name')).toBe('x')
  })

  it('空值返回空串', () => {
    expect(extractCookieValue('name=', 'name')).toBe('')
  })

  it('cookie 名大小写敏感', () => {
    expect(extractCookieValue('Name=1', 'name')).toBeUndefined()
  })
})

describe('isNavigationRequest（导航判定）', () => {
  it('根路径无论 Accept 都算导航', () => {
    expect(isNavigationRequest('/', undefined)).toBe(true)
    expect(isNavigationRequest('/', 'application/json')).toBe(true)
  })

  it('.html 结尾带 query 也算导航', () => {
    expect(isNavigationRequest('/index.html?x=1', undefined)).toBe(true)
    expect(isNavigationRequest('/index.html?x=1', 'application/json')).toBe(true)
  })

  it('Accept 含 text/html 即导航', () => {
    expect(isNavigationRequest('/api/data', 'text/html,application/xhtml+xml')).toBe(true)
  })

  it('API 请求不算导航', () => {
    expect(isNavigationRequest('/api/data', 'application/json')).toBe(false)
    expect(isNavigationRequest('/api/data', undefined)).toBe(false)
  })
})

describe('stripDesktopQueryParams（dsh-desktop-* 清洗）', () => {
  it('剥除 dsh-desktop- 前缀参数并保留其余', () => {
    expect(stripDesktopQueryParams('/index.html?dsh-desktop-port=1234&keep=1')).toBe('/index.html?keep=1')
  })

  it('参数名大小写不敏感', () => {
    expect(stripDesktopQueryParams('/p?DSH-DESKTOP-TAB=main&a=1')).toBe('/p?a=1')
  })

  it('无该前缀时原样保留', () => {
    expect(stripDesktopQueryParams('/plain')).toBe('/plain')
    expect(stripDesktopQueryParams('/p?keep=1&other=2')).toBe('/p?keep=1&other=2')
  })
})

describe('shouldCompressResponse（压缩条件全表）', () => {
  const jsonRes = { headers: { 'content-type': 'application/json; charset=utf-8' } }

  it('客户端接受 br 优先', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': 'gzip, deflate, br' } }, jsonRes)).toBe('br')
  })

  it('仅接受 gzip 时用 gzip', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': 'gzip' } }, jsonRes)).toBe('gzip')
  })

  it('通配符 * 视为 gzip', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': '*' } }, jsonRes)).toBe('gzip')
  })

  it('无 accept-encoding 不压', () => {
    expect(shouldCompressResponse({ headers: {} }, jsonRes)).toBeNull()
  })

  it('上游已压缩不二次压', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': 'br' } }, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } })).toBeNull()
  })

  it('SSE 不压', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': 'br' } }, { headers: { 'content-type': 'text/event-stream' } })).toBeNull()
  })

  it('非 json/text 类型不压', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': 'br' } }, { headers: { 'content-type': 'image/png' } })).toBeNull()
  })

  it('content-length 小于 1024 不压', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': 'br' } }, { headers: { 'content-type': 'application/json', 'content-length': '1023' } })).toBeNull()
  })

  it('content-length 达 1024 压缩', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': 'br' } }, { headers: { 'content-type': 'application/json', 'content-length': '1024' } })).toBe('br')
  })

  it('无 content-length 视为流式可压', () => {
    expect(shouldCompressResponse({ headers: { 'accept-encoding': 'gzip' } }, { headers: { 'content-type': 'text/plain' } })).toBe('gzip')
  })
})

describe('rewriteRequestHeaders（头改写）', () => {
  const incoming = {
    headers: {
      host: '192.168.1.5:3081',
      origin: 'http://192.168.1.5:3081',
      referer: 'http://192.168.1.5:3081/app?a=1',
      'x-custom': 'keep-me',
      'proxy-authorization': 'secret',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'sec-fetch-site': 'cross-site',
    } as IncomingHttpHeaders,
  }

  it('普通请求：重建 loopback 权威四件套，丢弃 hop-by-hop，保留业务头', () => {
    const rewritten = rewriteRequestHeaders(incoming, 4000, false)
    expect(rewritten['host']).toBe('127.0.0.1:4000')
    expect(rewritten['origin']).toBe('http://127.0.0.1:4000')
    expect(rewritten['referer']).toBe('http://127.0.0.1:4000/app?a=1')
    expect(rewritten['sec-fetch-site']).toBe('same-origin')
    expect(rewritten['x-custom']).toBe('keep-me')
    expect(rewritten['proxy-authorization']).toBeUndefined()
    expect(rewritten['transfer-encoding']).toBeUndefined()
    expect(rewritten['connection']).toBeUndefined()
    expect(rewritten['keep-alive']).toBeUndefined()
  })

  it('升级请求：保留 connection/upgrade 供上游握手', () => {
    const rewritten = rewriteRequestHeaders(
      { headers: { host: '192.168.1.5:3081', connection: 'Upgrade', upgrade: 'websocket' } },
      4000,
      true,
    )
    expect(rewritten['connection']).toBe('Upgrade')
    expect(rewritten['upgrade']).toBe('websocket')
    expect(rewritten['host']).toBe('127.0.0.1:4000')
  })

  it('非法 referer 回退为根路径', () => {
    const rewritten = rewriteRequestHeaders({ headers: { referer: 'not-a-url' } }, 4000, false)
    expect(rewritten['referer']).toBe('http://127.0.0.1:4000/')
  })
})

describe('提示页与错误文案', () => {
  it('配对引导页无错误时不渲染 error 段', () => {
    const page = renderPairingPage(null)
    expect(page).toContain('输入桌面端 DSH')
    expect(page).toContain('配对码 5 分钟内有效')
    expect(page).not.toContain('class="error"')
  })

  it('配对引导页渲染错误文案', () => {
    expect(renderPairingPage('出错了')).toContain('class="error">出错了<')
  })

  it('局域网关闭页文案', () => {
    expect(renderLanDisabledPage()).toContain(LAN_DISABLED_MESSAGE)
  })

  it('握手限速页文案', () => {
    expect(renderHandshakeLimitedPage()).toContain('登录握手过于频繁')
  })

  it('配对限速页含重试秒数', () => {
    expect(renderRateLimitedPage(42)).toContain('42 秒后重试')
  })

  it('配对错误文案三键齐全', () => {
    expect(PAIRING_ERROR_TEXT['invalid-code']).toContain('配对码不正确')
    expect(PAIRING_ERROR_TEXT['no-active-code']).toContain('没有有效的配对码')
    expect(PAIRING_ERROR_TEXT['max-devices']).toContain('设备数量已达上限')
  })
})

describe('buildWsCloseFrame（WS close 帧构造）', () => {
  it('FIN+close 帧头，2 字节 BE 状态码 + UTF-8 reason', () => {
    const frame = buildWsCloseFrame(4001, '配对已撤销')
    expect(frame[0]).toBe(0x88)
    expect(frame[1]).toBe(2 + Buffer.byteLength('配对已撤销', 'utf8'))
    expect(frame.readUInt16BE(2)).toBe(4001)
    expect(frame.subarray(4).toString('utf8')).toBe('配对已撤销')
  })

  it('reason 恰 123 字节可行（payload 上限 125）', () => {
    const frame = buildWsCloseFrame(4002, 'x'.repeat(123))
    expect(frame.length).toBe(127)
    expect(frame[1]).toBe(125)
  })

  it('reason 超 123 字节拒绝构造', () => {
    expect(() => buildWsCloseFrame(4001, 'x'.repeat(124))).toThrow(RangeError)
  })
})

describe('isPublicHostBlocked（管线步骤 1 拒绝判定）', () => {
  it('隧道回连豁免：loopback 源 + 公网 verdict 放行', () => {
    expect(isPublicHostBlocked('public', 'loopback')).toBe(false)
  })

  it('LAN 源伪造公网 Host 拒绝', () => {
    expect(isPublicHostBlocked('public', 'lan')).toBe(true)
  })

  it('裸公网源拒绝（无论 Host 声明，policyHost 源覆盖后 verdict=public）', () => {
    expect(isPublicHostBlocked('public', 'public')).toBe(true)
  })

  it('非公网 verdict 一律放行', () => {
    expect(isPublicHostBlocked('loopback', 'loopback')).toBe(false)
    expect(isPublicHostBlocked('lan', 'lan')).toBe(false)
  })
})

describe('HTTP 全链路集成', () => {
  it('隧道流量签名（loopback 源 + 公网 Host）放行进入闸门一', async () => {
    harness = await createHarness()
    const res = await request(harness.port, '/', {
      headers: { host: 'random-words.trycloudflare.com', accept: 'text/html' },
    })
    expect(res.status).toBe(200)
    expect(res.body.toString('utf8')).toContain('输入桌面端 DSH')
    expect(harness.received).toHaveLength(0)
  })

  it('隧道流量签名配对后正常透传上游', async () => {
    harness = await createHarness()
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/hello', {
      headers: { cookie, host: 'random-words.trycloudflare.com' },
    })
    expect(res.status).toBe(200)
    expect(harness.received[0]?.url).toBe('/api/hello')
  })

  it('LAN Host + loopback 源不误拒：进入闸门一返回 pairing-required', async () => {
    harness = await createHarness()
    const res = await request(harness.port, '/api/x', { headers: { host: '192.168.1.5:3081' } })
    expect(res.status).toBe(401)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: PAIRING_REJECTION_MESSAGES.unpaired, code: 'device-unpaired' })
  })

  it('denylist 管理路由 403 且不透传', async () => {
    harness = await createHarness()
    const cookie = await pairAndGetCookie(harness)
    const pocketRes = await request(harness.port, '/api/enterprise/pocket/status', { headers: { cookie } })
    expect(pocketRes.status).toBe(403)
    const signoutRes = await request(harness.port, '/api/enterprise/auth/signout', { headers: { cookie } })
    expect(signoutRes.status).toBe(403)
    expect(harness.received).toHaveLength(0)
  })

  it('denylist 相似路径不受影响：无 cookie 走闸门一 401', async () => {
    harness = await createHarness()
    const pocketX = await request(harness.port, '/api/enterprise/pocketX')
    expect(pocketX.status).toBe(401)
    expect(JSON.parse(pocketX.body.toString('utf8'))).toEqual({ error: PAIRING_REJECTION_MESSAGES.unpaired, code: 'device-unpaired' })
    const signoutX = await request(harness.port, '/api/enterprise/auth/signoutX')
    expect(signoutX.status).toBe(401)
  })

  it('无设备 cookie：导航回 200 引导页、API 回 401 JSON', async () => {
    harness = await createHarness()
    const nav = await request(harness.port, '/', { headers: { accept: 'text/html' } })
    expect(nav.status).toBe(200)
    expect(nav.headers['content-type']).toContain('text/html')
    expect(nav.body.toString('utf8')).toContain('输入桌面端 DSH')
    const api = await request(harness.port, '/api/x')
    expect(api.status).toBe(401)
    expect(JSON.parse(api.body.toString('utf8'))).toEqual({ error: PAIRING_REJECTION_MESSAGES.unpaired, code: 'device-unpaired' })
  })

  it('配对全流程：POST 配对 → 设备 cookie → API 转发 → 导航注入 token', async () => {
    harness = await createHarness()
    const { code } = harness.pairing.createPairingCode()
    const pairRes = await request(harness.port, PAIR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${code}`,
    })
    expect(pairRes.status).toBe(303)
    expect(pairRes.headers.location).toBe('/')
    const setCookie = pairRes.headers['set-cookie']
    expect(setCookie?.[0]).toContain('dsh-pocket-device=')
    expect(setCookie?.[0]).toContain('HttpOnly')
    const cookie = setCookie?.[0]?.split(';')[0] ?? ''

    const apiRes = await request(harness.port, '/api/hello', { headers: { cookie } })
    expect(apiRes.status).toBe(200)
    expect(harness.received[0]?.url).toBe('/api/hello')

    const navRes = await request(harness.port, '/', { headers: { cookie } })
    expect(navRes.status).toBe(200)
    expect(harness.received[1]?.url).toBe('/?token=tok-123')
  })

  it('错误配对码返回引导页与 invalid-code 文案', async () => {
    harness = await createHarness()
    harness.pairing.createPairingCode()
    const res = await request(harness.port, PAIR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=WRONG234',
    })
    expect(res.status).toBe(200)
    expect(res.body.toString('utf8')).toContain(PAIRING_ERROR_TEXT['invalid-code'])
  })

  it('无参访问配对端点返回引导页', async () => {
    harness = await createHarness()
    const res = await request(harness.port, PAIR_PATH)
    expect(res.status).toBe(200)
    expect(res.body.toString('utf8')).not.toContain('class="error"')
  })

  it('已配对设备访问配对端点直接 303 回根', async () => {
    harness = await createHarness()
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, PAIR_PATH, { headers: { cookie } })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/')
  })

  it('单 IP 5 次错码后锁定，正确码也 429', async () => {
    harness = await createHarness()
    const { code } = harness.pairing.createPairingCode()
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await request(harness.port, PAIR_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'code=WRONG234',
      })
      expect(res.status).toBe(200)
    }
    const res = await request(harness.port, PAIR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${code}`,
    })
    expect(res.status).toBe(429)
    expect(res.body.toString('utf8')).toContain('尝试过于频繁')
  })

  it('闸门二：他人 token 403 identity-mismatch 且不透传上游', async () => {
    harness = await createHarness({ resolvedUserId: 'user-bob' })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/x', { headers: { cookie, authorization: 'Bearer some-token' } })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: IDENTITY_REJECTION_MESSAGES['identity-mismatch'] })
    expect(harness.received).toHaveLength(0)
  })

  it('闸门二：同账号 token 放行转发', async () => {
    harness = await createHarness()
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/x', { headers: { cookie, authorization: 'Bearer some-token' } })
    expect(res.status).toBe(200)
    expect(harness.received[0]?.url).toBe('/api/x')
  })

  it('闸门二：token 验证服务失败统一 403 identity-mismatch', async () => {
    harness = await createHarness({ resolveReject: true })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/x', { headers: { cookie, authorization: 'Bearer some-token' } })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: IDENTITY_REJECTION_MESSAGES['identity-mismatch'] })
  })

  it('闸门二：桌面端未登录 403 desktop-login-required', async () => {
    harness = await createHarness({ desktopUserId: undefined })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/x', { headers: { cookie, authorization: 'Bearer some-token' } })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: IDENTITY_REJECTION_MESSAGES['desktop-login-required'] })
  })

  it('头改写集成：上游收到 loopback 权威与 same-site 栅栏', async () => {
    harness = await createHarness()
    const cookie = await pairAndGetCookie(harness)
    await request(harness.port, '/api/x', {
      headers: {
        cookie,
        origin: 'http://192.168.1.5:3081',
        referer: 'http://192.168.1.5:3081/page?x=1',
        'x-custom': 'keep-me',
      },
    })
    const upstreamHeaders = harness.received[0]?.headers ?? {}
    expect(upstreamHeaders['host']).toBe(`127.0.0.1:${harness.upstreamPort}`)
    expect(upstreamHeaders['origin']).toBe(`http://127.0.0.1:${harness.upstreamPort}`)
    expect(upstreamHeaders['referer']).toBe(`http://127.0.0.1:${harness.upstreamPort}/page?x=1`)
    expect(upstreamHeaders['sec-fetch-site']).toBe('same-origin')
    expect(upstreamHeaders['x-custom']).toBe('keep-me')
  })

  it('dsh-desktop-* query 清洗集成（大小写不敏感）', async () => {
    harness = await createHarness()
    const cookie = await pairAndGetCookie(harness)
    await request(harness.port, '/index.html?DSH-DESKTOP-PORT=1234&dsh-desktop-tab=main&keep=1', { headers: { cookie } })
    expect(harness.received[0]?.url).toBe('/index.html?keep=1')
  })

  it('launch token 取用失败不注入直接转发并记 warn', async () => {
    harness = await createHarness({ launchToken: null })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(harness.received[0]?.url).toBe('/')
    expect(harness.getLaunchTokenCalls()).toBe(1)
  })

  it('注入限速：3 次注入后第 4 次导航 503，getLaunchToken 恰 3 次调用', async () => {
    harness = await createHarness()
    const cookie = await pairAndGetCookie(harness)
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await request(harness.port, '/', { headers: { cookie } })
      expect(res.status).toBe(200)
      expect(harness.received[attempt]?.url).toBe('/?token=tok-123')
    }
    const limited = await request(harness.port, '/', { headers: { cookie } })
    expect(limited.status).toBe(503)
    expect(limited.body.toString('utf8')).toContain('登录握手过于频繁')
    expect(harness.getLaunchTokenCalls()).toBe(3)
  })

  it('Safari 过渡页：已注入的上游 303 改写为 200 并保留 Set-Cookie', async () => {
    harness = await createHarness({
      upstreamHandler: (_req, res) => {
        res.writeHead(303, { location: '/dashboard', 'set-cookie': 'dsh-auth-abc=xyz; Path=/' })
        res.end()
      },
    })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers['set-cookie']?.[0]).toContain('dsh-auth-abc=xyz')
    expect(res.headers.location).toBeUndefined()
    expect(res.body.toString('utf8')).toContain('http-equiv="refresh"')
  })

  it('上游不可达返回 502 提示', async () => {
    harness = await createHarness({ upstreamEnabled: false })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/x', { headers: { cookie } })
    expect(res.status).toBe(502)
    expect(res.body.toString('utf8')).toContain('未就绪')
  })

  it('lanEnabled=false 不影响 loopback 来源访问', async () => {
    harness = await createHarness({ lanEnabled: false })
    const res = await request(harness.port, '/api/x')
    expect(res.status).toBe(401)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: PAIRING_REJECTION_MESSAGES.unpaired, code: 'device-unpaired' })
  })

  it('bindPort 被占用时自顺延到下一个可用端口', async () => {
    const base = await getFreePort()
    const blocker1 = net.createServer()
    const blocker2 = net.createServer()
    // 与 proxy.start() 同绑 0.0.0.0，同地址同端口才会触发 EADDRINUSE 顺延
    await listenOn(blocker1, base, '0.0.0.0')
    await listenOn(blocker2, base + 1, '0.0.0.0')
    try {
      const created = await createHarness({ bindPort: base, upstreamPortBase: base + 50 })
      harness = created
      expect(created.port).toBe(base + 2)
      expect(MAX_PORT_ATTEMPTS).toBe(10)
    } finally {
      blocker1.close()
      blocker2.close()
    }
  })

  it('brotli 压缩集成：content-encoding br 且可解压', async () => {
    const payload = JSON.stringify({ ok: true, data: 'x'.repeat(2000) })
    harness = await createHarness({
      upstreamHandler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) })
        res.end(payload)
      },
    })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/big', { headers: { cookie, 'accept-encoding': 'br, gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers['content-length']).toBeUndefined()
    expect(brotliDecompressSync(res.body).toString('utf8')).toBe(payload)
  })

  it('gzip 压缩集成：仅接受 gzip 时用 gzip', async () => {
    const payload = JSON.stringify({ ok: true, data: 'x'.repeat(2000) })
    harness = await createHarness({
      upstreamHandler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) })
        res.end(payload)
      },
    })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/big', { headers: { cookie, 'accept-encoding': 'gzip' } })
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(res.body).toString('utf8')).toBe(payload)
  })

  it('SSE 响应不压缩', async () => {
    harness = await createHarness({
      upstreamHandler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: hello\n\n')
      },
    })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/stream', { headers: { cookie, 'accept-encoding': 'br, gzip' } })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body.toString('utf8')).toContain('data: hello')
  })

  it('小响应（<1024B 显式 content-length）不压缩', async () => {
    harness = await createHarness({
      upstreamHandler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '13' })
        res.end('{"tiny":true}')
      },
    })
    const cookie = await pairAndGetCookie(harness)
    const res = await request(harness.port, '/api/tiny', { headers: { cookie, 'accept-encoding': 'br, gzip' } })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body.toString('utf8')).toBe('{"tiny":true}')
  })
})

describe('WS 升级集成', () => {
  it('101 回传 Sec-WebSocket-Accept，head 字节随请求尾到达上游', async () => {
    const headBytes = Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63])
    harness = await createHarness()
    const cookie = await pairAndGetCookie(harness)
    const { socket, responseText } = await wsHandshake(harness.port, '/ws', { cookie }, headBytes)
    try {
      expect(responseText).toContain('101')
      expect(responseText).toContain('sec-websocket-accept:')
      await vi.waitFor(
        () => {
          expect(harness?.upstreamHeads).toHaveLength(1)
        },
        { timeout: 2000, interval: 10 },
      )
      expect(harness?.upstreamHeads[0]?.equals(headBytes)).toBe(true)
      // 回环验证：settle 后再发一帧，上游 echo 回客户端
      socket.write(Buffer.from([0x81, 0x01, 0x7a]))
      await waitForClientBytes(socket, buffer => buffer.indexOf(Buffer.from([0x81, 0x01, 0x7a])) !== -1)
    } finally {
      socket.destroy()
    }
  })

  it('无凭据 WS 升级回裸 401 配对引导文案', async () => {
    harness = await createHarness()
    const { socket, responseText } = await wsHandshake(harness.port, '/ws')
    try {
      expect(responseText).toContain('401')
      expect(responseText).toContain(PAIRING_REJECTION_MESSAGES.unpaired)
    } finally {
      socket.destroy()
    }
  })

  it('WS query 配对码：101 + Set-Cookie 签发设备 cookie', async () => {
    harness = await createHarness()
    const { code } = harness.pairing.createPairingCode()
    const { socket, responseText } = await wsHandshake(harness.port, `/ws?code=${code}`)
    try {
      expect(responseText).toContain('101')
      expect(responseText).toContain('dsh-pocket-device=')
    } finally {
      socket.destroy()
    }
  })

  it('WS 携带他人 Bearer 回裸 403 identity-mismatch', async () => {
    harness = await createHarness({ resolvedUserId: 'user-bob' })
    const cookie = await pairAndGetCookie(harness)
    const { socket, responseText } = await wsHandshake(harness.port, '/ws', {
      cookie,
      authorization: 'Bearer some-token',
    })
    try {
      expect(responseText).toContain('403')
      expect(responseText).toContain(IDENTITY_REJECTION_MESSAGES['identity-mismatch'])
    } finally {
      socket.destroy()
    }
  })

  it('心跳：静默连接在两个周期后被断开', async () => {
    harness = await createHarness({ heartbeatIntervalMs: 25 })
    const cookie = await pairAndGetCookie(harness)
    const { socket } = await wsHandshake(harness.port, '/ws', { cookie })
    try {
      await waitForClientBytes(socket, buffer => buffer.indexOf(Buffer.from([0x89, 0x00])) !== -1)
      await waitForClose(socket)
      expect(socket.readyState).toBe('closed')
    } finally {
      socket.destroy()
    }
  })

  it('心跳：持续入站的连接保活不被断开', async () => {
    harness = await createHarness({ heartbeatIntervalMs: 25 })
    const cookie = await pairAndGetCookie(harness)
    const { socket } = await wsHandshake(harness.port, '/ws', { cookie })
    const keepAlive = setInterval(() => {
      if (!socket.destroyed) socket.write(Buffer.from([0x81, 0x01, 0x7a]))
    }, 10)
    try {
      // 首帧 echo 回环（证明隧道双向通畅），再静置观察不被心跳断开
      await waitForClientBytes(socket, buffer => buffer.indexOf(Buffer.from([0x81, 0x01, 0x7a])) !== -1)
      await sleep(150)
      expect(socket.destroyed).toBe(false)
    } finally {
      clearInterval(keepAlive)
      socket.destroy()
    }
  })

  it('heartbeatEnabled=false 不注入心跳，连接保持', async () => {
    harness = await createHarness({ heartbeatEnabled: false, heartbeatIntervalMs: 25 })
    const cookie = await pairAndGetCookie(harness)
    const { socket } = await wsHandshake(harness.port, '/ws', { cookie })
    try {
      await sleep(120)
      expect(socket.destroyed).toBe(false)
    } finally {
      socket.destroy()
    }
  })

  it('踢连接：撤销配对后仅该设备隧道收到 close 帧并断开，重连被拒', async () => {
    harness = await createHarness()
    const cookieA = await pairAndGetCookie(harness)
    const cookieB = await pairAndGetCookie(harness)
    const deviceIdA = cookieA.split('=')[1]?.split('.')[0] ?? ''
    const tunnelA = await wsHandshake(harness.port, '/ws', { cookie: cookieA })
    const tunnelB = await wsHandshake(harness.port, '/ws', { cookie: cookieB })
    try {
      expect(tunnelA.responseText).toContain('101')
      expect(tunnelB.responseText).toContain('101')
      // 撤销前两隧道都存活：A echo 回环验证
      tunnelA.socket.write(Buffer.from([0x81, 0x01, 0x61]))
      await waitForClientBytes(tunnelA.socket, buffer => buffer.indexOf(Buffer.from([0x81, 0x01, 0x61])) !== -1)

      const revoked = await harness.pairing.revokeDevice(deviceIdA)
      expect(revoked).toBe(true)
      harness.server.kickDevice(deviceIdA, WS_CLOSE_DEVICE_REVOKED, KICK_REASON_DEVICE_REVOKED)

      // A 收到携带原因的 close 帧后断开
      const closeA = buildWsCloseFrame(WS_CLOSE_DEVICE_REVOKED, KICK_REASON_DEVICE_REVOKED)
      await waitForClientBytes(tunnelA.socket, buffer => buffer.indexOf(closeA) !== -1)
      await waitForClose(tunnelA.socket)

      // B 不受影响：echo 回环仍通
      tunnelB.socket.write(Buffer.from([0x81, 0x01, 0x62]))
      await waitForClientBytes(tunnelB.socket, buffer => buffer.indexOf(Buffer.from([0x81, 0x01, 0x62])) !== -1)

      // A 携原 cookie 重连被闸门一拒绝（401 配对已撤销文案，手机端探测据此渲染失效页）
      const retry = await wsHandshake(harness.port, '/ws', { cookie: cookieA })
      try {
        expect(retry.responseText).toContain('401')
        expect(retry.responseText).toContain(PAIRING_REJECTION_MESSAGES.revoked)
        expect(retry.responseText).toContain('device-revoked')
      } finally {
        retry.socket.destroy()
      }
    } finally {
      tunnelA.socket.destroy()
      tunnelB.socket.destroy()
    }
  })

  it('踢连接：登出 kickAllDevices 后全部隧道收到 close 帧并断开', async () => {
    harness = await createHarness()
    const cookieA = await pairAndGetCookie(harness)
    const cookieB = await pairAndGetCookie(harness)
    const tunnelA = await wsHandshake(harness.port, '/ws', { cookie: cookieA })
    const tunnelB = await wsHandshake(harness.port, '/ws', { cookie: cookieB })
    try {
      expect(harness.server.upgradeSocketCount).toBe(2)
      // kick 同步写出 close 帧，事件循环一圈内即送达：先挂两条隧道的收集器再 kick，
      // 若先 kick 再挂监听，B 的数据会在前一个 await 期间分发完毕、新监听器永远收不到
      const close = buildWsCloseFrame(WS_CLOSE_DESKTOP_SIGNED_OUT, KICK_REASON_DESKTOP_SIGNED_OUT)
      const matchClose = (buffer: Buffer): boolean => buffer.indexOf(close) !== -1
      const closedA = waitForClientBytes(tunnelA.socket, matchClose)
      const closedB = waitForClientBytes(tunnelB.socket, matchClose)
      harness.server.kickAllDevices(WS_CLOSE_DESKTOP_SIGNED_OUT, KICK_REASON_DESKTOP_SIGNED_OUT)
      await closedA
      await closedB
      await waitForClose(tunnelA.socket)
      await waitForClose(tunnelB.socket)
      // vi.waitFor 回调内 narrowing 失效，先取局部快照
      const server = harness.server
      await vi.waitFor(() => { expect(server.upgradeSocketCount).toBe(0) }, { timeout: 2000, interval: 10 })
    } finally {
      tunnelA.socket.destroy()
      tunnelB.socket.destroy()
    }
  })
})
