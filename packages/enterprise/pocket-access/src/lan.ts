/**
 * LAN 地址探测（pocket-access-design §6.5）：多网卡打分制、WSL interop
 * ipconfig 解析、手动覆盖优先、15s 缓存。
 *
 * 打分规则：私网（RFC1918 + CGNAT）+100；物理网卡名 +20；VPN/虚拟网卡名
 * −50；同分保持枚举序；无私网地址时回退最高分（纯 VPN 环境仍可用）。
 * WSL 判据绝不含 WSLENV——Windows Terminal 在原生 Windows 上也设置它。
 *
 * @module @deepseek-ai/dsh-pocket-access/lan
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import { isPrivateIpv4 } from './classify.ts'

/** 物理网卡名特征（英文 + 中文 Windows）。 */
export const PHYSICAL_INTERFACE_PATTERN = /wlan|wi-?fi|ethernet|eth\d|en\d|wlp\d|以太网|本地连接/i

/** VPN/虚拟网卡名特征（overlay、容器、虚拟化平台）。 */
export const VIRTUAL_INTERFACE_PATTERN
  = /radmin|tailscale|zerotier|tun\d|tap\d|vpn|vethernet|virtual|vmware|virtualbox|hyper-v|wsl|docker|teredo/i

/** 探测结果缓存时长（设置页 3s 轮询下避免重复枚举）。 */
export const LAN_CACHE_TTL_MS = 15_000

/** ipconfig interop 超时（WSL 内 Windows 侧执行偶发阻塞）。 */
const IPCONFIG_TIMEOUT_MS = 5_000

/** WSL interop 的 ipconfig.exe 绝对路径兜底（PATH 不含 Windows 目录时）。 */
const IPCONFIG_FALLBACK_PATH = '/mnt/c/Windows/System32/ipconfig.exe'

/**
 * 单网卡得分；只对已通过「非 internal、非 loopback」预筛的地址调用。
 * @param name - 接口名（原始大小写）。
 * @param ip - 该接口的 IPv4 地址。
 * @returns 得分，越大越优先。
 */
export function scoreInterface(name: string, ip: string): number {
  let score = 0
  if (isPrivateIpv4(ip)) score += 100
  if (PHYSICAL_INTERFACE_PATTERN.test(name)) score += 20
  if (VIRTUAL_INTERFACE_PATTERN.test(name)) score -= 50
  return score
}

/** ipconfig 输出的单块解析结果：块头（适配器名）+ 块内首个 IPv4。 */
export interface IpconfigEntry {
  /** 适配器名（含 `Ethernet adapter`/`无线局域网适配器` 前缀原样保留）。 */
  name: string
  /** 块内首个 IPv4 字面量。 */
  ip: string
}

/**
 * 解析 ipconfig 中英文输出：按顶格行分块，跳过块头命中 VPN/虚拟正则的块，
 * 取每块首个 IPv4（中文「IPv4 地址 . . . :」与英文「IPv4 Address. . . :」同构）。
 * @param output - ipconfig.exe 的 stdout。
 * @returns 逐块解析结果，顺序保持输出顺序。
 */
export function parseIpconfigOutput(output: string): IpconfigEntry[] {
  const entries: IpconfigEntry[] = []
  let currentName: string | null = null
  let currentIp: string | null = null
  const flush = (): void => {
    if (currentName !== null && currentIp !== null) entries.push({ name: currentName, ip: currentIp })
    currentName = null
    currentIp = null
  }
  for (const line of output.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      // 顶格行 = 新适配器块的开始。
      flush()
      if (!VIRTUAL_INTERFACE_PATTERN.test(line)) currentName = line.trim()
      continue
    }
    if (currentName !== null && currentIp === null) {
      const match = /IPv4[^:]*:\s*(\d{1,3}(?:\.\d{1,3}){3})/.exec(line)
      if (match?.[1] !== undefined) currentIp = match[1]
    }
  }
  flush()
  return entries
}

/** `/proc/version` 读取器（注入以便在任意平台测试判据）。 */
export type ProcVersionReader = () => Promise<string | null>

const readProcVersionDefault: ProcVersionReader = async () => {
  try {
    return await readFile('/proc/version', 'utf8')
  } catch {
    // 非 Linux 或无 /proc：读取不到即无该判据。
    return null
  }
}

/**
 * WSL 环境判据：`/proc/version` 含 microsoft/wsl，或 `WSL_DISTRO_NAME`/
 * `WSL_INTEROP` 存在。绝不用 WSLENV 判（Windows Terminal 在原生 Windows
 * 也设置它，pocket-access-design §6.5）。
 * @param env - 进程环境（默认 process.env，测试注入）。
 * @param readProcVersion - `/proc/version` 读取器（测试注入）。
 * @returns 运行于 WSL 时 true。
 */
export async function isWslEnvironment(
  env: Record<string, string | undefined> = process.env,
  readProcVersion: ProcVersionReader = readProcVersionDefault,
): Promise<boolean> {
  if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return true
  const version = await readProcVersion()
  return version !== null && /microsoft|wsl/i.test(version)
}

/**
 * 经 WSL interop 执行 ipconfig.exe 读 Windows 宿主网卡信息。
 * @returns stdout 文本；执行失败或超时返回 null（调用方回退本机探测）。
 */
export function readIpconfigInterop(): Promise<string | null> {
  return new Promise((resolve) => {
    const finish = (value: string | null): void => {
      resolve(value)
    }
    execFile('ipconfig.exe', { timeout: IPCONFIG_TIMEOUT_MS }, (error, stdout) => {
      if (error === null) {
        finish(stdout)
        return
      }
      // PATH 上找不到时用绝对路径兜底（ENOENT 类失败）。
      execFile(IPCONFIG_FALLBACK_PATH, { timeout: IPCONFIG_TIMEOUT_MS }, (fallbackError, fallbackStdout) => {
        finish(fallbackError === null ? fallbackStdout : null)
      })
    })
  })
}

/** 探测结论：候选地址（打分降序、含覆盖值去重）与首选地址。 */
export interface LanResolution {
  /** 候选地址列表，供设置页下拉选择。 */
  candidates: string[]
  /** 首选地址（覆盖值 > 最高分私网 > 最高分回退）；无可用地址为 null。 */
  primary: string | null
}

/** LanDetector 的可注入依赖（默认使用真实 os/child_process）。 */
export interface LanDetectorDeps {
  /** 网卡枚举；默认 `os.networkInterfaces`。 */
  listInterfaces?: () => NodeJS.Dict<readonly NetworkInterfaceInfo[]>
  /** WSL 判据；默认 {@link isWslEnvironment}。 */
  detectWsl?: () => Promise<boolean>
  /** WSL 下 ipconfig 读取；默认 {@link readIpconfigInterop}。 */
  readIpconfig?: () => Promise<string | null>
  /** 缓存时钟；默认 `Date.now`。 */
  now?: () => number
}

/**
 * LAN 地址探测器：打分枚举（原生 Windows/macOS/Linux）或 WSL interop，
 * 手动覆盖优先，结果缓存 15s。
 */
export class LanDetector {
  private readonly deps: Required<Pick<LanDetectorDeps, 'now'>> & LanDetectorDeps
  private cached: { at: number; resolution: LanResolution } | null = null

  /**
   * @param deps - 可注入依赖；生产环境全部缺省。
   */
  constructor(deps: LanDetectorDeps = {}) {
    this.deps = { now: Date.now, ...deps }
  }

  /**
   * 解析当前 LAN 候选地址（带 15s 缓存）。
   * @param override - 手动局域网地址（`lanIpOverride`，'' 表示未设置）。
   * @returns 候选与首选地址。
   */
  async resolve(override: string): Promise<LanResolution> {
    const now = this.deps.now()
    if (this.cached !== null && now - this.cached.at < LAN_CACHE_TTL_MS) {
      return this.applyOverride(this.cached.resolution, override)
    }
    const detected = await this.detect()
    this.cached = { at: now, resolution: detected }
    return this.applyOverride(detected, override)
  }

  private async detect(): Promise<LanResolution> {
    const detectWsl = this.deps.detectWsl ?? isWslEnvironment
    if (await detectWsl()) {
      const readIpconfig = this.deps.readIpconfig ?? readIpconfigInterop
      const output = await readIpconfig()
      if (output !== null) {
        const scored = parseIpconfigOutput(output)
          .map(entry => ({ ip: entry.ip, score: scoreInterface(entry.name, entry.ip) }))
          .sort((a, b) => b.score - a.score)
          .map(entry => entry.ip)
        if (scored.length > 0) return { candidates: scored, primary: scored[0] ?? null }
      }
      // interop 失败回退本机探测（WSL 内通常是 NAT 内网地址）。
    }
    const listInterfaces = this.deps.listInterfaces ?? os.networkInterfaces
    const interfaces = listInterfaces()
    const scored: Array<{ ip: string; score: number }> = []
    for (const [name, infos] of Object.entries(interfaces)) {
      for (const info of infos ?? []) {
        if (info.internal) continue
        // 只收 IPv4（os 返回字符串 'IPv4'）。
        if (info.family !== 'IPv4') continue
        const ip = info.address
        // 预筛：127/8 与 169.254.* 直接跳过。
        if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue
        scored.push({ ip, score: scoreInterface(name, ip) })
      }
    }
    // 稳定排序：同分保持枚举序。
    scored.sort((a, b) => b.score - a.score)
    const candidates = scored.map(entry => entry.ip)
    return { candidates, primary: candidates[0] ?? null }
  }

  private applyOverride(resolution: LanResolution, override: string): LanResolution {
    if (override === '') return resolution
    const candidates = [override, ...resolution.candidates.filter(ip => ip !== override)]
    return { candidates, primary: override }
  }
}
