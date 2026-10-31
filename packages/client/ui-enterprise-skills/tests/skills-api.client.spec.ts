// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSkillsCatalog, importSkillZip, installSkillhubSkill, uninstallSkill,
  SkillRequestError,
} from '../src/client/skills-api.ts'

/** 构造 JSON Response;statusText 模拟 Node webserver 的标准 reason phrase。 */
function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } })
}

describe('skills-api', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('getSkillsCatalog 携带 Bearer 令牌并解包响应', async () => {
    localStorage.setItem('dsh.enterprise.token', 'jwt-a')
    const catalog = { authenticated: true, catalogOpen: true, namespaces: [], local: [] }
    fetchMock.mockResolvedValue(jsonResponse(200, catalog))
    await expect(getSkillsCatalog()).resolves.toEqual(catalog)
    const [input, init] = fetchMock.mock.calls[0]!
    expect(input).toBe('api/enterprise/skills/catalog')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer jwt-a')
  })

  it('无令牌时不带 authorization 头', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { authenticated: false, catalogOpen: false, namespaces: [], local: [] }))
    await getSkillsCatalog()
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has('authorization')).toBe(false)
  })

  it('非 2xx 抛出携带状态码的 SkillRequestError', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(403, { error: '由流程要求安装，不可卸载' }, 'Forbidden'))
    await expect(uninstallSkill('expense-form')).rejects.toThrow(SkillRequestError)
    await expect(uninstallSkill('expense-form')).rejects.toMatchObject({
      status: 403,
      message: '由流程要求安装，不可卸载',
    })
  })

  it('非 JSON 响应体按原文作为错误 message', async () => {
    fetchMock.mockResolvedValue(new Response('gateway down', { status: 502 }))
    await expect(uninstallSkill('expense-form')).rejects.toMatchObject({ status: 502, message: 'gateway down' })
  })

  it('401 响应保留状态码供面板提示登录', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: '登录凭证无效或已过期' }))
    await expect(uninstallSkill('expense-form')).rejects.toMatchObject({ status: 401 })
  })

  it('installSkillhubSkill 发送 POST JSON 体', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { alreadyInstalled: false }))
    await installSkillhubSkill('dsh-demo', 'expense-form')
    const [input, init] = fetchMock.mock.calls[0]!
    expect(input).toBe('api/enterprise/skills/install')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(init?.body).toBe(JSON.stringify({ namespace: 'dsh-demo', slug: 'expense-form' }))
  })

  it('uninstallSkill 发送 POST JSON 体', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    await uninstallSkill('expense-form')
    const [input, init] = fetchMock.mock.calls[0]!
    expect(input).toBe('api/enterprise/skills/uninstall')
    expect(init?.body).toBe(JSON.stringify({ slug: 'expense-form' }))
  })

  it('importSkillZip 发送 zip 原始字节体并返回技能名', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { name: 'expense-form' }))
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    await expect(importSkillZip(bytes)).resolves.toBe('expense-form')
    const [input, init] = fetchMock.mock.calls[0]!
    expect(input).toBe('api/enterprise/skills/import')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/zip')
    expect(init?.body).toBe(bytes)
  })
})
