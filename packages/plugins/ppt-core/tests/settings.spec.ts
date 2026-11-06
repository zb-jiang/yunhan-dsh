import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings, isConfigured, knownBackends, publicView, readSettings, renderDotEnv, settingsFile, writeSettings } from '../src/settings.ts'

describe('settingsFile', () => {
  it('落在 dshHome 下的 ppt/settings.json', () => {
    expect(settingsFile('/home')).toBe(join('/home', 'ppt', 'settings.json'))
  })
})

describe('readSettings', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ppt-settings-'))
    roots.push(dir)
    return dir
  }

  it('文件缺失回默认值', () => {
    expect(readSettings(join(scratch(), 'absent.json'))).toEqual(defaultSettings())
  })

  it('损坏 JSON 回默认值', () => {
    const file = join(scratch(), 'broken.json')
    writeFileSync(file, '{not json', 'utf8')
    expect(readSettings(file)).toEqual(defaultSettings())
  })

  it('非对象 JSON 回默认值', () => {
    const file = join(scratch(), 'array.json')
    writeFileSync(file, '[1]', 'utf8')
    expect(readSettings(file)).toEqual(defaultSettings())
  })

  it('字段类型不对时逐字段归一为空串', () => {
    const file = join(scratch(), 'mixed.json')
    writeFileSync(file, JSON.stringify({ imageBackend: 3, imageApiKey: null, imageBaseUrl: true, imageModel: ['x'] }), 'utf8')
    expect(readSettings(file)).toEqual(defaultSettings())
  })

  it('完整设置原样读回', () => {
    const file = join(scratch(), 'full.json')
    writeFileSync(file, JSON.stringify({ imageBackend: 'openai', imageApiKey: 'k', imageBaseUrl: 'https://x', imageModel: 'm' }), 'utf8')
    expect(readSettings(file)).toEqual({ imageBackend: 'openai', imageApiKey: 'k', imageBaseUrl: 'https://x', imageModel: 'm' })
  })
})

describe('writeSettings', () => {
  it('自动建父目录并带尾换行', () => {
    const root = mkdtempSync(join(tmpdir(), 'ppt-write-'))
    try {
      const file = join(root, 'nested', 'settings.json')
      writeSettings(file, { imageBackend: 'gemini', imageApiKey: 'k', imageBaseUrl: '', imageModel: '' })
      expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify({ imageBackend: 'gemini', imageApiKey: 'k', imageBaseUrl: '', imageModel: '' }, null, 2)}\n`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('isConfigured', () => {
  it('后端与 key 都非空才算配置完成', () => {
    expect(isConfigured({ imageBackend: 'openai', imageApiKey: 'k', imageBaseUrl: '', imageModel: '' })).toBe(true)
    expect(isConfigured({ imageBackend: 'openai', imageApiKey: '', imageBaseUrl: '', imageModel: '' })).toBe(false)
    expect(isConfigured({ imageBackend: '', imageApiKey: 'k', imageBaseUrl: '', imageModel: '' })).toBe(false)
  })
})

describe('publicView', () => {
  it('摘要含 configured/knownBackends 且绝无 apiKey', () => {
    const view = publicView({ imageBackend: 'openai', imageApiKey: 'secret', imageBaseUrl: 'https://x', imageModel: 'm' })
    expect(view).toEqual({ configured: true, imageBackend: 'openai', imageBaseUrl: 'https://x', imageModel: 'm', knownBackends: knownBackends() })
    expect(JSON.stringify(view)).not.toContain('secret')
  })
})

describe('renderDotEnv', () => {
  it('未配置返回空串', () => {
    expect(renderDotEnv(defaultSettings())).toBe('')
  })

  it('未知后端返回空串', () => {
    expect(renderDotEnv({ imageBackend: 'nope', imageApiKey: 'k', imageBaseUrl: '', imageModel: '' })).toBe('')
  })

  it('openai 完整输出含后端/key/模型/地址', () => {
    expect(renderDotEnv({ imageBackend: 'openai', imageApiKey: 'k1', imageBaseUrl: 'https://b', imageModel: 'gpt' }))
      .toBe('IMAGE_BACKEND=openai\nOPENAI_API_KEY=k1\nOPENAI_MODEL=gpt\nOPENAI_BASE_URL=https://b\n')
  })

  it('volcengine 的 key 变量是 LAS_API_KEY', () => {
    expect(renderDotEnv({ imageBackend: 'volcengine', imageApiKey: 'k2', imageBaseUrl: '', imageModel: '' }))
      .toBe('IMAGE_BACKEND=volcengine\nLAS_API_KEY=k2\n')
  })

  it('模型与地址为空时不输出对应行', () => {
    expect(renderDotEnv({ imageBackend: 'qwen', imageApiKey: 'k3', imageBaseUrl: 'https://b', imageModel: '' }))
      .toBe('IMAGE_BACKEND=qwen\nQWEN_API_KEY=k3\nQWEN_BASE_URL=https://b\n')
  })
})

describe('settingsFile 与 dshHomePath 的生产路径', () => {
  it('注入 DSH_HOME 时按环境解析', () => {
    const root = mkdtempSync(join(tmpdir(), 'ppt-dshhome-'))
    try {
      process.env.DSH_HOME = root
      const file = settingsFile()
      expect(file).toBe(join(root, 'ppt', 'settings.json'))
      writeSettings(file, defaultSettings())
      expect(existsSync(join(root, 'ppt', 'settings.json'))).toBe(true)
      mkdirSync(join(root, 'noop'), { recursive: true })
    } finally {
      delete process.env.DSH_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })
})
