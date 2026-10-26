/**
 * Employee-side enterprise model catalog: fetches web-console
 * `GET /api/llm/models`, normalizes the wire DTO, and builds the single
 * hand-declared pi-ai provider profile (`llm-enterprise` → web-console
 * `/api/llm/v1` OpenAI-compatible proxy).
 *
 * @module @deepseek-ai/dsh-llm-access/catalog
 */

import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  PiAiModality,
  PiAiModelProfile,
  ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'

/** The single provider route this package registers. */
export const ENTERPRISE_PROVIDER = 'llm-enterprise'

/** Display name of the provider group shown in employee-side model selectors. */
export const ENTERPRISE_PROVIDER_DISPLAY_NAME = '企业模型'

/** web-console {@code ApiResponse} envelope (data present on success). */
interface ApiEnvelope<T> {
  success?: boolean
  data?: T
  error?: { message?: string }
}

/**
 * web-console {@code EmployeeModelDto}. Only the fields the employee-side
 * route consumes are declared; quota pools and exhaust action stay on the
 * web-console UI.
 */
export interface EmployeeModelDto {
  id: string
  gatewayModelName: string
  displayName: string
  contextWindow?: number | null
  maxTokens?: number | null
  reasoning?: boolean | null
  imageInput?: boolean | null
}

/** Normalized catalog entry for one enterprise model. */
export interface EnterpriseModel {
  /** Model id sent to the web-console proxy (`model` request field). */
  readonly gatewayModelName: string
  /** Display name for the employee-side selector. */
  readonly displayName: string
  /** Context capacity in tokens; undefined falls back to config default. */
  readonly contextWindow: number | undefined
  /** Output capability in tokens; undefined falls back to config default. */
  readonly maxTokens: number | undefined
  /** Whether the model offers reasoning effort levels in the selector. */
  readonly reasoning: boolean
  /** Whether the session may attach images to this model. */
  readonly imageInput: boolean
}

/** Resolved fetch inputs for one catalog pull. */
export interface CatalogRequest {
  /** web-console base URL (protocol + host + port, no trailing slash). */
  readonly webConsoleBaseUrl: string
  /** The signed-in employee's Supabase JWT. */
  readonly token: string
}

/** Fallbacks for models whose catalog entry sizes neither capacity. */
export interface CatalogDefaults {
  readonly contextWindow: number
  readonly maxTokens: number
}

/**
 * Standard reasoning effort levels offered when a catalog entry declares
 * reasoning support: OpenAI-completions `reasoning_effort` spellings, relayed
 * by web-console's proxy and the New API gateway unchanged.
 */
const REASONING_EFFORTS = { low: 'low', medium: 'medium', high: 'high' } as const

/** 模态声明:声明支持图片的模型在 pi-ai 档案上写入的 input 能力(text 是所有协议的底座)。 */
const IMAGE_INPUT: PiAiModality[] = ['text', 'image']

/** 当前登录员工的 JWT 失效(401);等客户端续期/重新登录后自动恢复,非故障。 */
export class SessionExpiredError extends Error {}

/**
 * Accept a positive integer capacity from the wire DTO.
 * @param value - raw field from the DTO (JSON numbers or absent).
 * @returns the validated integer, or undefined when absent/invalid.
 */
function capacityOf(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Fetch and normalize the signed-in employee's enterprise model catalog.
 *
 * @param request - resolved base URL and token for this pull.
 * @returns normalized models in server order, deduplicated by gateway model name.
 * @throws Error when web-console is unreachable, answers non-JSON, or the
 *   envelope reports failure (messages face the log, not the model).
 */
export async function fetchEnterpriseModels(request: CatalogRequest): Promise<readonly EnterpriseModel[]> {
  let resp: Response
  try {
    resp = await fetch(new URL('/api/llm/models', request.webConsoleBaseUrl), {
      headers: { authorization: `Bearer ${request.token}` },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`web-console 不可达(${request.webConsoleBaseUrl}): ${message}`)
  }
  if (resp.status === 401) {
    // 先于 JSON 解析判定:web-console 的 401 响应体不是本信封的 JSON,
    // 归为会话失效供调用方降级,而非「响应不是 JSON」的故障告警
    throw new SessionExpiredError('登录 token 已过期或无效')
  }
  let body: ApiEnvelope<EmployeeModelDto[]>
  try {
    body = await resp.json() as ApiEnvelope<EmployeeModelDto[]>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`web-console 模型目录响应不是 JSON(HTTP ${resp.status}): ${message}`)
  }
  if (!resp.ok || body.success !== true || body.data === undefined) {
    throw new Error(`web-console 模型目录请求失败(HTTP ${resp.status}): ${body.error?.message ?? '未知错误'}`)
  }
  // 线边界:逐条校验并归一化;无效条目跳过而非整体失败(单条脏数据不应清空整个选择器)
  const models: EnterpriseModel[] = []
  const seen = new Set<string>()
  for (const entry of body.data) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- wire data may contain null entries despite the DTO assertion
    if (typeof entry?.gatewayModelName !== 'string' || entry.gatewayModelName.length === 0) continue
    if (seen.has(entry.gatewayModelName)) continue
    seen.add(entry.gatewayModelName)
    models.push({
      gatewayModelName: entry.gatewayModelName,
      displayName: typeof entry.displayName === 'string' && entry.displayName.length > 0
        ? entry.displayName
        : entry.gatewayModelName,
      contextWindow: capacityOf(entry.contextWindow),
      maxTokens: capacityOf(entry.maxTokens),
      reasoning: entry.reasoning === true,
      imageInput: entry.imageInput === true,
    })
  }
  return models
}

/**
 * Build the pi-ai provider profiles for the current catalog snapshot.
 *
 * <p>One hand-declared route keyed {@link ENTERPRISE_PROVIDER}: the
 * OpenAI-completions protocol against web-console's `/api/llm/v1` base, one
 * profile model per catalog entry. An empty catalog resolves to the empty
 * (dormant) profile set.
 *
 * @param models - the current normalized catalog snapshot.
 * @param webConsoleBaseUrl - web-console base URL without trailing slash.
 * @param defaults - fallback capacities for unsized models.
 * @returns resolved profiles keyed by route.
 * @throws Error when the constructed profile cannot be served (invalid base
 *   URL shape or model entries).
 */
export function buildEnterpriseProfiles(
  models: readonly EnterpriseModel[],
  webConsoleBaseUrl: string,
  defaults: CatalogDefaults,
): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  if (models.length === 0) return new Map()
  const piModels: PiAiModelProfile[] = models.map(model => ({
    id: model.gatewayModelName,
    name: model.displayName,
    contextWindow: model.contextWindow ?? defaults.contextWindow,
    maxTokens: model.maxTokens ?? defaults.maxTokens,
    // 声明推理档位后选择器才显示推理等级菜单(缺省=无推理,菜单隐藏)
    ...model.reasoning ? { reasoningEfforts: REASONING_EFFORTS } : {},
    // 声明图片模态后发消息才允许附带图片(缺省=纯文本,pi-ai 兜底 DEFAULT_INPUT)
    ...model.imageInput ? { input: IMAGE_INPUT } : {},
  }))
  return resolveProfiles({
    [ENTERPRISE_PROVIDER]: {
      displayName: ENTERPRISE_PROVIDER_DISPLAY_NAME,
      api: 'openai-completions',
      baseURL: `${webConsoleBaseUrl}/api/llm/v1`,
      models: piModels,
    },
  })
}
