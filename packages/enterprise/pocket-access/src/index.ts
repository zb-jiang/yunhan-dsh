/**
 * 手机访问代理插件（pocket-access-design M1）：桌面 webserver 的 LAN 侧代理。
 *
 * 总开关开启时在 `0.0.0.0:<bindPort>` 启动 {@link PocketProxyServer}，把同账号手机
 * 的流量按双闸门（配对 cookie + 同账号 Bearer）转发到本机 webserver；管理路由
 * `/api/enterprise/pocket/*`（仅 loopback）提供状态快照与开关/配对管理。员工登出
 * （`platform-user/signout`）清空全部已配对设备并立即断开全部活跃 WS 隧道；
 * 吊销单台设备同样立即断开该设备隧道（close 帧携带原因）。
 *
 * @module @deepseek-ai/dsh-pocket-access
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-identity-context'
import z from '@deepseek-ai/schemastery'
import { toDataURL } from 'qrcode'
import { AuditBacklog } from './audit.ts'
import type { PocketAuditSink } from './audit.ts'
import { classifyHost, classifySource } from './classify.ts'
import { HandshakeManager, parseTokenFromUrl } from './handshake.ts'
import { IdentityChecker } from './identity.ts'
import { LanDetector } from './lan.ts'
import { PairingManager } from './pairing.ts'
import { KICK_REASON_DESKTOP_SIGNED_OUT, KICK_REASON_DEVICE_REVOKED, KICK_REASON_LAN_DISABLED, PocketProxyServer, WS_CLOSE_DESKTOP_SIGNED_OUT, WS_CLOSE_DEVICE_REVOKED, WS_CLOSE_LAN_DISABLED } from './proxy.ts'
import type { ProxyToggles } from './proxy.ts'
import { DeviceStore } from './state.ts'
import type { PairedDeviceSource } from './state.ts'
import { normalizeTunnelHostname, TunnelManager, TunnelMarkerStore, TunnelRequestError, TunnelTokenStore } from './tunnel.ts'
import type { TunnelSnapshot } from './tunnel.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'pocket-access'

/** 等 webserver、登录身份、连接、设置与子进程运行时就绪后才挂载（隧道需要 spawn cloudflared）。 */
export const inject = ['webServer', 'currentUser', 'platformUsers', 'connection', 'settings', 'subprocess']

/** 管理路由前缀（代理侧 denylist 同值，两端必须同步修改）。 */
export const MANAGEMENT_ROUTE_PREFIX = '/api/enterprise/pocket'

/** 管理请求体字节上限（JSON 开关/配对载荷，冗余余量防滥用）。 */
const MANAGEMENT_BODY_MAX_BYTES = 8 * 1024 * 1024

/** 二维码按内容缓存容量（设置页 3s 轮询下 QR 生成是 CPU 密集操作）。 */
const QR_CACHE_MAX_ENTRIES = 8

/** 插件配置，全部来自 enterprise profile 的 cordis.yml config 段。 */
export interface Config {
  /** 总开关；volatile:管理面板可改，改后即启停代理并持久化。 */
  enabled: Volatile<boolean>
  /** 代理监听端口；被占用时自动顺延。 */
  bindPort: number
  /** 局域网接入开关；volatile:管理面板可改。 */
  lanEnabled: Volatile<boolean>
  /** 手动局域网地址覆盖；volatile:管理面板可改，'' 表示自动探测。 */
  lanIpOverride: Volatile<string>
  /** WS 心跳注入开关（重启生效）。 */
  heartbeatEnabled: boolean
  /** 公网隧道开关意愿；volatile:管理面板可改，实际运行由隧道状态机表达。 */
  tunnelEnabled: Volatile<boolean>
  /** 隧道模式 quick|named；volatile:管理面板可改，改动只影响下次启动。 */
  tunnelMode: Volatile<'quick' | 'named'>
  /** 命名隧道地址；volatile:管理面板可改，改动只影响下次启动。 */
  tunnelHostname: Volatile<string>
  /** 显式 cloudflared 可执行路径；'' 表示走 PATH 探测（程序不做下载，PATH 无可执行文件时报错），改后重启生效。 */
  cloudflaredPath: string
  /** 审计上报目标 web-console 基地址；volatile:每次上报现读，'' 走 env WEB_CONSOLE_URL 或默认本机地址。 */
  webConsoleBaseUrl: Volatile<string>
}

export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  bindPort: z.number().step(1).min(1).max(65535).default(3081),
  lanEnabled: z.boolean().default(true).volatile(),
  lanIpOverride: z.string().default('').volatile(),
  heartbeatEnabled: z.boolean().default(true),
  tunnelEnabled: z.boolean().default(false).volatile(),
  tunnelMode: z.union(['quick', 'named'] as const).default('quick').volatile(),
  tunnelHostname: z.string().default('').volatile(),
  cloudflaredPath: z.string().default(''),
  webConsoleBaseUrl: z.string().default('').volatile(),
})

/** 状态快照（设置页轮询的载荷，§7.4 M1 字段）。 */
export interface PocketAccessSnapshot {
  /** 代理是否运行中。 */
  enabled: boolean
  /** 代理实际监听端口；未运行为 null。 */
  proxyPort: number | null
  /** 上游 webserver 端口；不可用为 null。 */
  upstreamPort: number | null
  /** launch token 是否可即时取得（connection 就绪）。 */
  handshakeAvailable: boolean
  lan: {
    enabled: boolean
    /** 手机访问地址（首选 LAN 地址 + 代理端口）；代理未运行或无候选为 null。 */
    url: string | null
    /** LAN 地址二维码 data URL；无地址为 null。 */
    qr: string | null
    /** 探测候选地址。 */
    candidates: string[]
    /** 手动覆盖值（'' 表示自动）。 */
    override: string
  }
  /** 活跃设备清单（不含已吊销）。source 为最近一次配对入口；早于字段引入的记录为 null。 */
  devices: Array<{ id: string; createdAt: number; lastSeenAt: number; ua: string; source: PairedDeviceSource | null }>
  pairing: {
    /** 当前活跃配对码；无活跃码为 null。 */
    code: string | null
    /** 过期时间（epoch 毫秒）；无活跃码为 null。 */
    expiresAt: number | null
    /** 配对二维码 data URL（扫码直达配对端点）；无码或无 LAN 地址为 null。 */
    qr: string | null
  }
  identity: {
    /** 桌面端当前登录员工 id；未登录为 null（手机侧 Bearer 请求将被拒绝）。 */
    currentUserId: string | null
  }
  /** 公网隧道块（§7.4 M3）。 */
  tunnel: TunnelSnapshot
  /** 审计上报状态（§7.4 M2）。 */
  audit: { backlog: number }
}

/** 管理路由处理异常（携带 HTTP 状态码）。 */
class ManagementError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 读取 JSON 请求体（带字节上限；超限或非法 JSON 抛 {@link ManagementError}）。 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MANAGEMENT_BODY_MAX_BYTES) throw new ManagementError(400, '请求体超过大小上限')
    chunks.push(chunk as Buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ManagementError(400, '请求体不是合法 JSON')
  }
  return parsed
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new ManagementError(400, '请求体必须是 JSON 对象')
  return value as Record<string, unknown>
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new ManagementError(400, `字段 ${key} 必须是 boolean`)
  return value
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new ManagementError(400, `字段 ${key} 必须是 string`)
  return value
}

function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** epoch 毫秒转换（非法 ISO 字符串回 0）。 */
function epochOf(iso: string): number {
  const value = Date.parse(iso)
  return Number.isNaN(value) ? 0 : value
}

/**
 * 隧道运行中的公网 origin（quick 用边缘分配 URL，named 拼归一化 hostname）；未运行或无 URL 返回 null。
 * 配对二维码用：公网 origin 在局域网内同样可达（经 Cloudflare 边缘回源），一个二维码两端通用。
 * @param tunnel - 隧道管理器的当前状态快照。
 * @returns 公网访问 origin（无尾随斜杠的 `https://` 前缀 URL）；隧道未运行或无法解析出 URL 为 null。
 */
export function resolvePublicOrigin(tunnel: TunnelSnapshot): string | null {
  if (tunnel.state !== 'running') return null
  if (tunnel.url !== null) return tunnel.url.replace(/\/+$/, '')
  if (tunnel.mode === 'named') {
    const hostname = normalizeTunnelHostname(tunnel.hostname)
    return hostname === null ? null : `https://${hostname}`
  }
  return null
}

/**
 * 手机访问代理服务：持有配对/身份/握手/LAN 探测与代理生命周期，
 * 供管理路由与宿主消费（`ctx.pocketAccess`）。
 */
export class PocketAccessService extends Service {
  private readonly store: DeviceStore
  private readonly pairing: PairingManager
  private readonly identity: IdentityChecker
  private readonly handshake: HandshakeManager
  private readonly detector = new LanDetector()
  private readonly qrCache = new Map<string, string>()
  private readonly tokenStore: TunnelTokenStore
  private readonly markerStore = new TunnelMarkerStore()
  private readonly tunnel: TunnelManager
  private readonly audit: AuditBacklog
  private readonly tokenLoad: Promise<void>
  private proxy: PocketProxyServer | null = null
  private resolvedUpstreamPort: number | null = null

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'pocketAccess')
    this.store = new DeviceStore(ctx.logger)
    void this.store.load().catch((error: unknown) => {
      this.ctx.logger.warn('pocket-access: 设备文件加载失败', error)
    })
    this.pairing = new PairingManager(this.store)
    this.identity = new IdentityChecker({
      getCurrentUser: () => {
        const user = this.ctx.currentUser.get()
        return user === undefined ? undefined : { id: user.id }
      },
      getUserByToken: (token: string) => this.ctx.platformUsers.getUserByToken(token),
    })
    this.handshake = new HandshakeManager({
      getLaunchToken: () =>
        Promise.resolve(
          parseTokenFromUrl(this.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(this.ensureUpstreamPort())}`)),
        ),
    })
    this.tokenStore = new TunnelTokenStore(ctx.logger)
    // 命名隧道启动前 token 必须可见：enable() 里 await 本 promise 后才可能走到 start
    this.tokenLoad = this.tokenStore.load().catch((error: unknown) => {
      this.ctx.logger.warn('pocket-access: tunnel-token.json 加载失败', error)
    })
    this.tunnel = new TunnelManager({
      subprocess: ctx.subprocess,
      logger: ctx.logger,
      mode: () => this.config.tunnelMode.get(),
      hostname: () => this.config.tunnelHostname.get(),
      cloudflaredPath: () => this.config.cloudflaredPath,
      proxyRunning: () => this.proxy !== null,
      proxyPort: () => this.proxy?.port ?? null,
      tokenStore: this.tokenStore,
      markerStore: this.markerStore,
    })
    this.audit = new AuditBacklog({
      logger: ctx.logger,
      getWebConsoleBaseUrl: () => this.config.webConsoleBaseUrl.get(),
      getToken: () => this.ctx.currentUser.getToken(),
    })
  }

  /** 上游 webserver 端口；不可用时 fail loud（配置或时序问题必须可见）。 */
  private ensureUpstreamPort(): number {
    if (this.resolvedUpstreamPort !== null) return this.resolvedUpstreamPort
    const port = this.ctx.webServer.port
    if (port === undefined || !Number.isInteger(port) || port <= 0) {
      throw new Error(`pocket-access: webserver 端口不可用（${String(port)}），无法确定上游转发目标`)
    }
    this.resolvedUpstreamPort = port
    return port
  }

  /** 启动代理（已运行则幂等返回）。 */
  async enable(): Promise<void> {
    if (this.proxy !== null) return
    // 命名隧道自动恢复前 token 必须可见：tokenStore.load() 在构造时启动，这里等它落地
    await this.tokenLoad
    const upstreamPort = this.ensureUpstreamPort()
    const toggles: ProxyToggles = {
      lanEnabled: () => this.config.lanEnabled.get(),
      heartbeatEnabled: () => this.config.heartbeatEnabled,
    }
    const auditSink: PocketAuditSink = {
      devicePaired: (deviceId, source, ip, ua) => {
        void this.audit.record('POCKET_DEVICE_PAIRED', { deviceId, source, ip, ua: ua.slice(0, 200) })
      },
      identityRejected: (reason, ip, presentedUserId) => {
        void this.audit.record('POCKET_IDENTITY_REJECTED', {
          ip,
          reason,
          ...(presentedUserId === undefined ? {} : { presentedUserId }),
        })
      },
      lanDisabledHit: (ip) => {
        void this.audit.record('POCKET_LAN_DISABLED_HIT', { ip })
      },
    }
    const proxy = new PocketProxyServer(
      {
        pairing: this.pairing,
        identity: this.identity,
        handshake: this.handshake,
        toggles,
        audit: auditSink,
        logger: this.ctx.logger,
      },
      upstreamPort,
      this.config.bindPort,
    )
    await proxy.start()
    this.proxy = proxy
    // 隧道自动恢复无条件尝试：tunnel-marker.json 存在（上次启动未手动停）才拉起，是唯一事实源
    void this.tunnel.autoRestore().catch((error: unknown) => {
      this.ctx.logger.warn('pocket-access: 隧道自动恢复失败', error)
    })
  }

  /** 停止代理（未运行则幂等返回）；总开关关闭同时手动停隧道（删自动恢复标记）。 */
  async disable(): Promise<void> {
    if (this.proxy === null) return
    const proxy = this.proxy
    this.proxy = null
    await this.tunnel.stop()
    await proxy.dispose()
  }

  /**
   * 启停到目标状态并持久化总开关（volatile 热更新由 settings 域完成）。
   * 持久化先于启停：写失败（非 volatile 字段污染等）保持原状不产生半启停态。
   * @param value - 目标总开关状态；true 启动代理，false 停止代理并同时停隧道。
   */
  async setEnabled(value: boolean): Promise<void> {
    const wasEnabled = this.proxy !== null
    await this.ctx.settings.update(name, { enabled: value })
    if (value) {
      await this.enable()
      // 仅状态实际变化时记审计；随配置自启（apply 直调 enable）不经此路径，不记
      if (!wasEnabled) void this.audit.record('POCKET_ENABLED', { port: this.proxy?.port ?? null })
    } else {
      await this.disable()
      if (wasEnabled) void this.audit.record('POCKET_DISABLED', {})
    }
  }

  /**
   * 更新局域网接入开关（volatile 持久化）。关闭时立即踢掉全部活跃隧道：
   * 已建立的 WS 不再经过请求入口的开关检查，不踢则手机端对关闭无感知；
   * 手机端 WS 断开后由失效探测器经闸门 403 渲染「局域网访问已关闭」失效页。
   * @param value - 局域网接入目标状态；false 立即断开全部活跃 WS 隧道。
   */
  async setLanEnabled(value: boolean): Promise<void> {
    await this.ctx.settings.update(name, { lanEnabled: value })
    if (!value) this.proxy?.kickAllDevices(WS_CLOSE_LAN_DISABLED, KICK_REASON_LAN_DISABLED)
  }

  /** 更新手动局域网地址覆盖（volatile 持久化；'' 恢复自动探测）。
   * @param ip - 手动指定的局域网地址（原样持久化，不校验格式）；'' 表示清除覆盖、恢复自动探测。
   */
  async setLanOverride(ip: string): Promise<void> {
    await this.ctx.settings.update(name, { lanIpOverride: ip })
  }

  /**
   * 启动公网隧道：同步校验（抛 TunnelRequestError → 路由 400）后 fire-and-forget 启动。
   * 就绪等待（含 cloudflared 解析与子进程启动）可能长达数十秒，不阻塞路由——快照先回
   * state=starting，UI 轮询观察 running/error。开关意愿 tunnelEnabled 置 true 持久化；
   * 启动失败保持 true + state=error，UI 可重试。
   * @param disclaimer - 用户已确认隧道免责声明；false 时同步校验失败，不启动。
   */
  startTunnel(disclaimer: boolean): void {
    this.tunnel.validateStart({ disclaimer, autoRestore: false })
    void (async () => {
      await this.ctx.settings.update(name, { tunnelEnabled: true })
      await this.tunnel.start({ disclaimer })
      // 仅手动启动记审计；autoRestore 不经此路径，不记
      const snapshot = this.tunnel.snapshot(this.config.tunnelEnabled.get())
      void this.audit.record('POCKET_TUNNEL_STARTED', { mode: snapshot.mode, url: resolvePublicOrigin(snapshot) })
    })().catch((error: unknown) => {
      this.ctx.logger.warn('pocket-access: 隧道启动失败', error)
    })
  }

  /** 停止公网隧道：先撤开关意愿再停进程并删自动恢复标记。 */
  async stopTunnel(): Promise<void> {
    const before = this.tunnel.snapshot(this.config.tunnelEnabled.get())
    await this.ctx.settings.update(name, { tunnelEnabled: false })
    await this.tunnel.stop()
    // idle/error 无运行中隧道可停，不记
    if (before.state === 'running' || before.state === 'starting') {
      void this.audit.record('POCKET_TUNNEL_STOPPED', { mode: before.mode, url: resolvePublicOrigin(before) })
    }
  }

  /**
   * 更新隧道模式与命名地址（volatile 持久化；只影响下次启动）。
   * hostname 非空时经归一化校验后存归一化值；空串清空。
   * @param options - 待更新字段；mode 非法或 hostname 无法归一化抛 TunnelRequestError，两字段均缺省同样抛错。
   */
  async setTunnelConfig(options: { mode?: string | undefined; hostname?: string | undefined }): Promise<void> {
    const update: Partial<{ tunnelMode: 'quick' | 'named'; tunnelHostname: string }> = {}
    if (options.mode !== undefined) {
      if (options.mode !== 'quick' && options.mode !== 'named') {
        throw new TunnelRequestError(`隧道模式必须是 quick 或 named，收到：${options.mode}`)
      }
      update.tunnelMode = options.mode
    }
    if (options.hostname !== undefined) {
      const trimmed = options.hostname.trim()
      if (trimmed === '') {
        update.tunnelHostname = ''
      } else {
        const normalized = normalizeTunnelHostname(trimmed)
        if (normalized === null) {
          throw new TunnelRequestError('命名隧道地址无效：需要形如 example.example.com 的域名（不接受裸 IP 或单段主机名）')
        }
        update.tunnelHostname = normalized
      }
    }
    if (Object.keys(update).length === 0) throw new TunnelRequestError('请求体未携带 mode 或 hostname 字段')
    await this.ctx.settings.update(name, update)
  }

  /** 设置命名隧道 Token（'' 清除；否则写入 tunnel-token.json 0600）。
   * @param token - 命名隧道的 Cloudflare access token；'' 表示清除已存 token。
   */
  async setTunnelToken(token: string): Promise<void> {
    if (token === '') await this.tokenStore.clear()
    else await this.tokenStore.set(token)
  }

  /** 随宿主卸载的隧道清理：终止进程但保留自动恢复标记（下次启动自动拉起）。 */
  async disposeTunnel(): Promise<void> {
    await this.tunnel.disposeKeepMarker()
  }

  /** 审计缓冲生命周期收尾：清重试定时器并等在途上报落地。 */
  auditDispose(): Promise<void> {
    return this.audit.dispose()
  }

  /** 状态快照（二维码按内容缓存，生成失败为 null 不阻塞快照）。
   * @returns 设置页轮询用的完整状态快照；LAN/配对二维码字段生成失败或无地址为 null。
   */
  async snapshot(): Promise<PocketAccessSnapshot> {
    const override = this.config.lanIpOverride.get().trim()
    const lan = await this.detector.resolve(override)
    const proxyPort = this.proxy?.port ?? null
    const lanUrl = lan.primary !== null && proxyPort !== null ? `http://${lan.primary}:${String(proxyPort)}` : null
    const tunnel = this.tunnel.snapshot(this.config.tunnelEnabled.get())
    const activeCode = this.pairing.getActivePairingCode()
    // 配对二维码公用：隧道运行中编码公网地址（局域网与公网手机均可扫码直连），否则回退局域网地址
    const pairOrigin = resolvePublicOrigin(tunnel) ?? lanUrl
    const pairingQr =
      activeCode !== null && pairOrigin !== null
        ? await this.qrFor(`${pairOrigin}/__pocket/pair?code=${activeCode.code}`)
        : null
    this.audit.maybeFlush()
    return {
      enabled: this.proxy !== null,
      proxyPort,
      upstreamPort: this.resolvedUpstreamPort,
      handshakeAvailable: await this.resolveHandshakeAvailable(),
      lan: {
        enabled: this.config.lanEnabled.get(),
        url: lanUrl,
        qr: lanUrl === null ? null : await this.qrFor(lanUrl),
        candidates: lan.candidates,
        override,
      },
      devices: this.activeDevices(),
      pairing: {
        code: activeCode?.code ?? null,
        expiresAt: activeCode?.expiresAt ?? null,
        qr: pairingQr,
      },
      identity: { currentUserId: this.ctx.currentUser.get()?.id ?? null },
      tunnel,
      // UI 轮询驱动审计重放：登录态就绪后无需等下一次事件即清积压
      audit: { backlog: await this.audit.backlogCount() },
    }
  }

  /** 生成新配对码（作废旧码），返回码与过期时间。
   * @returns 新配对码及其过期时刻（epoch 毫秒）；同时使此前的活跃配对码失效。
   */
  createPairingCode(): { code: string; expiresAt: number } {
    return this.pairing.createPairingCode()
  }

  /** 吊销设备并立即断开该设备活跃 WS 隧道；设备不存在返回 false。
   * @param deviceId - 待吊销的已配对设备 id。
   * @returns 设备存在且吊销成功为 true；设备不存在为 false（不断开任何连接）。
   */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const revoked = await this.pairing.revokeDevice(deviceId)
    if (revoked) {
      void this.audit.record('POCKET_DEVICE_REVOKED', { deviceId, reason: 'manual' })
      this.proxy?.kickDevice(deviceId, WS_CLOSE_DEVICE_REVOKED, KICK_REASON_DEVICE_REVOKED)
    }
    return revoked
  }

  /** 员工登出联动：清空全部已配对设备并断开全部活跃 WS 隧道。 */
  async clearAllDevices(): Promise<void> {
    // clearAllDevices 不返回清单：先读活跃设备逐个记审计（reason=signout），再清
    const active = this.store.state.devices.filter(device => device.revokedAt === null)
    await this.pairing.clearAllDevices()
    for (const device of active) {
      void this.audit.record('POCKET_DEVICE_REVOKED', { deviceId: device.id, reason: 'signout' })
    }
    this.proxy?.kickAllDevices(WS_CLOSE_DESKTOP_SIGNED_OUT, KICK_REASON_DESKTOP_SIGNED_OUT)
  }

  private activeDevices(): PocketAccessSnapshot['devices'] {
    return this.store.state.devices
      .filter(device => device.revokedAt === null)
      .map(device => ({
        id: device.id,
        createdAt: epochOf(device.createdAt),
        lastSeenAt: epochOf(device.lastSeenAt),
        ua: device.ua,
        source: device.source ?? null,
      }))
  }

  private async resolveHandshakeAvailable(): Promise<boolean> {
    try {
      const token = await this.handshake.getLaunchToken()
      return token !== ''
    } catch {
      return false
    }
  }

  /** 按内容取二维码 data URL（LRU 触碰；生成失败 warn 并返回 null）。 */
  private async qrFor(content: string): Promise<string | null> {
    const cached = this.qrCache.get(content)
    if (cached !== undefined) {
      this.qrCache.delete(content)
      this.qrCache.set(content, cached)
      return cached
    }
    try {
      const dataUrl = await toDataURL(content, { errorCorrectionLevel: 'M', width: 220 })
      if (this.qrCache.size >= QR_CACHE_MAX_ENTRIES) {
        const oldest = this.qrCache.keys().next().value
        if (oldest !== undefined) this.qrCache.delete(oldest)
      }
      this.qrCache.set(content, dataUrl)
      return dataUrl
    } catch (error: unknown) {
      this.ctx.logger.warn('pocket-access: 二维码生成失败', error)
      return null
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 手机访问代理服务（配对/快照/生命周期）。 */
    pocketAccess: PocketAccessService
  }
}

/**
 * 管理路由分发：仅 loopback Host + loopback 源可达（代理侧 denylist 之外的第二道闸）。
 * GET /status 回完整快照；POST enabled/lan/lan-override/pairing/tunnel/tunnel-config/
 * tunnel-token 修改后回完整快照。
 *
 * @param service - 手机访问代理服务。
 * @param method - HTTP 方法。
 * @param segments - 前缀后的路径段。
 * @param req - 原始请求（Host/源校验与 JSON 体读取）。
 * @param res - 响应。
 */
async function dispatchManagement(
  service: PocketAccessService,
  method: string,
  segments: readonly string[],
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (classifyHost(hostHeader) !== 'loopback' || classifySource(req.socket.remoteAddress) !== 'loopback') {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'status') {
    sendJson(res, 200, await service.snapshot())
    return
  }
  if (method === 'POST' && segments.length === 1) {
    const record = asRecord(await readJsonBody(req))
    if (segments[0] === 'enabled') {
      await service.setEnabled(requiredBoolean(record, 'enabled'))
      sendJson(res, 200, await service.snapshot())
      return
    }
    if (segments[0] === 'lan') {
      await service.setLanEnabled(requiredBoolean(record, 'enabled'))
      sendJson(res, 200, await service.snapshot())
      return
    }
    if (segments[0] === 'lan-override') {
      await service.setLanOverride(requiredString(record, 'ip').trim())
      sendJson(res, 200, await service.snapshot())
      return
    }
    if (segments[0] === 'pairing') {
      const action = requiredString(record, 'action')
      if (action === 'create') {
        service.createPairingCode()
        sendJson(res, 200, await service.snapshot())
        return
      }
      if (action === 'revoke') {
        await service.revokeDevice(requiredString(record, 'deviceId'))
        sendJson(res, 200, await service.snapshot())
        return
      }
      throw new ManagementError(400, `未知 action：${action}`)
    }
    if (segments[0] === 'tunnel') {
      const action = requiredString(record, 'action')
      if (action === 'start') {
        // fire-and-forget：同步校验通过即回快照（state=starting 或尚未进入 starting），UI 轮询跟踪
        service.startTunnel(record.disclaimer === true)
        sendJson(res, 200, await service.snapshot())
        return
      }
      if (action === 'stop') {
        await service.stopTunnel()
        sendJson(res, 200, await service.snapshot())
        return
      }
      throw new ManagementError(400, `未知 action：${action}`)
    }
    if (segments[0] === 'tunnel-config') {
      const mode = typeof record.mode === 'string' ? record.mode : undefined
      const hostname = typeof record.hostname === 'string' ? record.hostname : undefined
      await service.setTunnelConfig({ mode, hostname })
      sendJson(res, 200, await service.snapshot())
      return
    }
    if (segments[0] === 'tunnel-token') {
      await service.setTunnelToken(requiredString(record, 'token'))
      sendJson(res, 200, await service.snapshot())
      return
    }
  }
  sendJson(res, 404, { error: `no route for ${method} ${MANAGEMENT_ROUTE_PREFIX}/${segments.join('/')}` })
}

/**
 * 挂载手机访问代理：注册管理路由、监听员工登出清空设备、卸载时停隧道（保留恢复标记）、按配置启动代理。
 *
 * @param ctx - 携带 `webServer` / `currentUser` / `platformUsers` / `connection` / `settings` / `subprocess` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const service = new PocketAccessService(ctx, config)
  ctx.pocketAccess = service

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: MANAGEMENT_ROUTE_PREFIX,
        handler: (req, res) => {
          const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
          const segments = urlPath
            .slice(MANAGEMENT_ROUTE_PREFIX.length)
            .split('/')
            .filter(segment => segment !== '')
          dispatchManagement(service, req.method ?? 'GET', segments, req, res).catch((error: unknown) => {
            // TunnelRequestError 是请求方配置/确认缺失，属 400 语义（与 ManagementError 同层）
            const status = error instanceof TunnelRequestError ? 400 : error instanceof ManagementError ? error.status : 500
            ctx.logger.warn('pocket-access: 管理端点异常', error)
            if (!res.headersSent) {
              sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
            }
          })
        },
      }),
    'pocket-access: /api/enterprise/pocket prefix route',
  )

  ctx.effect(
    () =>
      ctx.on('platform-user/signout', () => {
        void service.clearAllDevices().catch((error: unknown) => {
          ctx.logger.warn('pocket-access: 登出清空设备失败', error)
        })
      }),
    'pocket-access: signout clears paired devices',
  )

  // 被动卸载不删标记：下次启动据 tunnel-marker.json 自动拉起（免 disclaimer）
  ctx.effect(
    () => () => {
      void service.disposeTunnel().catch((error: unknown) => {
        ctx.logger.warn('pocket-access: 隧道清理失败', error)
      })
    },
    'pocket-access: dispose terminates tunnel keeping restore marker',
  )

  ctx.effect(
    () => () => {
      void service.auditDispose().catch((error: unknown) => {
        ctx.logger.warn('pocket-access: 审计缓冲清理失败', error)
      })
    },
    'pocket-access: dispose flushes audit backlog',
  )

  if (config.enabled.get()) {
    void service.enable().catch((error: unknown) => {
      ctx.logger.error('pocket-access: 代理随配置启动失败', error)
    })
  }
}
