/** handshake.ts 单测：注入判定、URL 改写、Safari 过渡页、按 IP 注入限速。 */
import { describe, expect, it, vi } from 'vitest'
import {
  HANDSHAKE_INJECTION_LIMIT,
  HandshakeManager,
  hasAuthCookie,
  hasReauthFlag,
  isHtmlNavigation,
  parseCookieNames,
  parseTokenFromUrl,
} from '../src/handshake.ts'

const T0 = 1_700_000_000_000

function createManager() {
  let clock = T0
  const manager = new HandshakeManager({ getLaunchToken: async () => 'token-x' }, () => clock)
  return {
    manager,
    advance: (ms: number): void => {
      clock += ms
    },
  }
}

describe('parseTokenFromUrl', () => {
  it('解析 ?token= 值', () => {
    expect(parseTokenFromUrl('http://127.0.0.1:3080/?token=abc123')).toBe('abc123')
  })

  it('无 token 参数返回空串', () => {
    expect(parseTokenFromUrl('http://127.0.0.1:3080/')).toBe('')
  })

  it('非法 URL 返回空串', () => {
    expect(parseTokenFromUrl('not a url')).toBe('')
  })
})

describe('parseCookieNames', () => {
  it('解析多个 cookie 名', () => {
    expect(parseCookieNames('dsh-auth-abc=tok; other=1')).toEqual(['dsh-auth-abc', 'other'])
  })

  it('undefined 与空串返回空列表', () => {
    expect(parseCookieNames(undefined)).toEqual([])
    expect(parseCookieNames('')).toEqual([])
  })

  it('值中的等号不影响名字切分', () => {
    expect(parseCookieNames('a=b=c')).toEqual(['a'])
  })
})

describe('hasAuthCookie', () => {
  it('dsh-auth- 前缀成员判定为有', () => {
    expect(hasAuthCookie('foo=1; dsh-auth-abcd=tok')).toBe(true)
  })

  it('无前缀成员判定为无', () => {
    expect(hasAuthCookie('dsh-pocket-device=x')).toBe(false)
    expect(hasAuthCookie(undefined)).toBe(false)
  })
})

describe('isHtmlNavigation', () => {
  it('Accept 含 text/html 判定为导航', () => {
    expect(isHtmlNavigation('text/html,application/xhtml+xml')).toBe(true)
    expect(isHtmlNavigation('application/json')).toBe(false)
    expect(isHtmlNavigation(undefined)).toBe(false)
  })
})

describe('hasReauthFlag', () => {
  it('__pocket_reauth=1 判定为强制重握手', () => {
    expect(hasReauthFlag('/?__pocket_reauth=1')).toBe(true)
    expect(hasReauthFlag('/?__pocket_reauth=0')).toBe(false)
    expect(hasReauthFlag('/')).toBe(false)
  })
})

describe('HandshakeManager.isInjectCandidate', () => {
  it('GET / 且无认证 cookie 为候选', () => {
    const { manager } = createManager()
    expect(
      manager.isInjectCandidate({ method: 'GET', path: '/', cookieHeader: undefined, reauth: false }),
    ).toBe(true)
  })

  it('已带认证 cookie 且无重握手标记不注入（防 303 死循环）', () => {
    const { manager } = createManager()
    expect(
      manager.isInjectCandidate({
        method: 'GET',
        path: '/',
        cookieHeader: 'dsh-auth-abc=tok',
        reauth: false,
      }),
    ).toBe(false)
  })

  it('带认证 cookie 但 __pocket_reauth=1 时强制重握手', () => {
    const { manager } = createManager()
    expect(
      manager.isInjectCandidate({
        method: 'GET',
        path: '/',
        cookieHeader: 'dsh-auth-abc=tok',
        reauth: true,
      }),
    ).toBe(true)
  })

  it('非根路径与非 GET 请求不是候选', () => {
    const { manager } = createManager()
    expect(
      manager.isInjectCandidate({ method: 'GET', path: '/api/x', cookieHeader: undefined, reauth: false }),
    ).toBe(false)
    expect(
      manager.isInjectCandidate({ method: 'POST', path: '/', cookieHeader: undefined, reauth: false }),
    ).toBe(false)
  })
})

describe('HandshakeManager.buildUpstreamUrl', () => {
  it('补 token 并剥除重握手参数、保留其余 query', () => {
    const { manager } = createManager()
    expect(manager.buildUpstreamUrl('/?__pocket_reauth=1&foo=bar', 'tok')).toBe('/?foo=bar&token=tok')
    expect(manager.buildUpstreamUrl('/', 'tok')).toBe('/?token=tok')
  })
})

describe('HandshakeManager Safari 过渡页', () => {
  it('仅本轮已注入 token 的上游 303 改写', () => {
    const { manager } = createManager()
    expect(manager.shouldRewriteRedirect({ upstreamStatusCode: 303, injectedToken: true })).toBe(true)
    expect(manager.shouldRewriteRedirect({ upstreamStatusCode: 303, injectedToken: false })).toBe(false)
    expect(manager.shouldRewriteRedirect({ upstreamStatusCode: 200, injectedToken: true })).toBe(false)
  })

  it('过渡页含 meta refresh 跳根路径', () => {
    const { manager } = createManager()
    const html = manager.renderInterimPage()
    expect(html).toContain('http-equiv="refresh"')
    expect(html).toContain('url=/')
  })
})

describe('HandshakeManager 注入限速', () => {
  it('窗口内达到上限后 limited', () => {
    const { manager } = createManager()
    const ip = '192.168.1.9'
    for (let i = 0; i < HANDSHAKE_INJECTION_LIMIT; i++) {
      expect(manager.isLimited(ip)).toBe(false)
      manager.noteInjection(ip)
    }
    expect(manager.isLimited(ip)).toBe(true)
  })

  it('窗口滚动后重新允许', () => {
    const { manager, advance } = createManager()
    const ip = '192.168.1.9'
    for (let i = 0; i < HANDSHAKE_INJECTION_LIMIT; i++) manager.noteInjection(ip)
    expect(manager.isLimited(ip)).toBe(true)
    advance(60_000)
    expect(manager.isLimited(ip)).toBe(false)
  })

  it('带认证 cookie 的请求清零该 IP 计数', () => {
    const { manager } = createManager()
    const ip = '192.168.1.9'
    manager.noteInjection(ip)
    manager.noteInjection(ip)
    manager.clearIfAuthenticated('dsh-auth-abc=tok', ip)
    expect(manager.isLimited(ip)).toBe(false)
  })

  it('不同 IP 计数独立', () => {
    const { manager } = createManager()
    for (let i = 0; i < HANDSHAKE_INJECTION_LIMIT; i++) manager.noteInjection('10.0.0.1')
    expect(manager.isLimited('10.0.0.1')).toBe(true)
    expect(manager.isLimited('10.0.0.2')).toBe(false)
  })
})

describe('HandshakeManager.getLaunchToken', () => {
  it('每次即时取用透传依赖结果', async () => {
    const getLaunchToken = vi.fn(async () => 'tok-1')
    const manager = new HandshakeManager({ getLaunchToken })
    await expect(manager.getLaunchToken()).resolves.toBe('tok-1')
    await expect(manager.getLaunchToken()).resolves.toBe('tok-1')
    expect(getLaunchToken).toHaveBeenCalledTimes(2)
  })
})
