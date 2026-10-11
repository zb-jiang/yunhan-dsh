/**
 * 手机配对失效探测（纯逻辑，无 React）。
 *
 * <p>浏览器 WS 升级失败不暴露 HTTP 状态码与响应体，核心连接层把配对失效后的
 * 每次重连失败都当普通网络故障无限退避，页面永远停留在「重新连接中」。本模块
 * 在连接断开时改用普通 fetch 探测一次代理闸门（fetch 能拿到 401/403 响应体），
 * 把失效原因解析成机器可读结论，供全屏失效页渲染。PC Electron 直连 webserver
 * 不经代理闸门，探测永远成功，失效页天然只在手机端出现。
 *
 * <p>unreachable（代理停止应答——总开关关闭/电脑关机）是可恢复状态：失效页渲染
 * 期间周期性重探，代理恢复后失效页自动卸载（配对仍有效）或切换为对应终态
 * （配对失效/局域网关闭）；401/403 结论是不可恢复终态。
 *
 * <p>真实网络里对已死端口的探测可能挂在 TCP 重试上数十秒才失败（连接层重试
 * 期间状态恒为 connecting 不再翻转，探测仅此一次），单次探测带超时，超时与
 * 网络失败统一收敛为 unreachable，失效页在数秒内落地。
 */
import type { ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'

/** 配对失效结论：kind 决定页面标题，message 为闸门下发的对外文案。 */
export interface PairingExpiry {
  /**
   * revoked = 配对已撤销；unpaired = 未配对/桌面登出导致失效；blocked = 局域网开关关闭；
   * unreachable = 探测请求网络失败（代理已停止——总开关关闭/电脑关机/网络不可达）。
   */
  kind: 'revoked' | 'unpaired' | 'blocked' | 'unreachable'
  /** 闸门 401/403 响应体 error 文案；缺失时回退到内置默认文案。 */
  message: string
}

/** 闸门响应体缺失/非 JSON 时的回退文案（与 pocket-access 代理闸门文案保持一致）。 */
const FALLBACK_MESSAGES: Record<PairingExpiry['kind'], string> = {
  revoked: '该设备的配对已被撤销，请重新扫码配对。',
  unpaired: '本设备尚未配对，或电脑端已退出登录导致配对失效，请重新扫码配对。',
  blocked: '局域网访问已关闭，请在电脑上的手机访问设置中开启。',
  unreachable: '手机访问连接已断开：电脑端可能已关闭手机访问、电脑已关机或网络不可达，请检查后重试。',
}

/** 窄化 unknown 到普通对象（响应体 shape 检查的前置步骤）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 读取闸门错误响应体的 error/code 字段；非 JSON 响应（如网关错误页）返回 null。 */
async function readGateErrorBody(
  response: Response,
): Promise<{ error?: string | undefined; code?: string | undefined } | null> {
  try {
    const parsed: unknown = await response.json()
    if (!isRecord(parsed)) return null
    return {
      error: typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : undefined,
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
    }
  } catch {
    // 响应体不是 JSON：无法细分原因，用回退文案。
    return null
  }
}

/**
 * 经代理闸门探测配对状态：401 + code 细分撤销/未配对，403 为局域网关闭，
 * 网络异常为 unreachable（代理已停止或不可达，是否采纳由 watcher 的
 * 「曾连接成功」门控决定），闸门放行后的 200 不构成失效证据返回 null。
 * @param fetchImpl - 执行一次探测请求的函数（返回闸门响应；网络异常时 reject）。
 * @returns 失效结论（kind + 闸门下发文案，响应体缺失时回退内置文案）；
 * 响应状态非 401/403（闸门放行）为 null，表示未探测到配对失效。
 */
export async function probePairingViaGate(fetchImpl: () => Promise<Response>): Promise<PairingExpiry | null> {
  let response: Response
  try {
    response = await fetchImpl()
  } catch {
    // 网络异常 = 代理不监听或不可达（总开关关闭/电脑关机）；是否据此失效由 watcher 复核。
    return { kind: 'unreachable', message: FALLBACK_MESSAGES.unreachable }
  }
  if (response.status !== 401 && response.status !== 403) return null
  const body = await readGateErrorBody(response)
  if (response.status === 401) {
    if (body?.code === 'device-revoked') {
      return { kind: 'revoked', message: body.error ?? FALLBACK_MESSAGES.revoked }
    }
    return { kind: 'unpaired', message: body?.error ?? FALLBACK_MESSAGES.unpaired }
  }
  return { kind: 'blocked', message: body?.error ?? FALLBACK_MESSAGES.blocked }
}

/** 失效探测器的依赖：连接状态源 + 一次探测动作 + 恢复轮询/超时参数（测试注入用）。 */
export interface PairingExpiryWatcherDeps {
  connectionState: ConnectionStateSource
  probe: () => Promise<PairingExpiry | null>
  /** unreachable 失效页的恢复重探间隔毫秒数；缺省 5000。 */
  recoveryPollMs?: number
  /** 单次探测的超时毫秒数；缺省 4000。探测挂起无响应时按 unreachable 收敛。 */
  probeTimeoutMs?: number
}

/** unreachable 失效页默认恢复重探间隔（设置页状态轮询同量级，无需配置化）。 */
const RECOVERY_POLL_MS = 5000

/**
 * 单次探测默认超时。须短于恢复重探间隔，保证每轮重探从探测完成点起算；
 * 对已死端口的探测在真实网络里可能挂数十秒（浏览器 TCP 重试），超时让
 * 失效页数秒内落地，弱网下的短暂误报由恢复轮询在代理可达后自动纠正。
 */
const PROBE_TIMEOUT_MS = 4000

/** 超时哨兵的延迟 promise。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 连接断开驱动的失效探测器：连接非 connected 时探测一次，得到失效结论后
 * 停止连接驱动的后续探测；401/403 结论是终态，unreachable 结论进入恢复
 * 轮询（周期重探，代理恢复后失效页卸载或切换终态）；探测返回时以最新
 * 连接状态复核，丢弃「探测期间重连成功」的过时结论。
 */
export class PairingExpiryWatcher {
  private expiry: PairingExpiry | null = null
  private probing = false
  private disposed = false
  /** 本探测器存续期内连接是否成功过；unreachable 结论仅在此为 true 时采纳（初始加载时代理未开不误报失效）。 */
  private hasConnected = false
  private recoveryTimer: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void

  constructor(private readonly deps: PairingExpiryWatcherDeps) {
    this.unsubscribe = deps.connectionState.subscribe(() => { this.evaluate() })
    this.evaluate()
  }

  /** 当前失效结论；null 表示尚未失效（React 侧据此决定是否渲染失效页）。
   * @returns 当前缓存的失效结论；尚未探测到失效为 null。
   */
  getExpiry(): PairingExpiry | null {
    return this.expiry
  }

  /** 订阅失效结论变化，返回退订器。
   * @param listener - 失效结论变化（含失效页卸载与终态切换）时的通知回调，无参数。
   * @returns 退订函数：调用后不再收到后续通知；可重复调用，重复调用无副作用。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 停止订阅连接状态、停止恢复轮询并废弃探测器（React 卸载时调用）。 */
  dispose(): void {
    this.disposed = true
    this.stopRecoveryPolling()
    this.unsubscribe()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private evaluate(): void {
    if (this.disposed || this.expiry !== null || this.probing) return
    if (this.deps.connectionState.getSnapshot() === 'connected') {
      this.hasConnected = true
      return
    }
    this.probing = true
    void this.runProbe().then((result) => {
      this.probing = false
      if (this.disposed || this.expiry !== null || result === null) return
      // 从未连接成功时的 unreachable 可能只是初始加载时代理未开，不构成失效。
      if (result.kind === 'unreachable' && !this.hasConnected) return
      // 复核：探测期间连接恢复则结论过时，丢弃并等待下一次断开。
      if (this.deps.connectionState.getSnapshot() === 'connected') return
      this.expiry = result
      if (result.kind === 'unreachable') this.startRecoveryPolling()
      this.emit()
    })
  }

  /**
   * 执行一次探测；挂起无响应时超时哨兵先返回，按 unreachable 收敛（与网络
   * 失败同语义）。Promise.race 已订阅两个输入的 settle，落败方不会变成
   * 未处理的 rejection。
   */
  private runProbe(): Promise<PairingExpiry | null> {
    const timeoutMs = this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    return Promise.race([
      this.deps.probe(),
      sleep(timeoutMs).then((): PairingExpiry => ({ kind: 'unreachable', message: FALLBACK_MESSAGES.unreachable })),
    ])
  }

  /** unreachable 失效页期间周期重探：代理恢复且配对有效则卸载失效页，配对失效/局域网关闭则切换终态。 */
  private startRecoveryPolling(): void {
    if (this.recoveryTimer !== null) return
    this.recoveryTimer = setInterval(() => {
      if (this.disposed || this.probing) return
      this.probing = true
      void this.runProbe().then((result) => {
        this.probing = false
        if (this.disposed) return
        // 结论已被其他路径收敛（理论不可达，防御：轮询只服务 unreachable 态）。
        if (this.expiry === null || this.expiry.kind !== 'unreachable') return
        if (result === null) {
          // 代理恢复且配对有效：失效页卸载，页面主体由连接层自动重连。
          this.stopRecoveryPolling()
          this.expiry = null
          this.emit()
          return
        }
        if (result.kind !== 'unreachable') {
          // 代理恢复但闸门拒绝（配对撤销/未配对/局域网关闭）：切换为对应终态。
          this.stopRecoveryPolling()
          this.expiry = result
          this.emit()
        }
      })
    }, this.deps.recoveryPollMs ?? RECOVERY_POLL_MS)
  }

  private stopRecoveryPolling(): void {
    if (this.recoveryTimer === null) return
    clearInterval(this.recoveryTimer)
    this.recoveryTimer = null
  }
}
