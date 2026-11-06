/**
 * 生图配置的落盘读写与 `.env` 渲染(设计 2026-11-04 §5.3/§5.6)。
 *
 * 配置唯一入口是设置页:员工不感知 `.env` 的存在。文件落在 DSH 主目录
 * `ppt/settings.json`;`apiKey` 只存本机,任何读取响应都走 {@link publicView}
 * 摘要,永不回传明文。ppt-master 已废弃通用 `IMAGE_API_KEY`,改按提供商
 * 命名变量,映射表见 {@link backendEnvKeys}。
 *
 * @module
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** 生图四项配置(已归一化,空串 = 未配置);插件 Config 归一化后的落盘形状。 */
export interface ImageSettings {
  /** 生图后端(ppt-master IMAGE_BACKEND 取值,如 openai/gemini)。 */
  imageBackend: string
  /** 生图服务商 API Key(只存员工本机,GET 响应永不回传明文)。 */
  imageApiKey: string
  /** OpenAI 兼容中转基地址;官方端点留空。 */
  imageBaseUrl: string
  /** 生图模型名。 */
  imageModel: string
}

/**
 * 默认设置(全空)。
 * @returns 四项配置全为空串的设置对象。
 */
export function defaultSettings(): ImageSettings {
  return { imageBackend: '', imageApiKey: '', imageBaseUrl: '', imageModel: '' }
}

/**
 * ppt-master 各后端对应的环境变量名(对照上游 `.env.example`)。
 * `volcengine` 的 key 变量是 `LAS_API_KEY`,是映射表存在的理由。
 */
const BACKEND_ENV_KEYS: Record<string, { key: string; model: string; baseUrl: string }> = {
  openai: { key: 'OPENAI_API_KEY', model: 'OPENAI_MODEL', baseUrl: 'OPENAI_BASE_URL' },
  gemini: { key: 'GEMINI_API_KEY', model: 'GEMINI_MODEL', baseUrl: 'GEMINI_BASE_URL' },
  qwen: { key: 'QWEN_API_KEY', model: 'QWEN_MODEL', baseUrl: 'QWEN_BASE_URL' },
  zhipu: { key: 'ZHIPU_API_KEY', model: 'ZHIPU_MODEL', baseUrl: 'ZHIPU_BASE_URL' },
  volcengine: { key: 'LAS_API_KEY', model: 'VOLCENGINE_MODEL', baseUrl: 'VOLCENGINE_BASE_URL' },
  siliconflow: { key: 'SILICONFLOW_API_KEY', model: 'SILICONFLOW_MODEL', baseUrl: 'SILICONFLOW_BASE_URL' },
  minimax: { key: 'MINIMAX_API_KEY', model: 'MINIMAX_MODEL', baseUrl: 'MINIMAX_BASE_URL' },
}

/**
 * 已登记后端名(设置页下拉数据源)。
 * @returns 环境变量映射表覆盖的后端名清单,顺序即声明顺序。
 */
export function knownBackends(): string[] {
  return Object.keys(BACKEND_ENV_KEYS)
}

/**
 * 设置文件路径;`dshHome` 仅测试注入。
 * @param dshHome - DSH 主目录,仅测试注入;缺省走 `dshHomePath`。
 * @returns `ppt/settings.json` 的绝对路径。
 */
export function settingsFile(dshHome?: string): string {
  return dshHome === undefined ? dshHomePath('ppt', 'settings.json') : join(dshHome, 'ppt', 'settings.json')
}

/**
 * 读取设置;文件缺失或损坏时回默认值(损坏静默回退,重写即修复)。
 * @param file - 设置文件绝对路径。
 * @returns 归一化后的设置;文件缺失/损坏或字段类型不符时对应项回空串。
 */
export function readSettings(file: string): ImageSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return defaultSettings()
    const record = parsed as Record<string, unknown>
    return {
      imageBackend: typeof record['imageBackend'] === 'string' ? record['imageBackend'] : '',
      imageApiKey: typeof record['imageApiKey'] === 'string' ? record['imageApiKey'] : '',
      imageBaseUrl: typeof record['imageBaseUrl'] === 'string' ? record['imageBaseUrl'] : '',
      imageModel: typeof record['imageModel'] === 'string' ? record['imageModel'] : '',
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings()
    return defaultSettings()
  }
}

/**
 * 写设置(原子性不追求:单文件小 JSON,写失败直接抛给调用方报错)。
 * @param file - 设置文件绝对路径,父目录不存在时自动创建。
 * @param settings - 待落盘的归一化设置。
 */
export function writeSettings(file: string, settings: ImageSettings): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * 生图配置是否达到可用程度(后端 + key 都非空)。
 * @param settings - 待判定的设置。
 * @returns 后端与 API Key 均非空串时 true。
 */
export function isConfigured(settings: ImageSettings): boolean {
  return settings.imageBackend !== '' && settings.imageApiKey !== ''
}

/** GET 响应摘要:含后端/地址/模型与 configured 标志,绝不含 apiKey。 */
export interface PublicSettings {
  configured: boolean
  imageBackend: string
  imageBaseUrl: string
  imageModel: string
  knownBackends: string[]
}

/**
 * 把设置转成对外摘要。
 * @param settings - 完整设置(含明文 apiKey)。
 * @returns 不含 apiKey 的对外摘要;`configured` 即 {@link isConfigured} 的判定。
 */
export function publicView(settings: ImageSettings): PublicSettings {
  return {
    configured: isConfigured(settings),
    imageBackend: settings.imageBackend,
    imageBaseUrl: settings.imageBaseUrl,
    imageModel: settings.imageModel,
    knownBackends: knownBackends(),
  }
}

/**
 * 渲染 skill 目录 `.env` 内容;未配置返回空串(调用方据此不写文件,
 * ppt-master 走自带的网络图搜/无图降级)。
 *
 * @param settings - 员工设置的归一化配置。
 * @returns `.env` 文件内容;未配置或后端无环境变量映射时为空串。
 */
export function renderDotEnv(settings: ImageSettings): string {
  if (!isConfigured(settings)) return ''
  const mapping = BACKEND_ENV_KEYS[settings.imageBackend]
  if (mapping === undefined) return ''
  const lines = [`IMAGE_BACKEND=${settings.imageBackend}`, `${mapping.key}=${settings.imageApiKey}`]
  if (settings.imageModel !== '') lines.push(`${mapping.model}=${settings.imageModel}`)
  if (settings.imageBaseUrl !== '') lines.push(`${mapping.baseUrl}=${settings.imageBaseUrl}`)
  return `${lines.join('\n')}\n`
}
