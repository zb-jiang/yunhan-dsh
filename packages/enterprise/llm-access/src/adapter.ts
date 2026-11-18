/**
 * Enterprise wrapper over {@link PiAiAdapter}: same dispatch, but terminal
 * failures carrying web-console's quota-gateway error envelope are re-mapped
 * to stable, employee-facing messages and routable codes.
 *
 * The runtime dispatches through `prepareCall()`, whose returned stream is
 * snapshot-bound inside pi-ai — so both `stream()` and the prepared-call
 * dispatch are wrapped here; delegating `prepareCall` alone would bypass the
 * mapping on the main request path.
 *
 * @module @deepseek-ai/dsh-llm-access/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

/** Stable employee-facing copy for known web-console gateway error codes. */
const ENTERPRISE_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  LLM_QUOTA_EXHAUSTED: '企业模型本月额度已用完,请联系管理员调整额度,或切换其他模型',
  LLM_ROUTE_NOT_CONFIGURED: '当前账号未分配该企业模型的使用权限,请联系管理员配置额度路由',
  LLM_MODEL_NOT_FOUND: '企业模型不存在或已停用,请刷新模型列表后重试',
}

/** Match the gateway error code embedded in a provider error body. */
const EMBEDDED_CODE = /"code"\s*:\s*"(LLM_[A-Z_]+)"/

/** Match the HTTP status pi-ai prefixes a provider error body with. */
const LEADING_STATUS = /^(\d{3}):/

/**
 * Extract the server-authored message from an embedded
 * {@code ApiResponse} JSON body, when one is parseable.
 * @param message - the provider error text.
 * @returns the envelope's `error.message`, or undefined.
 */
function embeddedServerMessage(message: string): string | undefined {
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(message.slice(start, end + 1)) as { error?: { message?: unknown } }
    return typeof parsed.error?.message === 'string' && parsed.error.message.length > 0
      ? parsed.error.message
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Re-map one terminal failure whose text carries web-console's error envelope.
 *
 * <p>pi-ai surfaces a rejected proxy response as an error text like
 * `409: {"success":false,"error":{"code":"LLM_QUOTA_EXHAUSTED",...}}`; without
 * this mapping the raw JSON blob would face the employee. Known codes get
 * stable copy, unknown gateway codes keep the server message, and a bare 401
 * (expired employee JWT) becomes a re-login prompt.
 *
 * @param failure - the terminal failure to re-map.
 * @returns the replacement failure, or the original when nothing matches.
 */
export function mapEnterpriseFailure(failure: LlmFailure): LlmFailure {
  const statusMatch = LEADING_STATUS.exec(failure.message)
  const status = failure.status ?? (statusMatch === null ? undefined : Number(statusMatch[1]))
  const codeMatch = EMBEDDED_CODE.exec(failure.message)
  if (codeMatch !== null) {
    const code = codeMatch[1] as string
    const message = ENTERPRISE_FAILURE_MESSAGES[code]
      ?? embeddedServerMessage(failure.message)
      ?? failure.message
    return Object.freeze({ message, code, ...status === undefined ? {} : { status } })
  }
  if (/\b401\b/.test(failure.message)) {
    // 无 body 的 401 文案(如 `401 status code (no body)`)不带 `NNN:` 前导,分支命中即 401
    return Object.freeze({
      message: '企业登录已过期或未登录,请重新登录后重试',
      code: 'AUTH',
      status: status ?? 401,
    })
  }
  return failure
}

/** Re-map a value thrown by the wrapped adapter, passing non-failure errors through. */
function mapThrownFailure(error: unknown): unknown {
  if (error instanceof LlmError) {
    const mapped = mapEnterpriseFailure(error.failure)
    if (mapped !== error.failure) {
      // 重建为 LlmError:normalizeLlmFailure 只采信自有 code/failure 一致的错误;网关码
      // (LLM_QUOTA_EXHAUSTED 等)不是 builtin code,须走 fromFailure 携带自有 code。
      return LlmError.fromFailure(mapped, { cause: error })
    }
  }
  return error
}

/** Re-map terminal error finish chunks; every other chunk passes through as-is. */
function mapChunk(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
  const mapped = mapEnterpriseFailure(chunk.reason.failure)
  return mapped === chunk.reason.failure
    ? chunk
    : { ...chunk, reason: { kind: 'error', failure: mapped } }
}

/**
 * Wrap one upstream chunk stream with the enterprise failure mapping.
 * @param upstream - the pi-ai stream to wrap.
 * @returns chunks with terminal gateway failures re-mapped.
 */
async function* mapEnterpriseStream(upstream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const iterator = upstream[Symbol.asyncIterator]()
  try {
    while (true) {
      let result: IteratorResult<StreamChunk>
      try {
        result = await iterator.next()
      } catch (error) {
        throw mapThrownFailure(error)
      }
      if (result.done) return
      yield mapChunk(result.value)
    }
  } finally {
    // 消费方提前停止时把终止传给上游流(pi-ai 的流依赖 return() 触发 abort 清理)
    await iterator.return?.(undefined)
  }
}

/**
 * Optional host-side hooks the wrapper invokes on adapter surface reads.
 * @property onListModels - fired when the runtime reads this route's model
 *   list; used to opportunistically refresh a stale catalog.
 */
export interface EnterpriseAdapterHooks {
  onListModels?: () => void
}

/**
 * The employee-side LLM adapter: a thin error-mapping wrapper over one
 * {@link PiAiAdapter} instance built from the enterprise catalog. Every
 * capability question is delegated unchanged; only failure presentation
 * differs.
 */
export class EnterpriseLlmAdapter extends LlmAdapter {
  constructor(
    private readonly piAi: PiAiAdapter,
    private readonly hooks: EnterpriseAdapterHooks = {},
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.piAi.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.piAi.providerRetryPolicy(provider)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // UI 打开模型选择器即读目录:借这次读取触发一次后台刷新(见 maybeRefresh),
    // 用户下次打开选择器时目录已是新的
    this.hooks.onListModels?.()
    return this.piAi.listModels(provider)
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.piAi.resolveModel(provider, model, signal)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const call = await this.piAi.prepareCall(provider, model, signal)
    return {
      model: call.model,
      // 包裹快照绑定流:运行时主路径经 prepareCall().stream() 分发
      stream: options => mapEnterpriseStream(call.stream(options)),
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return mapEnterpriseStream(this.piAi.stream(options))
  }
}
