import { describe, expect, it } from 'vitest'
import {
  LanDetector,
  isWslEnvironment,
  parseIpconfigOutput,
  scoreInterface,
} from '../src/lan.ts'
import type { NetworkInterfaceInfo } from 'node:os'

const info = (address: string): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', netmask: '255.255.255.0', cidr: null })

const interfaces = (table: Record<string, NetworkInterfaceInfo[]>): NodeJS.Dict<readonly NetworkInterfaceInfo[]> =>
  table

describe('scoreInterface 打分矩阵', () => {
  it('Radmin 虚拟网卡不遮 WLAN 物理网卡', () => {
    const wlan = scoreInterface('WLAN', '192.168.1.50')
    const radmin = scoreInterface('Radmin VPN', '100.119.24.44')
    expect(wlan).toBeGreaterThan(radmin)
  })

  it('私网 +100、物理名 +20、虚拟名 −50', () => {
    expect(scoreInterface('WLAN', '192.168.1.50')).toBe(120)
    expect(scoreInterface('Radmin VPN', '100.119.24.44')).toBe(50)
    expect(scoreInterface('Tailscale', '100.64.0.9')).toBe(50)
    expect(scoreInterface('本地连接', '192.168.0.10')).toBe(120)
    expect(scoreInterface('eth0', '10.0.0.5')).toBe(120)
  })

  it('公网 IP 无私网加分', () => {
    expect(scoreInterface('Ethernet', '203.0.113.9')).toBe(20)
  })
})

describe('LanDetector 候选解析', () => {
  it('双私网卡时打分降序、同分保持枚举序', async () => {
    const detector = new LanDetector({
      detectWsl: async () => false,
      listInterfaces: () =>
        interfaces({
          WLAN: [info('192.168.1.50')],
          '以太网': [info('10.0.0.5')],
          Tailscale: [info('100.64.0.9')],
        }),
    })
    const resolution = await detector.resolve('')
    expect(resolution.primary).toBe('192.168.1.50')
    expect(resolution.candidates).toEqual(['192.168.1.50', '10.0.0.5', '100.64.0.9'])
  })

  it('纯 VPN 环境回退最高分（无私网跳过即不可用的口子）', async () => {
    const detector = new LanDetector({
      detectWsl: async () => false,
      listInterfaces: () => interfaces({ Tailscale: [info('100.64.0.9')] }),
    })
    const resolution = await detector.resolve('')
    expect(resolution.candidates).toEqual(['100.64.0.9'])
    expect(resolution.primary).toBe('100.64.0.9')
  })

  it('internal 与 loopback/link-local 地址直接跳过', async () => {
    const detector = new LanDetector({
      detectWsl: async () => false,
      listInterfaces: () =>
        interfaces({
          'Loopback Pseudo-Interface': [
            { address: '127.0.0.1', family: 'IPv4', internal: true, mac: '', netmask: '', cidr: null },
            info('169.254.3.3'),
          ],
          WLAN: [info('192.168.1.50')],
        }),
    })
    const resolution = await detector.resolve('')
    expect(resolution.candidates).toEqual(['192.168.1.50'])
  })

  it('手动覆盖优先且去重', async () => {
    const detector = new LanDetector({
      detectWsl: async () => false,
      listInterfaces: () => interfaces({ WLAN: [info('192.168.1.50')] }),
    })
    const resolution = await detector.resolve('192.168.1.50')
    expect(resolution.primary).toBe('192.168.1.50')
    expect(resolution.candidates).toEqual(['192.168.1.50'])
  })

  it('结果缓存 15s：窗口内重复 resolve 不再枚举', async () => {
    let calls = 0
    let now = 1_000
    const detector = new LanDetector({
      detectWsl: async () => false,
      listInterfaces: () => {
        calls += 1
        return interfaces({ WLAN: [info('192.168.1.50')] })
      },
      now: () => now,
    })
    await detector.resolve('')
    await detector.resolve('')
    now += 10_000
    await detector.resolve('')
    expect(calls).toBe(1)
    now += 6_000
    await detector.resolve('')
    expect(calls).toBe(2)
  })
})

describe('parseIpconfigOutput 中英文解析', () => {
  it('英文输出：取每块首个 IPv4，跳过 VPN 块', () => {
    const output = [
      'Windows IP Configuration',
      '',
      'Ethernet adapter Ethernet:',
      '',
      '   Connection-specific DNS Suffix  . : lan',
      '   Link-local IPv6 Address . . . . . : fe80::1%12',
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.50',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '',
      'Ethernet adapter Tailscale:',
      '',
      '   IPv4 Address. . . . . . . . . . . : 100.64.0.9',
      '',
    ].join('\n')
    expect(parseIpconfigOutput(output)).toEqual([{ name: 'Ethernet adapter Ethernet:', ip: '192.168.1.50' }])
  })

  it('中文输出：中文块头与 IPv4 地址行同构解析', () => {
    const output = [
      'Windows IP 配置',
      '',
      '无线局域网适配器 WLAN:',
      '',
      '   连接特定的 DNS 后缀 . . . . . . . : lan',
      '   IPv4 地址 . . . . . . . . . . . . : 192.168.1.50',
      '   子网掩码  . . . . . . . . . . . . : 255.255.255.0',
      '',
      '以太网适配器 Radmin VPN:',
      '',
      '   IPv4 地址 . . . . . . . . . . . . : 26.10.20.30',
      '',
    ].join('\n')
    expect(parseIpconfigOutput(output)).toEqual([{ name: '无线局域网适配器 WLAN:', ip: '192.168.1.50' }])
  })

  it('WSL interop 结果参与同一打分（宿主 WLAN 打分最高）', async () => {
    const output = [
      '无线局域网适配器 WLAN:',
      '',
      '   IPv4 地址 . . . . . . . . . . . . : 192.168.1.50',
      '',
      '以太网适配器 vEthernet (WSL):',
      '',
      '   IPv4 地址 . . . . . . . . . . . . : 172.20.0.1',
      '',
    ].join('\n')
    const detector = new LanDetector({
      detectWsl: async () => true,
      readIpconfig: async () => output,
    })
    const resolution = await detector.resolve('')
    expect(resolution.primary).toBe('192.168.1.50')
  })

  it('interop 失败回退本机探测', async () => {
    const detector = new LanDetector({
      detectWsl: async () => true,
      readIpconfig: async () => null,
      listInterfaces: () => interfaces({ WLAN: [info('192.168.1.50')] }),
    })
    const resolution = await detector.resolve('')
    expect(resolution.primary).toBe('192.168.1.50')
  })
})

describe('isWslEnvironment 判据', () => {
  it('WSL_DISTRO_NAME / WSL_INTEROP 即为 WSL', async () => {
    expect(await isWslEnvironment({ WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true)
    expect(await isWslEnvironment({ WSL_INTEROP: '/run/WSL/9_interop' })).toBe(true)
  })

  it('仅 WSLENV 不误判（Windows Terminal 原生也设置它）', async () => {
    const readNothing = async (): Promise<string | null> => null
    expect(await isWslEnvironment({ WSLENV: 'TERM/x' }, readNothing)).toBe(false)
  })

  it('/proc/version 含 microsoft 判 WSL，不含则否', async () => {
    const readMicrosoft = async (): Promise<string | null> => 'Linux version 5.15.0-microsoft-standard-WSL2'
    const readVanilla = async (): Promise<string | null> => 'Linux version 6.1.0-vanilla'
    expect(await isWslEnvironment({}, readMicrosoft)).toBe(true)
    expect(await isWslEnvironment({}, readVanilla)).toBe(false)
  })
})
