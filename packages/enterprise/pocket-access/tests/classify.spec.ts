import { describe, expect, it } from 'vitest'
import {
  NETWORK_RANGES,
  classifyHost,
  classifySource,
  isPrivateIpv4,
  normalizeHost,
  policyHost,
  resolveClientIp,
} from '../src/classify.ts'

describe('normalizeHost', () => {
  it('剥离端口与方括号并小写化', () => {
    expect(normalizeHost('192.168.1.5:3080')).toBe('192.168.1.5')
    expect(normalizeHost('[::1]:3080')).toBe('::1')
    expect(normalizeHost('Example.COM:80')).toBe('example.com')
    expect(normalizeHost('LOCALHOST')).toBe('localhost')
  })

  it('裸 IPv6 字面量不被当作端口切分', () => {
    expect(normalizeHost('fe80::1')).toBe('fe80::1')
  })

  it('空值返回 null', () => {
    expect(normalizeHost(undefined)).toBeNull()
    expect(normalizeHost(null)).toBeNull()
    expect(normalizeHost('  ')).toBeNull()
  })
})

describe('classifyHost', () => {
  it('loopback 行：localhost/0.0.0.0/::1/127 段/空值', () => {
    expect(classifyHost('localhost')).toBe('loopback')
    expect(classifyHost('0.0.0.0')).toBe('loopback')
    expect(classifyHost('::1')).toBe('loopback')
    expect(classifyHost('[::1]:3080')).toBe('loopback')
    expect(classifyHost('127.0.0.1')).toBe('loopback')
    expect(classifyHost('127.255.0.9')).toBe('loopback')
    expect(classifyHost(undefined)).toBe('loopback')
    expect(classifyHost('')).toBe('loopback')
  })

  it('lan 行：RFC1918/CGNAT/.local/单标签/fe80/ULA', () => {
    expect(classifyHost('10.1.2.3')).toBe('lan')
    expect(classifyHost('172.16.0.1')).toBe('lan')
    expect(classifyHost('172.31.255.255')).toBe('lan')
    expect(classifyHost('192.168.1.50')).toBe('lan')
    expect(classifyHost('100.64.0.1')).toBe('lan')
    expect(classifyHost('100.127.255.254')).toBe('lan')
    expect(classifyHost('mypc.local')).toBe('lan')
    expect(classifyHost('mypc')).toBe('lan')
    expect(classifyHost('fe80::1')).toBe('lan')
    expect(classifyHost('fd12:3456::1')).toBe('lan')
  })

  it('CGNAT 边界之外是公网', () => {
    expect(classifyHost('100.63.255.255')).toBe('public')
    expect(classifyHost('100.128.0.0')).toBe('public')
  })

  it('其余一切是公网（含 link-local IPv4）', () => {
    expect(classifyHost('8.8.8.8')).toBe('public')
    expect(classifyHost('169.254.1.1')).toBe('public')
    expect(classifyHost('example.com')).toBe('public')
  })

  it('裸 IPv6 兜底 loopback（历史行为，防误伤本机）', () => {
    expect(classifyHost('2001:db8::1')).toBe('loopback')
    expect(classifyHost('::')).toBe('loopback')
  })

  it('前导零 IPv4 解析不出，按 public 收紧', () => {
    expect(classifyHost('010.1.1.1')).toBe('public')
  })
})

describe('classifySource', () => {
  it('loopback 行：127 段/::1/169.254 段', () => {
    expect(classifySource('127.0.0.1')).toBe('loopback')
    expect(classifySource('::1')).toBe('loopback')
    expect(classifySource('169.254.9.9')).toBe('loopback')
  })

  it('lan 行：RFC1918/CGNAT/fe80/ULA，IPv4-mapped 形式同样识别', () => {
    expect(classifySource('192.168.1.77')).toBe('lan')
    expect(classifySource('10.0.0.9')).toBe('lan')
    expect(classifySource('100.100.1.1')).toBe('lan')
    expect(classifySource('fe80::1%eth0')).toBe('lan')
    expect(classifySource('fd00::9')).toBe('lan')
    expect(classifySource('::ffff:192.168.1.5')).toBe('lan')
    expect(classifySource('::ffff:127.0.0.1')).toBe('loopback')
  })

  it('public 行与其余兜底一律收紧', () => {
    expect(classifySource('8.8.8.8')).toBe('public')
    expect(classifySource('2001:db8::1')).toBe('public')
    expect(classifySource(undefined)).toBe('public')
    expect(classifySource('')).toBe('public')
  })

  it('兜底方向与 classifyHost 相反：同一裸 IPv6 两侧结论不同', () => {
    expect(classifyHost('2001:db8::1')).toBe('loopback')
    expect(classifySource('2001:db8::1')).toBe('public')
  })
})

describe('policyHost 只收紧不放松', () => {
  it('伪造 Host: 127.0.0.1 的公网来源被源地址覆盖为 public', () => {
    expect(policyHost('127.0.0.1', '203.0.113.9')).toBe('public')
    expect(policyHost('localhost', '192.168.1.8')).toBe('lan')
  })

  it('方向不能反：隧道流量（Host 公网域名 + 源 loopback）不被降级', () => {
    expect(policyHost('tunnel.example.com', '127.0.0.1')).toBe('public')
    expect(policyHost('192.168.1.50', '127.0.0.1')).toBe('lan')
  })

  it('源与 Host 同级或更松时维持 Host 声明', () => {
    expect(policyHost('192.168.1.50', '192.168.1.77')).toBe('lan')
    expect(policyHost('192.168.1.50', '127.0.0.1')).toBe('lan')
    expect(policyHost('example.com', '127.0.0.1')).toBe('public')
  })
})

describe('resolveClientIp', () => {
  it('仅 loopback 源认 cf-connecting-ip（隧道回连）', () => {
    expect(resolveClientIp('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7')
  })

  it('非 loopback 源一律 socket 源地址', () => {
    expect(resolveClientIp('192.168.1.77', '203.0.113.7')).toBe('192.168.1.77')
  })

  it('缺失时回退 unknown', () => {
    expect(resolveClientIp(undefined, undefined)).toBe('unknown')
  })
})

describe('NETWORK_RANGES 常量表', () => {
  it('冻结防篡改，供分类器与 LAN 打分三处共用', () => {
    expect(Object.isFrozen(NETWORK_RANGES)).toBe(true)
    expect(Object.isFrozen(NETWORK_RANGES.ipv4)).toBe(true)
    expect(Object.isFrozen(NETWORK_RANGES.ipv6)).toBe(true)
  })

  it('isPrivateIpv4 覆盖 RFC1918 与 CGNAT', () => {
    expect(isPrivateIpv4('192.168.1.50')).toBe(true)
    expect(isPrivateIpv4('10.9.9.9')).toBe(true)
    expect(isPrivateIpv4('172.20.1.1')).toBe(true)
    expect(isPrivateIpv4('100.119.24.44')).toBe(true)
    expect(isPrivateIpv4('8.8.8.8')).toBe(false)
    expect(isPrivateIpv4('169.254.1.1')).toBe(false)
    expect(isPrivateIpv4('not-an-ip')).toBe(false)
  })
})
