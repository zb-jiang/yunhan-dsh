import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, Config, name, statusPayload, type Config as ConfigShape } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 面向 apply() 的宿主桩:收集 webServer 路由、systemPrompt 段与 skill 注册工厂。 */
interface HostStub {
  webServer: { routes: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }[] }
  systemPrompt: { sections: { name: string; text: string; order: number }[] }
  skills: { factories: (() => { name: string; list: (options: never) => Promise<unknown> })[] }
}

function hostStub(): HostStub {
  return {
    webServer: {
      routes: [],
    },
    systemPrompt: {
      sections: [],
    },
    skills: {
      factories: [],
    },
  }
}

/**
 * 测试桩只实现被测函数触碰的 Context 成员;object 入参保证单一断言可收窄,
 * 避免引入基线禁令的 `as unknown`。
 */
function stubContext(stub: object): Context {
  return stub as Context
}

/** 响应桩同样只实现 handler 触碰的成员。 */
function stubServerResponse(stub: object): ServerResponse {
  return stub as ServerResponse
}

function ctxOf(host: HostStub): Context {
  const ctx = {
    effect: <T>(execute: () => T, _label?: string) => execute(),
    webServer: {
      register: (route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        host.webServer.routes.push(route)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section: { name: string; text: string; order: number }) => {
        host.systemPrompt.sections.push(section)
        return () => {}
      },
    },
    skills: {
      registerProvider: (factory: () => { name: string; list: (options: never) => Promise<unknown> }) => {
        host.skills.factories.push(factory)
        return () => {}
      },
    },
  }
  return stubContext(ctx)
}

const roots: string[] = []
afterEach(() => {
  delete process.env.DSH_HOME
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
})

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ppt-index-'))
  roots.push(home)
  process.env.DSH_HOME = home
})

function writtenEnv(): string | undefined {
  const envFile = join(home, 'ppt', 'skills', 'ppt-master', '.env')
  return existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined
}

describe('Config schema', () => {
  it('空对象归一为四空串', () => {
    expect(Config({})).toEqual({ imageBackend: '', imageApiKey: '', imageBaseUrl: '', imageModel: '' })
  })
})

describe('statusPayload', () => {
  it('健康载荷固定', () => {
    expect(statusPayload()).toEqual({ ok: true, plugin: 'ppt' })
  })
})

describe('apply', () => {
  it('注册 /api/ppt 路由、prompt 段与单一 skill provider;未配置时不写 .env', async () => {
    const host = hostStub()
    apply(ctxOf(host), {})
    expect(name).toBe('ppt-core')
    expect(host.webServer.routes.map(route => route.path)).toEqual(['/api/ppt'])
    expect(host.systemPrompt.sections).toHaveLength(1)
    expect(host.systemPrompt.sections[0]?.name).toBe('ppt:capability')
    expect(host.systemPrompt.sections[0]?.text).toContain('SKILL.md')
    expect(host.skills.factories).toHaveLength(1)
    expect(writtenEnv()).toBeUndefined()
  }, 30_000)

  it('Config 作为种子:文件缺失时按配置写 .env;RPC 路由可完成 status 请求', async () => {
    const host = hostStub()
    const config: ConfigShape = { imageBackend: 'openai', imageApiKey: 'seed-key', imageBaseUrl: '', imageModel: 'gpt' }
    apply(ctxOf(host), config)
    expect(writtenEnv()).toBe('IMAGE_BACKEND=openai\nOPENAI_API_KEY=seed-key\nOPENAI_MODEL=gpt\n')
    const handler = host.webServer.routes[0]?.handler
    if (handler === undefined) throw new Error('expected /api/ppt handler')
    const req = new EventEmitter() as IncomingMessage
    req.method = 'GET'
    req.url = '/api/ppt/status'
    req.headers = {}
    const chunks: Buffer[] = []
    let status = 0
    const res = stubServerResponse({
      writeHead: (code: number) => { status = code; return res },
      end: (body?: Buffer | string) => {
        chunks.push(typeof body === 'string' ? Buffer.from(body, 'utf8') : body ?? Buffer.alloc(0))
        return res
      },
    })
    await handler(req, res)
    expect(status).toBe(200)
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ ok: true, plugin: 'ppt' })
  }, 30_000)

  it('设置文件已存在时种子不覆盖(以设置页为准)', () => {
    const host = hostStub()
    mkdirSync(join(home, 'ppt'), { recursive: true })
    writeFileSync(join(home, 'ppt', 'settings.json'), JSON.stringify({ imageBackend: 'gemini', imageApiKey: 'saved', imageBaseUrl: '', imageModel: '' }), 'utf8')
    apply(ctxOf(host), { imageBackend: 'openai', imageApiKey: 'seed', imageBaseUrl: '', imageModel: '' })
    expect(writtenEnv()).toBe('IMAGE_BACKEND=gemini\nGEMINI_API_KEY=saved\n')
  }, 30_000)

  it('skill provider 工厂产出 ppt-master 候选(副本已拷贝)', async () => {
    const host = hostStub()
    apply(ctxOf(host), {})
    const factory = host.skills.factories[0]
    if (factory === undefined) throw new Error('expected one skill provider factory')
    const provider = factory()
    const listed = await provider.list(undefined as never)
    const candidates = Array.isArray(listed) ? listed : []
    expect(candidates[0]).toMatchObject({ name: 'ppt-master' })
  }, 30_000)

  it('启动回放同步:真身新增 style 写回重拷后的 skill 树与 index', () => {
    const stylesRoot = join(home, 'ppt-templates', 'styles')
    mkdirSync(join(stylesRoot, 'distilled'), { recursive: true })
    writeFileSync(join(stylesRoot, 'distilled', 'design_spec.md'), '---\nstyle_id: distilled\nkind: style\nsummary: 一句话\nkeywords: [a, b, c]\n---\n正文', 'utf8')
    const host = hostStub()
    apply(ctxOf(host), {})
    const synced = join(home, 'ppt', 'skills', 'ppt-master', 'templates', 'styles', 'distilled', 'templates', 'design_spec.md')
    expect(existsSync(synced)).toBe(true)
    const index = JSON.parse(readFileSync(join(home, 'ppt', 'skills', 'ppt-master', 'templates', 'styles', 'styles_index.json'), 'utf8')) as Record<string, unknown>
    expect(index['distilled']).toEqual({ summary: '一句话', keywords: ['a', 'b', 'c'] })
  }, 30_000)
})
