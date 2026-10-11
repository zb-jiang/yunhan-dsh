/** identity.ts 单测：闸门二同账号校验、正向缓存 TTL/LRU、负向不缓存。 */
import { describe, expect, it, vi } from 'vitest'
import { IDENTITY_CACHE_MAX_ENTRIES, IdentityChecker } from '../src/identity.ts'

const T0 = 1_700_000_000_000

function createHarness(options: {
  desktopUserId?: string
  resolveTo?: string
  reject?: boolean
}) {
  let clock = T0
  const now = vi.fn(() => clock)
  const getUserByToken = vi.fn(async () => {
    if (options.reject) throw new Error('token verification failed')
    return { id: options.resolveTo ?? 'user-a' }
  })
  const checker = new IdentityChecker(
    {
      getCurrentUser: () =>
        options.desktopUserId === undefined ? undefined : { id: options.desktopUserId },
      getUserByToken,
    },
    now,
  )
  return {
    checker,
    getUserByToken,
    advance: (ms: number): void => {
      clock += ms
    },
  }
}

describe('IdentityChecker', () => {
  it('桌面未登录直接拒绝且不调用 token 解析', async () => {
    const { checker, getUserByToken } = createHarness({})
    const result = await checker.check('token-a')
    expect(result).toEqual({ ok: false, reason: 'desktop-login-required' })
    expect(getUserByToken).not.toHaveBeenCalled()
  })

  it('同账号校验通过', async () => {
    const { checker } = createHarness({ desktopUserId: 'user-a', resolveTo: 'user-a' })
    expect(await checker.check('token-a')).toEqual({ ok: true })
  })

  it('异账号拒绝并携带 presentedUserId', async () => {
    const { checker } = createHarness({ desktopUserId: 'user-a', resolveTo: 'user-b' })
    const result = await checker.check('token-b')
    expect(result).toEqual({ ok: false, reason: 'identity-mismatch', presentedUserId: 'user-b' })
  })

  it('token 解析失败归并 identity-mismatch 且不带 presentedUserId', async () => {
    const { checker } = createHarness({ desktopUserId: 'user-a', reject: true })
    const result = await checker.check('garbage-token')
    expect(result).toEqual({ ok: false, reason: 'identity-mismatch' })
    expect(!result.ok && result.presentedUserId).toBeUndefined()
  })

  it('正向缓存命中后不再调用 token 解析', async () => {
    const { checker, getUserByToken } = createHarness({ desktopUserId: 'user-a', resolveTo: 'user-a' })
    await checker.check('token-a')
    await checker.check('token-a')
    expect(getUserByToken).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后重新调用 token 解析', async () => {
    const { checker, getUserByToken, advance } = createHarness({
      desktopUserId: 'user-a',
      resolveTo: 'user-a',
    })
    await checker.check('token-a')
    advance(5 * 60_000)
    await checker.check('token-a')
    expect(getUserByToken).toHaveBeenCalledTimes(2)
  })

  it('负向不缓存：解析失败后同 token 再次校验仍会调用解析', async () => {
    const harness = createHarness({ desktopUserId: 'user-a', reject: true })
    await harness.checker.check('token-a')
    // 攻击者换有效身份前先确认拒绝路径未写缓存
    harness.getUserByToken.mockImplementation(async () => ({ id: 'user-a' }))
    const result = await harness.checker.check('token-a')
    expect(result).toEqual({ ok: true })
    expect(harness.getUserByToken).toHaveBeenCalledTimes(2)
  })

  it('缓存满后淘汰最旧条目', async () => {
    const { checker, getUserByToken } = createHarness({ desktopUserId: 'user-a', resolveTo: 'user-a' })
    for (let i = 0; i < IDENTITY_CACHE_MAX_ENTRIES; i++) {
      await checker.check(`token-${i}`)
    }
    expect(getUserByToken).toHaveBeenCalledTimes(IDENTITY_CACHE_MAX_ENTRIES)
    // 插入新条目触发淘汰最旧的 token-0
    await checker.check('token-new')
    expect(getUserByToken).toHaveBeenCalledTimes(IDENTITY_CACHE_MAX_ENTRIES + 1)
    // 被淘汰的 token-0 再次校验触发重新解析
    await checker.check('token-0')
    expect(getUserByToken).toHaveBeenCalledTimes(IDENTITY_CACHE_MAX_ENTRIES + 2)
    // token-0 重插入按插入序挤掉次旧的 token-1，token-1 也已淘汰触发解析
    await checker.check('token-1')
    expect(getUserByToken).toHaveBeenCalledTimes(IDENTITY_CACHE_MAX_ENTRIES + 3)
  })

  it('缓存命中但桌面身份已切换时拒绝', async () => {
    let desktopId = 'user-a'
    const getUserByToken = vi.fn(async () => ({ id: 'user-a' }))
    const checker = new IdentityChecker(
      {
        getCurrentUser: () => ({ id: desktopId }),
        getUserByToken,
      },
      () => T0,
    )
    expect(await checker.check('token-a')).toEqual({ ok: true })
    // 桌面切到 user-b：缓存命中（不再调用解析），但与桌面当前身份的比较实时进行
    desktopId = 'user-b'
    const result = await checker.check('token-a')
    expect(result).toEqual({ ok: false, reason: 'identity-mismatch', presentedUserId: 'user-a' })
    expect(getUserByToken).toHaveBeenCalledTimes(1)
  })
})
