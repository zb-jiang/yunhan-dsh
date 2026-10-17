/**
 * Shared forwarder for enterprise prefix proxies: browser surfaces reach the
 * web-console REST only through the local DSH webserver — never directly —
 * with the signed-in employee's JWT attached. The upstream response (status
 * and body) is copied back verbatim; every failure mode answers JSON (401
 * unsigned-in, 502 invalid base URL or unreachable upstream) so browsers
 * never parse HTML error pages.
 *
 * Consumers register a `{ kind: 'prefix' }` webserver route per upstream
 * prefix and delegate the handler to {@link proxyRequest}; knowledge and
 * instance-workspace share this module (design 2026-10-14 §5.1a).
 *
 * @module @deepseek-ai/dsh-web-console-proxy
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 转发器运行选项;取值函数注入而非内联快照:volatile 配置(设置面板可改的
 * web-console 基地址)与登录态都在每次转发时读取当前值。
 */
export interface WebConsoleProxyOptions {
  /** web-console 基地址(协议+主机+端口,无路径);每次转发读取。 */
  readonly baseUrl: () => string
  /** 当前登录员工的 JWT;未登录(backend profile)为 undefined。 */
  readonly token: () => string | undefined
  /** 未登录 401 的提示文案;缺省为通用文案(消费方可用领域文案覆盖)。 */
  readonly unauthorizedMessage?: string
}

/** JSON 响应辅助函数。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/** 读取并缓冲整个请求体(multipart 上传与 JSON 提交都是有限体,整体转发)。 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

/**
 * 校验基地址形状(协议+主机),无效返回错误消息。
 * @param value - 配置的基地址。
 * @returns 无效时的错误消息;有效返回 undefined。
 */
export function validateBaseUrl(value: string): string | undefined {
  try {
    new URL(value)
    return undefined
  } catch {
    return `invalid base URL: ${value}`
  }
}

/**
 * 把请求转发到 web-console(附当前登录 JWT),上游响应(状态码 + 体)原样回写。
 *
 * <p>未登录回 401(文案取 {@link WebConsoleProxyOptions.unauthorizedMessage});
 * baseUrl 配置无效或 web-console 不可达回 JSON 502,浏览器侧永远不解析
 * HTML 错误页。
 *
 * @param options - 转发器运行选项。
 * @param localPrefix - 本地路由前缀(webserver 路由保证命中)。
 * @param upstreamPrefix - web-console 侧前缀。
 * @param req - 浏览器请求。
 * @param res - 浏览器响应。
 */
export async function proxyRequest(
  options: WebConsoleProxyOptions,
  localPrefix: string,
  upstreamPrefix: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
  requests; the field is only optional on the client-side IncomingMessage type */
  const incoming = new URL(req.url ?? '/', 'http://localhost')
  const token = options.token()
  if (token === undefined) {
    sendJson(res, 401, { error: options.unauthorizedMessage ?? '未登录,无法访问企业服务' })
    return
  }
  // volatile 配置:每次转发读取当前值,设置面板修改后无需重载即生效
  const webConsoleBaseUrl = options.baseUrl().replace(/\/+$/, '')
  if (validateBaseUrl(webConsoleBaseUrl) !== undefined) {
    sendJson(res, 502, { error: `webConsoleBaseUrl 配置无效: ${webConsoleBaseUrl}` })
    return
  }
  const suffix = incoming.pathname.slice(localPrefix.length)
  const target = new URL(`${upstreamPrefix}${suffix}${incoming.search}`, webConsoleBaseUrl)
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  const contentType = req.headers['content-type']
  // content-type is declared `string | undefined` on IncomingHttpHeaders —
  // the array form never occurs for it.
  if (typeof contentType === 'string') {
    headers['content-type'] = contentType
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let upstream: Response
  try {
    /* v8 ignore next -- node:http always sets method on server requests. */
    upstream = await fetch(target, {
      method: req.method ?? 'GET',
      headers,
      // Copy into a plain Uint8Array: Buffer<ArrayBufferLike> is not assignable
      // to the DOM BodyInit's ArrayBuffer-backed view union.
      body: hasBody ? new Uint8Array(await readBody(req)) : null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 502, { error: `web-console 不可达(${webConsoleBaseUrl}): ${message}` })
    return
  }
  const responseContentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'
  const body = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(upstream.status, { 'content-type': responseContentType, 'content-length': body.length })
  res.end(body)
}
