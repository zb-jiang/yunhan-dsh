/**
 * 代理核心（pocket-access-design §6.2）：HTTP + WebSocket 全管线。
 *
 * HTTP 管线（顺序即实现顺序）：policyHost → 管理路由 denylist → LAN 开关 →
 * 闸门一（设备 cookie，含本地配对端点）→ 闸门二（Bearer 同账号校验）→
 * 头改写（loopback 权威重建）→ 清洗 `dsh-desktop-*` query → launch token
 * 握手注入 → 上游转发（agent:false 流式，502 兜底）。
 * WS 升级套用同一判定链，head 字节随请求尾发出（mux 协议时序要求），
 * 101 手写回传，双向 pipe + RST teardown + 心跳保活。
 */
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Socket as NetSocket } from 'node:net'
import type { Duplex } from 'node:stream'
import { createBrotliCompress, createGzip, constants as zlibConstants } from 'node:zlib'
import type { PocketAuditSink } from './audit.ts'
import { classifySource, policyHost, resolveClientIp } from './classify.ts'
import type { HostClass } from './classify.ts'
import { DEVICE_COOKIE_NAME, deviceCookieSetCookie } from './pairing.ts'
import type { PairingManager } from './pairing.ts'
import { hasReauthFlag, isHtmlNavigation } from './handshake.ts'
import type { HandshakeManager } from './handshake.ts'
import type { IdentityChecker } from './identity.ts'
import { IDENTITY_REJECTION_MESSAGES } from './identity.ts'

/** 代理本地配对端点路径（不转发上游）。 */
export const PAIR_PATH = '/__pocket/pair'

/** 管理路由拒绝清单（§5.6 管理面隔离；前缀含裸根路径）。 */
export const DENYLIST_PREFIX = '/api/enterprise/pocket'
/** 管理路由精确路径拒绝清单：不落在 DENYLIST_PREFIX 前缀内但仍禁止经代理透传的管理端点（登出）。 */
export const DENYLIST_EXACT_PATHS: ReadonlySet<string> = new Set(['/api/enterprise/auth/signout'])

/** 端口顺延尝试上限（bindPort 起，EADDRINUSE 顺延）。 */
export const MAX_PORT_ATTEMPTS = 10

/** 配对表单/查询 body 字节上限（仅 8 位码，冗余余量防滥用）。 */
const PAIR_BODY_MAX_BYTES = 4096

/**
 * 闸门一 401 对外文案（响应体 error 值，手机端失效页直接渲染），按
 * verifyDeviceCookie 失败原因细分；code 字段同步下发机器可读值。
 */
export const PAIRING_REJECTION_MESSAGES: Readonly<Record<'revoked' | 'unpaired', string>> = {
  revoked: '该设备的配对已被撤销，请重新扫码配对。',
  unpaired: '本设备尚未配对，或电脑端已退出登录导致配对失效，请重新扫码配对。',
}
/** 闸门一 403 对外文案：局域网开关关闭（手机端失效页直接渲染）。 */
export const LAN_DISABLED_MESSAGE = '局域网访问已关闭，请在电脑上的手机访问设置中开启。'

/** WS close 状态码（RFC 6455 私有段 4000-4999）：该设备配对已被撤销。 */
export const WS_CLOSE_DEVICE_REVOKED = 4001
/** WS close 状态码：桌面端已退出登录（signout 清空全部设备）。 */
export const WS_CLOSE_DESKTOP_SIGNED_OUT = 4002
/** WS close 状态码：局域网接入开关关闭（踢掉全部已有隧道，手机端探测 403 渲染失效页）。 */
export const WS_CLOSE_LAN_DISABLED = 4003
/** 踢连接 close reason：配对撤销。 */
export const KICK_REASON_DEVICE_REVOKED = '配对已撤销'
/** 踢连接 close reason：桌面登出。 */
export const KICK_REASON_DESKTOP_SIGNED_OUT = '桌面端已退出登录'
/** 踢连接 close reason：局域网接入关闭。 */
export const KICK_REASON_LAN_DISABLED = '局域网访问已关闭'

/** 压缩下限：小于该字节数的响应不压（§6.2.6）。 */
const COMPRESS_MIN_BYTES = 1024

/** WS 心跳 Ping 帧（RFC 6455 FIN+ping，无载荷）。 */
const WS_PING_FRAME = Buffer.from([0x89, 0x00])

/** 连续零入站心跳周期数达该值即断开（§6.2.3）。 */
const WS_HEARTBEAT_MAX_MISSES = 2

/** 代理行为开关（由 index.ts 按 Config 动态取值）。 */
export interface ProxyToggles {
  /** 局域网接入开关（独立于总开关）。 */
  lanEnabled(): boolean
  /** WS 心跳注入开关。 */
  heartbeatEnabled(): boolean
}

/** 代理依赖面。 */
export interface PocketProxyDeps {
  pairing: PairingManager
  identity: IdentityChecker
  handshake: HandshakeManager
  toggles: ProxyToggles
  /** 审计事件回调面（配对成功 / 身份拒绝 / LAN 关闭被拒）。 */
  audit: PocketAuditSink
  logger: { warn(message?: unknown, ...args: unknown[]): void }
}

/**
 * 管线步骤 1 的拒绝判定：公网 verdict 且源非 loopback 一律拒绝（LAN 设备 / 裸公网源伪造公网 Host）。
 * 隧道回连的 Host 恰是公网域名、源必为 loopback（cloudflared 保留原始 Host 头），豁免放行进入配对闸门。
 *
 * @param verdict - policyHost 对请求 Host 头的分类结果。
 * @param sourceClass - 请求来源地址的分类结果。
 * @returns 公网 Host 且来源非 loopback 时 true（应拒绝）；loopback 来源（含隧道回连）返回 false。
 */
export function isPublicHostBlocked(verdict: HostClass, sourceClass: HostClass): boolean {
  return verdict === 'public' && sourceClass !== 'loopback'
}

/**
 * 管理路由 denylist 判定（按 pathname，容忍 query）。
 *
 * @param pathname - 请求路径（不含 query）。
 * @returns 命中 DENYLIST_EXACT_PATHS 或 DENYLIST_PREFIX 前缀（含裸根）时 true。
 */
export function isDenylisted(pathname: string): boolean {
  if (DENYLIST_EXACT_PATHS.has(pathname)) return true
  return pathname === DENYLIST_PREFIX || pathname.startsWith(`${DENYLIST_PREFIX}/`)
}

/**
 * 从 Cookie 头提取指定 cookie 值。
 *
 * @param cookieHeader - 原始 Cookie 请求头；undefined（头缺失）直接返回 undefined。
 * @param name - 目标 cookie 名（与各段名精确匹配，忽略首尾空白）。
 * @returns 命中的 cookie 值（去首尾空白）；头缺失或无该 cookie 时 undefined。
 */
export function extractCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * 浏览器导航判定：Accept 含 text/html，或 pathname 为 `/` / `.html` 结尾
 * （按 pathname 判以容忍 query；POST 表单提交同属导航）。
 *
 * @param pathWithQuery - 请求原始 URL（含 query）。
 * @param acceptHeader - 请求 Accept 头；undefined 视为不接受 HTML。
 * @returns 导航请求为 true；URL 解析失败且 Accept 未命中时 false。
 */
export function isNavigationRequest(pathWithQuery: string, acceptHeader: string | undefined): boolean {
  if (isHtmlNavigation(acceptHeader)) return true
  try {
    const pathname = new URL(pathWithQuery, 'http://pocket.invalid').pathname
    return pathname === '/' || pathname.endsWith('.html')
  } catch {
    return false
  }
}

/**
 * 清洗 URL 上 `dsh-desktop-*` 前缀 query 参数（历史收藏污染防御），其余原样保留。
 *
 * @param pathWithQuery - 请求原始 URL（含 query）。
 * @returns 移除 `dsh-desktop-*`（大小写不敏感）后的 pathname+search；URL 解析失败时原样返回输入。
 */
export function stripDesktopQueryParams(pathWithQuery: string): string {
  try {
    const url = new URL(pathWithQuery, 'http://pocket.invalid')
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('dsh-desktop-')) url.searchParams.delete(key)
    }
    return url.pathname + url.search
  } catch {
    return pathWithQuery
  }
}

/**
 * 响应压缩判定（§6.2.6 条件全表）：客户端接受 && 上游未压缩 && 非 SSE &&
 * json/text && 无 content-length 或 ≥1024B。返回选用的压缩算法，null 不压。
 *
 * @param req - 客户端请求（读 accept-encoding）。
 * @param upstreamRes - 上游响应（读 content-encoding / content-type / content-length）。
 * @returns 选用的压缩算法，'br' 优先于 'gzip'；任一条件不满足为 null。
 */
export function shouldCompressResponse(
  req: Pick<IncomingMessage, 'headers'>,
  upstreamRes: Pick<IncomingMessage, 'headers'>,
): 'br' | 'gzip' | null {
  const acceptEncoding = req.headers['accept-encoding']
  const accept = typeof acceptEncoding === 'string' ? acceptEncoding : ''
  const contentEncoding = upstreamRes.headers['content-encoding']
  if (contentEncoding !== undefined) return null
  const contentTypeHeader = upstreamRes.headers['content-type']
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : ''
  if (contentType.includes('text/event-stream')) return null
  if (!(contentType.includes('json') || contentType.startsWith('text/'))) return null
  const contentLength = upstreamRes.headers['content-length']
  if (typeof contentLength === 'string' && Number(contentLength) < COMPRESS_MIN_BYTES) return null
  if (accept.includes('br')) return 'br'
  if (accept.includes('gzip') || accept.includes('*')) return 'gzip'
  return null
}

/**
 * 请求头改写：保留业务头，丢弃 hop-by-hop（升级请求除外），重建 loopback 权威四件套。
 *
 * @param req - 客户端原始请求（读 headers）。
 * @param upstreamPort - 上游 webserver 端口（host/origin/referer 重建目标）。
 * @param isUpgrade - 是否 WS 升级请求（升级请求保留 connection/upgrade 头）。
 * @returns 改写后的上游请求头（固定 sec-fetch-site: same-origin）。
 */
export function rewriteRequestHeaders(
  req: Pick<IncomingMessage, 'headers'>,
  upstreamPort: number,
  isUpgrade: boolean,
): OutgoingHttpHeaders {
  const hopByHop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ])
  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === 'host') continue
    if (isUpgrade && (key === 'connection' || key === 'upgrade')) {
      headers[key] = Array.isArray(value) ? value.join(', ') : value
      continue
    }
    if (!isUpgrade && hopByHop.has(key)) continue
    headers[key] = value
  }
  const loopbackAuthority = `127.0.0.1:${upstreamPort}`
  headers['host'] = loopbackAuthority
  const origin = req.headers['origin']
  if (typeof origin === 'string') headers['origin'] = `http://${loopbackAuthority}`
  const referer = req.headers['referer']
  if (typeof referer === 'string') {
    try {
      const parsed = new URL(referer)
      headers['referer'] = `http://${loopbackAuthority}${parsed.pathname}${parsed.search}`
    } catch {
      headers['referer'] = `http://${loopbackAuthority}/`
    }
  }
  // 宿主特权方法栅栏要求；同时防跨 Host 注入。
  headers['sec-fetch-site'] = 'same-origin'
  return headers
}

function headerString(headers: IncomingHttpHeaders, key: string): string | undefined {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

/** 读取请求体（带字节上限，超限返回 null）。 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let overLimit = false
    req.on('data', (chunk: Buffer) => {
      if (overLimit) return
      size += chunk.length
      if (size > maxBytes) {
        overLimit = true
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overLimit) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => { resolve(null) })
  })
}

/** RST 强制关闭（老 Node 无 resetAndDestroy 时退化为 destroy）。 */
function resetAndDestroy(socket: NetSocket): void {
  if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy()
  else socket.destroy()
}

/** WS 升级路径的裸 HTTP 拒绝响应（end 发送后 FIN——write+destroy 可能丢失未 flush 数据）。 */
function writeRawJsonResponse(socket: Duplex, status: number, body: string): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Too Many Requests'
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json; charset=utf-8\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
}

/**
 * 构造服务器→客户端 WS close 帧（RFC 6455；服务端帧不掩码）。
 * payload = 2 字节 BE 状态码 + UTF-8 reason；协议规定 close 载荷上限 125，
 * 故 reason 限 123 字节，帧长单字节足够，无扩展长度分支。
 *
 * @param statusCode - WS close 状态码（含 4000-4999 私有段常量）。
 * @param reason - 关闭原因文案，UTF-8 编码后不得超过 123 字节。
 * @returns 完整 close 帧字节序列。
 * @throws reason 编码后超过 123 字节时抛 RangeError。
 */
export function buildWsCloseFrame(statusCode: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8')
  if (reasonBytes.length > 123) throw new RangeError(`WS close reason 超出 123 字节上限：${reasonBytes.length}`)
  const payload = Buffer.alloc(2 + reasonBytes.length)
  payload.writeUInt16BE(statusCode, 0)
  reasonBytes.copy(payload, 2)
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload])
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: code }))
}

/**
 * 闸门一 401 响应体：error 文案 + 机器可读 code（device-revoked / device-unpaired），
 * 手机端探测 fetch 据此渲染对应失效页；HTTP 与 WS 升级两路径共用。
 */
function pairingRequiredBody(reason: 'revoked' | 'unpaired'): string {
  return JSON.stringify({
    error: PAIRING_REJECTION_MESSAGES[reason],
    code: reason === 'revoked' ? 'device-revoked' : 'device-unpaired',
  })
}

const PAGE_STYLE =
  'body{font-family:system-ui,sans-serif;max-width:360px;margin:48px auto;padding:0 16px;color:#1f2328}' +
  'input{width:100%;box-sizing:border-box;font-size:20px;letter-spacing:4px;text-transform:uppercase;' +
  'padding:10px;border:1px solid #d0d7de;border-radius:8px}' +
  'button{width:100%;margin-top:12px;padding:10px;font-size:16px;background:#1f6feb;color:#fff;border:none;border-radius:8px}' +
  '.error{color:#cf222e;margin-top:12px}.hint{color:#656d76;font-size:14px;margin-top:16px}'

/**
 * 配对引导页（错误文案均为模块常量，不含用户输入，无需转义）。
 *
 * @param errorText - 表单上方展示的错误文案；null 表示不展示错误行。
 * @returns 完整 HTML 页面字符串。
 */
export function renderPairingPage(errorText: string | null): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>DSH 手机访问配对</title>',
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    '<h2>DSH 手机访问</h2>',
    '<p>输入桌面端 DSH「手机访问」设置页生成的 8 位配对码：</p>',
    '<form method="post" action="/__pocket/pair">',
    '<input name="code" autocomplete="off" maxlength="8" placeholder="XXXXXXXX" required>',
    '<button type="submit">配对</button>',
    '</form>',
    ...(errorText === null ? [] : [`<p class="error">${errorText}</p>`]),
    '<p class="hint">配对码 5 分钟内有效且仅可使用一次。</p>',
    '</body>',
    '</html>',
  ].join('\n')
}

/**
 * 局域网访问关闭提示页。
 *
 * @returns 完整 HTML 页面字符串。
 */
export function renderLanDisabledPage(): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>局域网访问已关闭</title>',
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    '<h2>局域网访问已关闭</h2>',
    `<p>${LAN_DISABLED_MESSAGE}</p>`,
    '</body>',
    '</html>',
  ].join('\n')
}

/**
 * 握手重试超限提示页。
 *
 * @returns 完整 HTML 页面字符串。
 */
export function renderHandshakeLimitedPage(): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>登录握手过于频繁</title>',
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    '<h2>登录握手过于频繁</h2>',
    '<p>请稍后重试；建议换用 Chrome / Edge 等 Chromium 浏览器，或通过公网入口访问。</p>',
    '</body>',
    '</html>',
  ].join('\n')
}

/**
 * 配对限速提示页。
 *
 * @param retryAfterSeconds - 页面展示的等待秒数（调用方已向上取整且最小为 1）。
 * @returns 完整 HTML 页面字符串。
 */
export function renderRateLimitedPage(retryAfterSeconds: number): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>尝试过于频繁</title>',
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    '<h2>尝试过于频繁</h2>',
    `<p>配对尝试过于频繁，请 ${retryAfterSeconds} 秒后重试。</p>`,
    '</body>',
    '</html>',
  ].join('\n')
}

/** 配对错误文案。 */
export const PAIRING_ERROR_TEXT: Readonly<Record<'invalid-code' | 'no-active-code' | 'max-devices', string>> = {
  'invalid-code': '配对码不正确，请重新输入。',
  'no-active-code': '当前没有有效的配对码，请在桌面端重新生成。',
  'max-devices': '设备数量已达上限，请先在桌面端吊销一台设备。',
}

/** 活跃 WS 隧道条目：登记所属设备，供撤销配对/登出时踢连接。 */
interface TunnelEntry {
  deviceId: string
  upstreamSocket: NetSocket
  teardown(): void
}

/** 代理服务器：监听、闸门、改写、转发、WS 隧道、心跳与生命周期。 */
export class PocketProxyServer {
  private readonly server = createServer((req, res) => {
    void this.handleRequest(req, res)
  })
  /** WS 升级后的活跃隧道（server.closeAllConnections 不覆盖，需手动清理）。 */
  private readonly tunnels = new Map<Duplex, TunnelEntry>()
  private disposed = false

  constructor(
    private readonly deps: PocketProxyDeps,
    private readonly upstreamPort: number,
    private readonly bindPort: number,
    private readonly heartbeatIntervalMs = 30_000,
  ) {
    this.server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head)
    })
    this.server.on('clientError', (error, socket) => {
      this.deps.logger.warn('pocket-access: 客户端连接异常', error)
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
  }

  /** 实际监听端口（start 成功后可读）。 */
  port: number | null = null

  /**
   * 绑定 0.0.0.0，EADDRINUSE 时自 bindPort 顺延尝试至多 10 个端口；返回实际端口。
   *
   * @returns 实际监听端口（成功后同步写入 port 字段）。
   */
  async start(): Promise<number> {
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = this.bindPort + attempt
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            reject(error)
          }
          this.server.once('error', onError)
          this.server.listen(port, '0.0.0.0', () => {
            this.server.off('error', onError)
            resolve()
          })
        })
        this.port = port
        return port
      } catch (error) {
        lastError = error
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      }
    }
    throw lastError
  }

  /** 生命周期收尾：destroy 全部升级 socket 与普通连接后 close。 */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const socket of this.tunnels.keys()) socket.destroy()
    this.tunnels.clear()
    if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      this.server.close(() => { resolve() })
    })
  }

  /** 测试观察用：当前升级 socket 数。 */
  get upgradeSocketCount(): number {
    return this.tunnels.size
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.processRequest(req, res)
    } catch (error) {
      this.deps.logger.warn('pocket-access: 请求处理异常', error)
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('Bad Request')
    }
  }

  /** 单请求上下文：判定链共用的输入。 */
  private resolveRequestContext(req: IncomingMessage): {
    clientIp: string
    sourceClass: HostClass
    verdict: HostClass
    pathWithQuery: string
    pathname: string
  } {
    const source = req.socket.remoteAddress
    const clientIp = resolveClientIp(source, headerString(req.headers, 'cf-connecting-ip'))
    const pathWithQuery = req.url ?? '/'
    let pathname = pathWithQuery
    try {
      pathname = new URL(pathWithQuery, 'http://pocket.invalid').pathname
    } catch {
      // 非法 URL 保持原值，交由后续判定拒绝
    }
    return {
      clientIp,
      sourceClass: classifySource(source),
      verdict: policyHost(headerString(req.headers, 'host'), source),
      pathWithQuery,
      pathname,
    }
  }

  private async processRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = this.resolveRequestContext(req)

    // 1. policyHost：公网 Host 且源非 loopback 一律拒绝；隧道回连（loopback 源 + 公网 Host）豁免走闸门。
    if (isPublicHostBlocked(ctx.verdict, ctx.sourceClass)) {
      jsonError(res, 403, 'forbidden')
      return
    }

    // 2. 管理路由 denylist：不透传。
    if (isDenylisted(ctx.pathname)) {
      jsonError(res, 403, 'forbidden')
      return
    }

    // 3. 局域网开关：关闭时 LAN 来源一律拒绝（loopback/公网 Host 放行）。
    if (!this.deps.toggles.lanEnabled() && ctx.sourceClass === 'lan') {
      this.deps.audit.lanDisabledHit(ctx.clientIp)
      if (isNavigationRequest(ctx.pathWithQuery, headerString(req.headers, 'accept'))) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(renderLanDisabledPage())
      } else {
        jsonError(res, 403, LAN_DISABLED_MESSAGE)
      }
      return
    }

    // 4. 闸门一：本地配对端点优先处理；无有效设备 cookie → 引导页 / 401（带细分 code）。
    const deviceCookie = extractCookieValue(headerString(req.headers, 'cookie'), DEVICE_COOKIE_NAME)
    const deviceCheck = this.deps.pairing.verifyDeviceCookie(deviceCookie)
    if (ctx.pathname === PAIR_PATH) {
      await this.handlePairRequest(req, res, ctx.clientIp, deviceCheck.ok, ctx.sourceClass)
      return
    }
    if (!deviceCheck.ok) {
      if (isNavigationRequest(ctx.pathWithQuery, headerString(req.headers, 'accept'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(renderPairingPage(null))
      } else {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(pairingRequiredBody(deviceCheck.reason))
      }
      return
    }
    if (isNavigationRequest(ctx.pathWithQuery, headerString(req.headers, 'accept'))) {
      void this.deps.pairing.touchDevice(deviceCheck.deviceId).catch((error: unknown) => {
        this.deps.logger.warn('pocket-access: 设备活跃时间更新失败', error)
      })
    }

    // 5. 闸门二：带 Bearer 的请求做同账号校验。
    const authorization = headerString(req.headers, 'authorization')
    if (authorization !== undefined && authorization.startsWith('Bearer ')) {
      const presentedToken = authorization.slice('Bearer '.length).trim()
      if (presentedToken !== '') {
        const identityResult = await this.deps.identity.check(presentedToken)
        if (!identityResult.ok) {
          this.deps.audit.identityRejected(identityResult.reason, ctx.clientIp, identityResult.presentedUserId)
          jsonError(res, 403, IDENTITY_REJECTION_MESSAGES[identityResult.reason])
          return
        }
      }
    }

    // 6+7. 头改写与 query 清洗；握手注入。
    const handshakeOutcome = await this.applyHandshake(req, ctx, true)
    if (handshakeOutcome.kind === 'rejected') {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(renderHandshakeLimitedPage())
      return
    }

    this.forwardHttp(req, res, handshakeOutcome.forwardedPath, handshakeOutcome.injectedToken)
  }

  /**
   * 握手注入步骤：见 dsh-auth cookie 即清零计数；仅 `GET /` 候选；窗口超限的
   * HTML 导航 503；token 取用失败（connection 未就绪）不注入直接转发。
   */
  private async applyHandshake(
    req: IncomingMessage,
    ctx: { clientIp: string; pathWithQuery: string; pathname: string },
    hasDevice: boolean,
  ): Promise<{ kind: 'forward'; forwardedPath: string; injectedToken: boolean } | { kind: 'rejected' }> {
    const cookieHeader = headerString(req.headers, 'cookie')
    this.deps.handshake.clearIfAuthenticated(cookieHeader, ctx.clientIp)
    const forwardedPath = stripDesktopQueryParams(ctx.pathWithQuery)
    if (!hasDevice) return { kind: 'forward', forwardedPath, injectedToken: false }
    const reauth = hasReauthFlag(ctx.pathWithQuery)
    const candidate = this.deps.handshake.isInjectCandidate({
      method: req.method ?? 'GET',
      path: ctx.pathname,
      cookieHeader,
      reauth,
    })
    if (!candidate) return { kind: 'forward', forwardedPath, injectedToken: false }
    if (this.deps.handshake.isLimited(ctx.clientIp)) {
      if (isNavigationRequest(ctx.pathWithQuery, headerString(req.headers, 'accept'))) {
        return { kind: 'rejected' }
      }
      return { kind: 'forward', forwardedPath, injectedToken: false }
    }
    let token: string
    try {
      token = await this.deps.handshake.getLaunchToken()
    } catch (error) {
      this.deps.logger.warn('pocket-access: launch token 获取失败，跳过握手注入', error)
      return { kind: 'forward', forwardedPath, injectedToken: false }
    }
    if (token === '') return { kind: 'forward', forwardedPath, injectedToken: false }
    this.deps.handshake.noteInjection(ctx.clientIp)
    return {
      kind: 'forward',
      forwardedPath: this.deps.handshake.buildUpstreamUrl(forwardedPath, token),
      injectedToken: true,
    }
  }

  /** 配对端点：已有有效设备 cookie 直接回根；否则处理 GET ?code= / POST 表单提交。sourceClass 记录为设备来源。 */
  private async handlePairRequest(
    req: IncomingMessage,
    res: ServerResponse,
    clientIp: string,
    hasValidDevice: boolean,
    sourceClass: HostClass,
  ): Promise<void> {
    if (hasValidDevice) {
      res.writeHead(303, { location: '/' })
      res.end()
      return
    }
    let code: string | null = null
    if (req.method === 'POST') {
      const body = await readBody(req, PAIR_BODY_MAX_BYTES)
      if (body === null) {
        jsonError(res, 400, 'invalid-body')
        return
      }
      code = new URLSearchParams(body).get('code')
    } else {
      try {
        code = new URL(req.url ?? '/', 'http://pocket.invalid').searchParams.get('code')
      } catch {
        code = null
      }
    }
    if (code === null || code.trim() === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(renderPairingPage(null))
      return
    }
    const userAgent = headerString(req.headers, 'user-agent') ?? ''
    const result = await this.deps.pairing.attemptPair(
      code.trim().toUpperCase(),
      clientIp,
      userAgent,
      sourceClass === 'public' ? 'wan' : 'lan',
    )
    if (result.ok) {
      this.deps.audit.devicePaired(result.deviceId, sourceClass === 'public' ? 'wan' : 'lan', clientIp, userAgent)
      res.writeHead(303, {
        location: '/',
        'set-cookie': deviceCookieSetCookie(result.cookie),
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (result.reason === 'rate-limited') {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000))
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(renderRateLimitedPage(retryAfterSeconds))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(renderPairingPage(PAIRING_ERROR_TEXT[result.reason]))
  }

  /** 上游转发：agent:false 流式，双向断连清理，上游不可达 502。 */
  private forwardHttp(
    req: IncomingMessage,
    res: ServerResponse,
    forwardedPath: string,
    injectedToken: boolean,
  ): void {
    const headers = rewriteRequestHeaders(req, this.upstreamPort, false)
    const upstreamReq = httpRequest(
      {
        host: '127.0.0.1',
        port: this.upstreamPort,
        method: req.method,
        path: forwardedPath,
        headers,
        agent: false,
      },
      (upstreamRes) => {
        this.handleUpstreamResponse(req, res, upstreamRes, injectedToken)
      },
    )
    upstreamReq.on('error', (error) => {
      this.deps.logger.warn('pocket-access: 上游请求失败', error)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('DSH webserver 未就绪，请稍后重试。')
      } else {
        res.destroy()
      }
    })
    req.on('error', () => upstreamReq.destroy())
    req.on('aborted', () => upstreamReq.destroy())
    res.on('close', () => upstreamReq.destroy())
    req.pipe(upstreamReq)
  }

  private handleUpstreamResponse(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamRes: IncomingMessage,
    injectedToken: boolean,
  ): void {
    const status = upstreamRes.statusCode ?? 502

    // Safari 过渡页：本轮已注入 token 的上游 303 改写为 200（保留 Set-Cookie）。
    if (this.deps.handshake.shouldRewriteRedirect({ upstreamStatusCode: status, injectedToken })) {
      const headers: OutgoingHttpHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      const setCookie = upstreamRes.headers['set-cookie']
      if (setCookie !== undefined) headers['set-cookie'] = setCookie
      res.writeHead(200, headers)
      res.end(this.deps.handshake.renderInterimPage())
      return
    }

    const headers: OutgoingHttpHeaders = { ...upstreamRes.headers }
    const compression = shouldCompressResponse(req, upstreamRes)
    if (compression !== null) {
      delete headers['content-length']
      headers['content-encoding'] = compression
      res.writeHead(status, headers)
      const compressor =
        compression === 'br'
          ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
          : createGzip()
      upstreamRes.on('error', () => res.destroy())
      compressor.on('error', () => res.destroy())
      res.on('close', () => {
        upstreamRes.destroy()
        compressor.destroy()
      })
      upstreamRes.pipe(compressor).pipe(res)
      return
    }

    res.writeHead(status, headers)
    upstreamRes.on('error', () => res.destroy())
    upstreamRes.pipe(res)
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      await this.processUpgrade(req, socket, head)
    } catch (error) {
      this.deps.logger.warn('pocket-access: WS 升级处理异常', error)
      socket.destroy()
    }
  }

  /** WS 升级管线：与 HTTP 同一判定链 + head 字节随请求尾发出。 */
  private async processUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const ctx = this.resolveRequestContext(req)
    // 1. policyHost：与 HTTP 管线同一判定（公网 Host 且源非 loopback 拒绝，隧道回连豁免）。
    if (isPublicHostBlocked(ctx.verdict, ctx.sourceClass)) {
      writeRawJsonResponse(socket, 403, JSON.stringify({ error: 'forbidden' }))
      return
    }
    if (isDenylisted(ctx.pathname)) {
      writeRawJsonResponse(socket, 403, JSON.stringify({ error: 'forbidden' }))
      return
    }
    if (!this.deps.toggles.lanEnabled() && ctx.sourceClass === 'lan') {
      this.deps.audit.lanDisabledHit(ctx.clientIp)
      writeRawJsonResponse(socket, 403, JSON.stringify({ error: LAN_DISABLED_MESSAGE }))
      return
    }

    // 闸门一：无设备 cookie 时 WS query 配对码尝试并入同一限速器。
    const deviceCookie = extractCookieValue(headerString(req.headers, 'cookie'), DEVICE_COOKIE_NAME)
    const deviceCheck = this.deps.pairing.verifyDeviceCookie(deviceCookie)
    let pairingCookie: string | null = null
    let tunnelDeviceId: string
    if (!deviceCheck.ok) {
      let submittedCode: string | null = null
      try {
        submittedCode = new URL(ctx.pathWithQuery, 'http://pocket.invalid').searchParams.get('code')
      } catch {
        submittedCode = null
      }
      if (submittedCode === null || submittedCode.trim() === '') {
        writeRawJsonResponse(socket, 401, pairingRequiredBody(deviceCheck.reason))
        return
      }
      const result = await this.deps.pairing.attemptPair(
        submittedCode.trim().toUpperCase(),
        ctx.clientIp,
        headerString(req.headers, 'user-agent') ?? '',
        ctx.sourceClass === 'public' ? 'wan' : 'lan',
      )
      if (!result.ok) {
        writeRawJsonResponse(socket, result.reason === 'rate-limited' ? 429 : 401, JSON.stringify({ error: result.reason }))
        return
      }
      this.deps.audit.devicePaired(result.deviceId, ctx.sourceClass === 'public' ? 'wan' : 'lan', ctx.clientIp, headerString(req.headers, 'user-agent') ?? '')
      pairingCookie = result.cookie
      tunnelDeviceId = result.deviceId
    } else {
      tunnelDeviceId = deviceCheck.deviceId
    }

    // 闸门二：WS 携带 Bearer 时同样校验。
    const authorization = headerString(req.headers, 'authorization')
    if (authorization !== undefined && authorization.startsWith('Bearer ')) {
      const presentedToken = authorization.slice('Bearer '.length).trim()
      if (presentedToken !== '') {
        const identityResult = await this.deps.identity.check(presentedToken)
        if (!identityResult.ok) {
          this.deps.audit.identityRejected(identityResult.reason, ctx.clientIp, identityResult.presentedUserId)
          writeRawJsonResponse(socket, 403, JSON.stringify({ error: IDENTITY_REJECTION_MESSAGES[identityResult.reason] }))
          return
        }
      }
    }

    const forwardedPath = stripDesktopQueryParams(ctx.pathWithQuery)
    const headers = rewriteRequestHeaders(req, this.upstreamPort, true)
    if (socket.destroyed) return
    const upstreamReq = httpRequest({
      host: '127.0.0.1',
      port: this.upstreamPort,
      method: 'GET',
      path: forwardedPath,
      headers,
    })
    // head 字节（浏览器握手后立即发出的首帧）随请求尾写出——等 101 之后写会迟到。
    upstreamReq.end(head)
    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (key === 'connection' || key === 'upgrade' || key.startsWith('sec-websocket-')) {
          lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        }
      }
      if (pairingCookie !== null) lines.push(`Set-Cookie: ${deviceCookieSetCookie(pairingCookie)}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      this.establishTunnel(socket, upstreamSocket, tunnelDeviceId)
    })
    upstreamReq.on('response', (upstreamRes) => {
      // 上游拒绝升级（401/403/404）。
      writeRawJsonResponse(socket, upstreamRes.statusCode ?? 502, JSON.stringify({ error: 'upgrade-rejected' }))
      upstreamReq.destroy()
    })
    upstreamReq.on('error', (error) => {
      this.deps.logger.warn('pocket-access: 上游升级失败', error)
      if (!socket.destroyed) writeRawJsonResponse(socket, 502, JSON.stringify({ error: 'upstream-unavailable' }))
    })
  }

  /** 双向转发 + RST teardown + 心跳（§6.2.3）；登记 deviceId 供踢连接。 */
  private establishTunnel(clientSocket: Duplex, upstreamSocket: NetSocket, deviceId: string): void {
    let closed = false
    const teardown = (): void => {
      if (closed) return
      closed = true
      this.tunnels.delete(clientSocket)
      clientSocket.destroy()
      resetAndDestroy(upstreamSocket)
    }
    this.tunnels.set(clientSocket, { deviceId, upstreamSocket, teardown })
    clientSocket.on('close', teardown)
    clientSocket.on('end', teardown)
    clientSocket.on('error', teardown)
    // 上游 error 必须吞掉：webserver 重启的 ECONNRESET 不得崩宿主。
    upstreamSocket.on('error', teardown)
    upstreamSocket.on('close', teardown)
    upstreamSocket.on('end', teardown)
    // end:false 防 half-open 僵尸——上游 loopback 收 FIN 不自动关。
    upstreamSocket.pipe(clientSocket, { end: false })
    clientSocket.pipe(upstreamSocket, { end: false })

    if (this.disposed || !this.deps.toggles.heartbeatEnabled()) return
    let hadInbound = true
    let missed = 0
    clientSocket.on('data', () => {
      hadInbound = true
    })
    const timer = setInterval(() => {
      if (closed) {
        clearInterval(timer)
        return
      }
      if (!hadInbound) {
        missed += 1
        if (missed >= WS_HEARTBEAT_MAX_MISSES) {
          teardown()
          return
        }
      } else {
        missed = 0
      }
      hadInbound = false
      clientSocket.write(WS_PING_FRAME)
    }, this.heartbeatIntervalMs)
    timer.unref()
  }

  /**
   * 踢掉指定设备的全部活跃 WS 隧道：发 close 帧后断开。
   *
   * @param deviceId - 目标设备 id，仅匹配该设备的隧道。
   * @param closeCode - WS close 状态码（使用 WS_CLOSE_* 常量）。
   * @param closeReason - 手机端可见的关闭原因文案。
   */
  kickDevice(deviceId: string, closeCode: number, closeReason: string): void {
    for (const [socket, entry] of [...this.tunnels]) {
      if (entry.deviceId !== deviceId) continue
      this.closeTunnelWithFrame(socket, entry, closeCode, closeReason)
    }
  }

  /**
   * 踢掉全部活跃 WS 隧道（桌面端 signout 清空设备联动）。
   *
   * @param closeCode - WS close 状态码（使用 WS_CLOSE_* 常量）。
   * @param closeReason - 手机端可见的关闭原因文案。
   */
  kickAllDevices(closeCode: number, closeReason: string): void {
    for (const [socket, entry] of [...this.tunnels]) {
      this.closeTunnelWithFrame(socket, entry, closeCode, closeReason)
    }
  }

  /**
   * 发 close 帧后以 FIN 关闭：TCP 保证帧先于 FIN 送达，teardown 的 destroy 会丢弃
   * 未 flush 的 write 缓冲（close 帧随机丢失）。对端回关触发已注册的 close/end/error
   * 完成清理；对端不回关时由心跳兜底回收。写端不可用时退化为直接 teardown。
   */
  private closeTunnelWithFrame(socket: Duplex, entry: TunnelEntry, closeCode: number, closeReason: string): void {
    if (!socket.writable || socket.destroyed) {
      entry.teardown()
      return
    }
    socket.write(buildWsCloseFrame(closeCode, closeReason))
    socket.end()
  }
}
