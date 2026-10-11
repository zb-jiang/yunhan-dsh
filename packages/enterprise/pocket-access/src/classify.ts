/**
 * Host 头 / TCP 源地址分类与 policyHost 裁决（pocket-access-design §5.3）。
 *
 * 两个分类器的兜底方向刻意相反：
 * - classifyHost（Host 头可伪造）：认不出的输入兜底 loopback（历史行为，
 *   防裸 IPv6 误伤本机），随后由 policyHost 用源地址收紧。
 * - classifySource（socket 源地址不可伪造）：认不出一律 public（fail-closed）。
 *
 * 本文件的网段常量表是唯一权威：classifyHost、classifySource 与 lan.ts 的
 * 网卡打分三处共用，禁止在别处复制网段清单。
 *
 * @module @deepseek-ai/dsh-pocket-access/classify
 */

/** 分类结论：loopback（本机） < lan（局域网/overlay） < public（公网）。 */
export type HostClass = 'loopback' | 'lan' | 'public'

/** 保护级别：policyHost 按此比较「源地址是否比 Host 声明更可信地指向更严级别」。 */
const PROTECTION_LEVEL: Readonly<Record<HostClass, number>> = { loopback: 0, lan: 1, public: 2 }

/**
 * 解析严格形式 IPv4 为无符号 32 位整数；拒绝前导零段（`010.1.1.1` 类八进制
 * 歧义在不同解析器间结果不一致，一律视为非 IPv4 走收紧分支）。
 * @param s - 待解析字符串。
 * @returns 数值形式的地址，非严格 IPv4 返回 null。
 */
function parseIpv4(s: string): number | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part[0] === '0') return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/** 起闭区间对：[起始, 结束]，均为无符号 32 位数值。 */
type Ipv4Range = readonly [number, number]

const range = (from: string, to: string): Ipv4Range => {
  const start = parseIpv4(from)
  const end = parseIpv4(to)
  if (start === null || end === null) throw new Error(`非法网段常量 ${from}-${to}`)
  return [start, end] as const
}

/**
 * 唯一网段常量表（pocket-access-design §5.3「三处共用」）。
 * IPv4 按数值区间；IPv6 按首 hextet 的数值区间与精确字面量。
 * 冻结防运行期篡改。
 */
export const NETWORK_RANGES = Object.freeze({
  ipv4: Object.freeze({
    loopback: Object.freeze([range('127.0.0.0', '127.255.255.255')] as const),
    linkLocal: Object.freeze([range('169.254.0.0', '169.254.255.255')] as const),
    private: Object.freeze([
      range('10.0.0.0', '10.255.255.255'),
      range('172.16.0.0', '172.31.255.255'),
      range('192.168.0.0', '192.168.255.255'),
    ] as const),
    /** CGNAT 100.64.0.0/10（Tailscale/ZeroTier/Radmin 等 overlay 常用段）。 */
    cgnat: Object.freeze([range('100.64.0.0', '100.127.255.255')] as const),
  }),
  ipv6: Object.freeze({
    /** 精确 loopback 字面量。 */
    loopbackLiterals: Object.freeze(['::1'] as const),
    /** fe80::/10 链路本地。 */
    linkLocalFirstHextet: Object.freeze([0xfe80, 0xfebf] as const),
    /** fc00::/7 ULA。 */
    ulaFirstHextet: Object.freeze([0xfc00, 0xfdff] as const),
  }),
})

function inIpv4Ranges(value: number, ranges: readonly Ipv4Range[]): boolean {
  return ranges.some(([start, end]) => value >= start && value <= end)
}

/**
 * 判断是否私网 IPv4（RFC1918 + CGNAT）。lan.ts 网卡打分的「私网 +100」判据。
 * @param ip - IPv4 字面量。
 * @returns 命中私网或 CGNAT 段时 true。
 */
export function isPrivateIpv4(ip: string): boolean {
  const value = parseIpv4(ip)
  if (value === null) return false
  return inIpv4Ranges(value, NETWORK_RANGES.ipv4.private) || inIpv4Ranges(value, NETWORK_RANGES.ipv4.cgnat)
}

/** 剥 IPv6 的 zone id（`fe80::1%eth0` → `fe80::1`）。 */
function stripZone(address: string): string {
  const percent = address.indexOf('%')
  return percent === -1 ? address : address.slice(0, percent)
}

/** 剥 IPv4-mapped IPv6 前缀（`::ffff:192.168.1.5` → `192.168.1.5`）。 */
function unmapIpv6(address: string): string {
  const lowered = address.toLowerCase()
  return lowered.startsWith('::ffff:') ? lowered.slice('::ffff:'.length) : lowered
}

/**
 * 按 IPv6 首段分类；无法识别的 IPv6 一律 null（交由调用方按各自兜底方向处理）。
 */
function classifyIpv6(address: string): HostClass | null {
  const unbracketed = address.startsWith('[') && address.endsWith(']')
    ? address.slice(1, -1)
    : address
  const stripped = stripZone(unbracketed).toLowerCase()
  if (stripped === '') return null
  if ((NETWORK_RANGES.ipv6.loopbackLiterals as readonly string[]).includes(stripped)) return 'loopback'
  const firstHextet = Number.parseInt(stripped.split(':')[0] ?? '', 16)
  if (Number.isNaN(firstHextet)) return null
  const [linkStart, linkEnd] = NETWORK_RANGES.ipv6.linkLocalFirstHextet
  const [ulaStart, ulaEnd] = NETWORK_RANGES.ipv6.ulaFirstHextet
  if ((firstHextet >= linkStart && firstHextet <= linkEnd) || (firstHextet >= ulaStart && firstHextet <= ulaEnd)) {
    return 'lan'
  }
  return null
}

/**
 * 剥 Host 头的端口部分：`[::1]:3080` → `::1`；`example.com:8080` → `example.com`；
 * IPv4/域名按最后一个冒号切分；IPv6 裸字面量（无括号）原样返回。
 * @param host - 原始 Host 头值（可能带端口）。
 * @returns 小写的 host 部分；输入为空返回 null。
 */
export function normalizeHost(host: string | undefined | null): string | null {
  if (host === undefined || host === null) return null
  const trimmed = host.trim().toLowerCase()
  if (trimmed === '') return null
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']')
    return closing === -1 ? trimmed : trimmed.slice(1, closing)
  }
  const colon = trimmed.lastIndexOf(':')
  // 单个冒号且后面是纯数字才是端口；IPv6 裸字面量含多个冒号，不切。
  if (colon !== -1 && colon === trimmed.indexOf(':') && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon)
  }
  return trimmed
}

/**
 * Host 头分类（pocket-access-design §5.3 表行 1）。
 * loopback：localhost / 0.0.0.0 / ::1 / 127/8 / 空值 / 认不出的 IPv6 字面量
 * （兜底 loopback——历史行为，防裸 IPv6 误伤本机，policyHost 会用源地址收紧）。
 * lan：RFC1918、CGNAT、fe80::/10、ULA、`.local`（mDNS）、无点单标签。
 * public：其余一切（含 link-local IPv4——Host 侧无从证明本机性）。
 * @param host - 原始 Host 头值。
 * @returns 分类结论。
 */
export function classifyHost(host: string | undefined | null): HostClass {
  const normalized = normalizeHost(host)
  if (normalized === null) return 'loopback'
  if (normalized === 'localhost' || normalized === '0.0.0.0') return 'loopback'
  if (normalized.includes(':')) {
    const classified = classifyIpv6(normalized)
    // 认不出的 IPv6 兜底 loopback（Host 侧宽松方向）。
    return classified ?? 'loopback'
  }
  const value = parseIpv4(normalized)
  if (value !== null) {
    if (inIpv4Ranges(value, NETWORK_RANGES.ipv4.loopback)) return 'loopback'
    if (inIpv4Ranges(value, NETWORK_RANGES.ipv4.private) || inIpv4Ranges(value, NETWORK_RANGES.ipv4.cgnat)) {
      return 'lan'
    }
    return 'public'
  }
  if (normalized.endsWith('.local')) return 'lan'
  // 无点单标签（`mypc`）：多播 mDNS/内网 hosts 常见形态。
  if (!normalized.includes('.')) return 'lan'
  return 'public'
}

/**
 * TCP 源地址分类（pocket-access-design §5.3 表行 2）。
 * 与 classifyHost 的两处差异：link-local IPv4（169.254.*）归 loopback；
 * 兜底（认不出/undefined）一律 public——源地址不可伪造，兜底必须收紧。
 * @param remoteAddress - socket 的 remoteAddress。
 * @returns 分类结论。
 */
export function classifySource(remoteAddress: string | undefined | null): HostClass {
  if (remoteAddress === undefined || remoteAddress === null) return 'public'
  const unzoned = stripZone(remoteAddress.trim())
  const unmapped = unmapIpv6(unzoned)
  if (unmapped.includes(':')) {
    const classified = classifyIpv6(unmapped)
    // 源地址兜底收紧：认不出一律 public。
    return classified ?? 'public'
  }
  const value = parseIpv4(unmapped)
  if (value === null) return 'public'
  if (inIpv4Ranges(value, NETWORK_RANGES.ipv4.loopback)) return 'loopback'
  if (inIpv4Ranges(value, NETWORK_RANGES.ipv4.linkLocal)) return 'loopback'
  if (inIpv4Ranges(value, NETWORK_RANGES.ipv4.private) || inIpv4Ranges(value, NETWORK_RANGES.ipv4.cgnat)) {
    return 'lan'
  }
  return 'public'
}

/**
 * policyHost：Host 头可伪造（直连代理端口写 `Host: 127.0.0.1` 即冒充本机），
 * 用源地址分类给 Host 声明设下限——仅当源地址保护级别**高于** Host 声明级别时
 * 用源覆盖。方向不能反：隧道公网流量的源地址恰是 127.0.0.1，若按源覆盖会把
 * 公网降级成免密（pocket-access-design §5.3）。
 * @param host - 原始 Host 头值。
 * @param source - socket 源地址。
 * @returns 裁决后的分类结论。
 */
export function policyHost(host: string | undefined | null, source: string | undefined | null): HostClass {
  const hostClass = classifyHost(host)
  const sourceClass = classifySource(source)
  return PROTECTION_LEVEL[sourceClass] > PROTECTION_LEVEL[hostClass] ? sourceClass : hostClass
}

/**
 * 客户端真实 IP 识别：源为 loopback（隧道回连）时认 `cf-connecting-ip`，
 * 其余一律 socket 源地址；`x-forwarded-for` 永不信任（pocket-access-design §5.3）。
 * @param source - socket 源地址。
 * @param cfConnectingIp - 请求头 `cf-connecting-ip` 的值（可能为空）。
 * @returns 用于限速/审计的客户端 IP。
 */
export function resolveClientIp(source: string | undefined, cfConnectingIp: string | undefined): string {
  if (cfConnectingIp !== undefined && classifySource(source) === 'loopback') return cfConnectingIp
  return source ?? 'unknown'
}
