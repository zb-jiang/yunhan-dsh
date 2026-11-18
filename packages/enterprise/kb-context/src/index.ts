/**
 * Enterprise session knowledge-base context (design 2026-09-11 §6 补充): 员工端
 * 把「任务会话 → 所属应用」上报到本插件的本地路由,每个回合 step 1 向模型追加
 * 一条携带应用知识库 kbId 的可见块,使助手无需先经 '@' 插入文档即可调用
 * kb_search / kb_list / kb_read。
 *
 * <p>上报通道由客户端绑定状态驱动(EnterpriseWorkbench):新绑定、任务列表刷新
 * 后的持久绑定重放、完成解绑,各 POST 一批 {sessionId, applicationId} 到本插
 * 件的 exact 路由。映射存内存;webserver 重启后由客户端下一次重放自愈。
 * 伪造上报无法越权:解析知识库始终以当前登录员工的 JWT 调 web-console 按应用
 * 接口,非成员得到 404 → 不注入。
 *
 * <p>没有上报的会话(普通对话、未开通知识库应用的任务、applicationId 为 null)
 * 不注入任何内容。
 *
 * @module @deepseek-ai/dsh-kb-context
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-user-identity-context'
import { KB_CONTEXT_SECTION, type KbBlockData, renderKbContextText } from './text.ts'

export type { KbBlockData } from './text.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kb-context'

/** Services: local webserver (report route), login identity (JWT), agent scope events. */
export const inject = ['webServer', 'currentUser', 'agents']

/** kb 解析缓存 TTL:应用开通/改名知识库后最迟 5 分钟内生效。 */
const KB_TTL_MILLIS = 5 * 60_000

/** 上报端点(exact 路由;优先于 knowledge 的 /api/enterprise/kb 前缀代理)。 */
const REPORT_ROUTE = '/api/enterprise/kb/session-context'

/** 插件配置。 */
export interface Config {
  /** web-console 基地址(协议+主机+端口,无路径);volatile:设置面板可改,即时生效。 */
  webConsoleBaseUrl: Volatile<string>
}

export const Config = z.object({
  webConsoleBaseUrl: z.string().required().volatile(),
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Knowledge-base retrieval display attribution; readers preserve the content without this producer.
     * @persistenceAttribution
     */
    'kb-context': { kind: 'kb-context' } & ContextFormed
  }
}

/** 已解析的知识库;kb 为 null 表示应用未开通(同样缓存,避免每轮打点)。 */
interface ResolvedKb {
  kb: KbBlockData | null
  expiresAt: number
}

/**
 * 检查值是否为非空对象记录。
 * @param value - 未知 JSON 值。
 * @returns value 是对象记录时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 从 web-console 信封的未知 JSON 值窄化出知识库子集。
 * @param raw - 响应 JSON。
 * @returns id/name 齐全的知识库;其余形态返回 undefined。
 */
function narrowKbEnvelope(raw: unknown): { id: string; name: string } | undefined {
  if (!isRecord(raw)) return undefined
  const data = raw.data
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.name !== 'string') return undefined
  return { id: data.id, name: data.name }
}

/**
 * 校验基地址形状(协议+主机,禁止路径)。
 * @param value - 配置的基地址。
 * @returns 无效时的错误消息;有效返回 undefined。
 */
function validateBaseUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `webConsoleBaseUrl 不是合法 URL: ${value}`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `webConsoleBaseUrl 协议必须是 http/https: ${value}`
  if (url.pathname !== '/' && url.pathname !== '') return `webConsoleBaseUrl 不允许携带路径: ${value}`
  return undefined
}

/**
 * 读取并缓冲整个请求体。
 * @param req - node 原始请求。
 * @returns 完整请求体字节。
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * 插件装配:注册上报路由与每回合注入监听。
 * @param ctx - cordis 上下文。
 * @param config - 已校验配置。
 */
export function apply(ctx: Context, config: Config): void {
  /** sessionId → applicationId(null = 客户端明确上报「无归属」)。 */
  const sessionApps = new Map<string, string | null>()
  /** applicationId → 已解析知识库(TTL 内复用)。 */
  const kbCache = new Map<string, ResolvedKb>()

  /** 用当前登录 JWT 按应用解析知识库;404 → null(未开通);其余失败抛错由调用方降级。 */
  const resolveKb = async (applicationId: string, token: string): Promise<KbBlockData | null> => {
    const base = config.webConsoleBaseUrl.get().replace(/\/+$/, '')
    const invalid = validateBaseUrl(base)
    if (invalid !== undefined) throw new Error(`kb-context: ${invalid}`)
    const response = await fetch(new URL(`/api/kb/by-app/${applicationId}`, base), {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.status === 404) return null
    const kb = narrowKbEnvelope(await response.json())
    if (kb === undefined) {
      throw new Error(`kb-context: 知识库解析失败(HTTP ${response.status})`)
    }
    return { kbId: kb.id, kbName: kb.name }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: REPORT_ROUTE,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const sendJson = (status: number, body: unknown): void => {
          const json = JSON.stringify(body)
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(json),
          })
          res.end(json)
        }
        if (ctx.currentUser.getToken() === undefined) {
          sendJson(401, { error: '未登录,无法上报会话知识库归属' })
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse((await readBody(req)).toString('utf8')) as unknown
        } catch {
          sendJson(400, { error: '请求体不是 JSON' })
          return
        }
        const entries = (parsed as { entries?: unknown } | null)?.entries
        if (!Array.isArray(entries)) {
          sendJson(400, { error: 'entries 必须是数组' })
          return
        }
        for (const entry of entries) {
          const sessionId = (entry as { sessionId?: unknown } | null)?.sessionId
          const applicationId = (entry as { applicationId?: unknown } | null)?.applicationId
          if (typeof sessionId !== 'string' || sessionId === '') {
            sendJson(400, { error: '每条上报都需要非空 sessionId 字符串' })
            return
          }
          if (applicationId !== null && typeof applicationId !== 'string') {
            sendJson(400, { error: 'applicationId 必须是字符串或 null' })
            return
          }
          sessionApps.set(sessionId, applicationId)
        }
        res.writeHead(204)
        res.end()
      },
    }),
    `kb-context: ${REPORT_ROUTE} session report route`,
  )

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1) return decision
    const applicationId = sessionApps.get(agent.session.id)
    if (applicationId === undefined || applicationId === null) return decision
    const token = ctx.currentUser.getToken()
    if (token === undefined) return decision

    const cached = kbCache.get(applicationId)
    let kb: KbBlockData | null
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      kb = cached.kb
    } else {
      try {
        kb = await resolveKb(applicationId, token)
      } catch (error) {
        ctx.logger.warn('kb-context: 知识库解析失败,本轮不注入', error instanceof Error ? error : new Error(String(error)))
        return decision
      }
      kbCache.set(applicationId, { kb, expiresAt: Date.now() + KB_TTL_MILLIS })
    }
    if (kb === null) return decision

    const text = renderKbContextText(kb)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'kb-context', form: 'snapshot', sections: [{ name: KB_CONTEXT_SECTION, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
