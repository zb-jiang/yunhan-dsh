/**
 * Enterprise LLM access on the employee side (design 2026-09-27 §6.3/§10,
 * integration plan 2026-09-28): registers the `llm-enterprise` provider route
 * on `ctx.llm`, backed by web-console's employee model catalog
 * (`GET /api/llm/models`) and OpenAI-compatible quota proxy
 * (`POST /api/llm/v1/chat/completions`), authenticated with the signed-in
 * employee's Supabase JWT from `ctx.currentUser`.
 *
 * The route is served by one {@link PiAiAdapter} (generic OpenAI-completions
 * protocol) whose profiles are rebuilt from the fetched catalog, wrapped in
 * {@link EnterpriseLlmAdapter} for employee-facing failure copy. The adapter
 * injects the durable attachment service and the image-access bridge, so a
 * model declared with image input accepts attached pictures the same way the
 * base-mounted llm-pi-ai plugin does. Both the LLM
 * request and the catalog pull originate in the DSH backend process, so they
 * reach web-console directly — no local webserver route is involved.
 *
 * Catalog lifecycle: refreshed on `platform-user/verified` (the event carries
 * the fresh token), on an adaptive interval (fast while the catalog is empty,
 * slow once populated), on `loader/volatile-update` (base-URL change), and
 * opportunistically when the selector reads a stale model list; withdrawn to
 * the dormant zero-route posture on `platform-user/signout`. A failed refresh
 * keeps the last catalog; an unchanged fetch leaves the registration
 * untouched so the UI does not reload for nothing.
 *
 * @module @deepseek-ai/dsh-llm-access
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, authContextFrom, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
// 服务类型注册:resolveAttachments/resolveImageAccess 经 ctx 取 attachments 与 fs 服务
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-user-identity-context'
import type {} from '@deepseek-ai/dsh-platform-user'
import { EnterpriseLlmAdapter } from './adapter.ts'
import { buildEnterpriseProfiles, ENTERPRISE_PROVIDER, fetchEnterpriseModels, SessionExpiredError } from './catalog.ts'
import type { EnterpriseModel } from './catalog.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-access'

/** 等待 LLM 运行时与登录身份存储就绪后才挂载。 */
export const inject = ['llm', 'currentUser']

/** 模型目录默认刷新间隔(毫秒)。 */
const DEFAULT_CATALOG_REFRESH_MS = 600_000

/** 目录为空(员工尚无任何企业模型)时的默认快刷间隔(毫秒)。 */
const DEFAULT_CATALOG_EMPTY_REFRESH_MS = 60_000

/** 选择器读取触发刷新的默认目录最大年龄(毫秒)。 */
const DEFAULT_CATALOG_READ_REFRESH_MS = 30_000

/** 插件配置,全部来自 enterprise profile 的 cordis.yml config 段。 */
export interface Config {
  /** web-console 基地址(协议+主机+端口,无路径);volatile:设置面板可改,下次刷新生效。 */
  webConsoleBaseUrl: Volatile<string>
  /** 模型目录刷新间隔毫秒(目录非空时)。 */
  catalogRefreshMs: number
  /** 目录为空时的快刷间隔毫秒:员工尚未配到模型,尽快发现新授权。 */
  catalogEmptyRefreshMs: number
  /** 选择器读取目录时视为"陈旧"的阈值毫秒:超过即后台重拉一次。 */
  catalogReadRefreshMs: number
  /** 目录条目未声明 contextWindow 时的兜底上下文容量(token)。 */
  defaultContextWindow: number
  /** 目录条目未声明 maxTokens 时的兜底输出上限(token)。 */
  defaultMaxTokens: number
}

export const Config = z.object({
  webConsoleBaseUrl: z.string().required().volatile(),
  catalogRefreshMs: z.number().default(DEFAULT_CATALOG_REFRESH_MS),
  catalogEmptyRefreshMs: z.number().default(DEFAULT_CATALOG_EMPTY_REFRESH_MS),
  catalogReadRefreshMs: z.number().default(DEFAULT_CATALOG_READ_REFRESH_MS),
  defaultContextWindow: z.number().step(1).min(1).default(262_144),
  defaultMaxTokens: z.number().step(1).min(1).default(32_768),
})

/**
 * Register the `llm-enterprise` route and wire the catalog lifecycle.
 *
 * <p>catalogRefreshMs 必须为正有限数。目录刷新失败只记 WARN 并保留上次
 * 清单;注册生命周期跟随目录内容:有模型才注册路由,清单清空时以
 * `replace([])` 撤出(注册句柄保留,再次拉到模型时原位恢复)。
 *
 * @param ctx - 携带 `llm` / `currentUser` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  for (const [key, value] of [
    ['catalogRefreshMs', config.catalogRefreshMs],
    ['catalogEmptyRefreshMs', config.catalogEmptyRefreshMs],
    ['catalogReadRefreshMs', config.catalogReadRefreshMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`llm-access: ${key} 必须为正有限数(当前 ${value})`)
    }
  }
  const defaults = { contextWindow: config.defaultContextWindow, maxTokens: config.defaultMaxTokens }

  let models: readonly EnterpriseModel[] = []
  let appliedBaseUrl = ''
  let profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map()
  let registration: AdapterRegistrationHandle | undefined

  const piAi = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => {
      const token = ctx.currentUser.getToken()
      if (token === undefined) {
        // 匿名放行(登录页「匿名使用」)下也走这里:引导到自有模型,而不是只提示登录
        return Promise.reject(new LlmError('未登录,无法调用企业模型;请登录,或在设置→模型中改用自己的模型', 'AUTH'))
      }
      return Promise.resolve(token)
    },
    auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
    // 图片链路注入(与 base 挂载的 llm-pi-ai 插件对称):发消息附带图片时按需取
    // 持久附件服务,并把附件宿主路径映射进当前工具执行世界(缺任一则带图请求失败)
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  })
  const adapter = new EnterpriseLlmAdapter(piAi, { onListModels: () => { maybeRefresh() } })

  /** 按当前 profiles 同步路由注册:空清单=休眠/撤出,非空=注册或原位替换。 */
  const syncRegistration = (): void => {
    const routes = profiles.size > 0 ? [ENTERPRISE_PROVIDER] : []
    if (registration === undefined) {
      // 休眠挂载:初始注册不接受空路由集,拉到模型再注册
      if (routes.length === 0) return
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      // 非空时 replace 触发 llm/adapters-updated,选择器随即重读目录;
      // 空数组合法:清单清空时撤出分组但保留注册句柄
      registration.replace(routes)
    }
  }

  /** 应用一次目录快照;清单与基地址都未变化时不动注册(避免无谓的选择器刷新)。 */
  const applyCatalog = (fetched: readonly EnterpriseModel[], baseUrl: string): void => {
    if (baseUrl === appliedBaseUrl && deepEqualJson(fetched, models)) return
    models = fetched
    appliedBaseUrl = baseUrl
    profiles = buildEnterpriseProfiles(models, baseUrl, defaults)
    syncRegistration()
  }

  /** 拉取一次目录;失败保留上次清单,只记 WARN。 */
  const refreshCatalog = async (token: string): Promise<void> => {
    const baseUrl = config.webConsoleBaseUrl.get().replace(/\/+$/, '')
    applyCatalog(await fetchEnterpriseModels({ webConsoleBaseUrl: baseUrl, token }), baseUrl)
  }

  // ---------- 刷新调度 ----------
  // 两条触发线:
  // 1. 自适应轮询:目录为空用快间隔(等首配额度),非空用常规间隔;自调度链,
  //    每次拉取完成后按当前目录状态选下一个间隔。
  // 2. 读取触发:选择器读目录(listModels)时,若目录超过 readRefreshMs 未刷新
  //    则后台重拉一次——用户打开选择器即隐式点了一次刷新,下次打开即最新。

  let lastPullAt = 0
  let pullInFlight = false
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  /** 拉取完成(或空转)后排下一轮:间隔由当前目录是否为空决定。 */
  const scheduleNext = (): void => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    const interval = models.length === 0 ? config.catalogEmptyRefreshMs : config.catalogRefreshMs
    refreshTimer = setTimeout(() => {
      pull(ctx.currentUser.getToken())
    }, interval)
  }

  const pull = (token: string | undefined): void => {
    if (pullInFlight) return
    if (token === undefined) {
      // 未登录:不请求但保持调度链,登录事件会提前拉取
      scheduleNext()
      return
    }
    lastPullAt = Date.now()
    pullInFlight = true
    void refreshCatalog(token)
      .catch((error: unknown) => {
        if (error instanceof SessionExpiredError) {
          ctx.logger.info('llm-access: 登录 token 已过期或无效,等待下一次身份验证后自动恢复')
          return
        }
        ctx.logger.warn('llm-access: 模型目录刷新失败', error)
      })
      .finally(() => {
        pullInFlight = false
        scheduleNext()
      })
  }

  /** 目录读取时的机会性刷新:TTL 内或已有拉取在途则跳过,不打断轮询链。 */
  const maybeRefresh = (): void => {
    if (pullInFlight || Date.now() - lastPullAt < config.catalogReadRefreshMs) return
    pull(ctx.currentUser.getToken())
  }

  // 登录即刷新:事件载荷自带新 token,不依赖 currentUser 的更新时序
  ctx.on('platform-user/verified', (_user, accessToken) => {
    pull(accessToken)
  }, { global: true })
  // 登出撤出:清空目录并撤出路由(下一个登录者经 verified 事件重建);
  // 目录已空,下一轮自动切到快间隔
  ctx.on('platform-user/signout', () => {
    models = []
    appliedBaseUrl = ''
    profiles = new Map()
    syncRegistration()
    scheduleNext()
  }, { global: true })

  ctx.effect(() => () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  }, 'llm-access: catalog refresh timer')

  // 基地址等 volatile 配置变更:立即按当前登录态重拉一次
  ctx.on('loader/volatile-update', () => {
    pull(ctx.currentUser.getToken())
  })

  // 挂载时已登录(如 HMR 重挂/重启恢复)则先拉一次,未登录则只启动调度链
  pull(ctx.currentUser.getToken())
}
