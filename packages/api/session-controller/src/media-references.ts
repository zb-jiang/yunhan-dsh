/**
 * Authenticated GET/HEAD /api/file reads file responses through the composed
 * filesystem provider: complete bodies stay byte-capped, while a `Range`
 * request streams its interval in bounded windows. Paths and MIME types do
 * not restrict access; the connection service authenticates requests before
 * this handler.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import { FsError, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import mime from 'mime-types'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

/** Bytes per ranged read window; the window is the transfer's resident bound. */
const RANGE_WINDOW_BYTES = 1024 * 1024

/** Inclusive byte interval a resolved Range request asks for. */
interface ByteInterval {
  readonly start: number
  readonly end: number
}

/**
 * Resolve one `Range` header against a complete file size. Only the `bytes`
 * unit is served, and only the first of several comma-separated intervals:
 * media elements request one interval at a time, and multi-part response
 * bodies buy nothing for them. A syntactically invalid header returns
 * undefined so the response falls back to the complete body, matching servers
 * that ignore a Range they cannot honor.
 * @param header - request `Range` header value.
 * @param size - complete file size in bytes.
 * @returns the inclusive interval, `unsatisfiable` for a well-formed interval
 * that names no byte of the file, or undefined for a header this route ignores.
 */
function resolveRange(header: string, size: number): ByteInterval | 'unsatisfiable' | undefined {
  const unit = /^bytes\s*=\s*(.*)$/u.exec(header.trim())
  if (unit === null) return undefined
  const first = (unit[1] ?? '').split(',')[0]?.trim() ?? ''
  const interval = /^(\d*)-(\d*)$/u.exec(first)
  if (interval === null) return undefined
  const [, startText, endText] = interval
  if (startText === '' && endText === '') return undefined
  if (startText === '') {
    // A suffix interval names the file's final bytes.
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return 'unsatisfiable'
    const length = Math.min(suffix, size)
    return { start: size - length, end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start)) return undefined
  if (start >= size) return 'unsatisfiable'
  if (endText === '') return { start, end: size - 1 }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return undefined
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Stream one byte interval as successive bounded windows, so a response's
 * resident memory never scales with the file. The request signal ends both an
 * in-flight window and the loop — a disconnected client aborts the request.
 * A window returning short — the file truncated while the interval was
 * streaming — ends the response early instead of failing it; the client sees a
 * short body and re-requests. A filesystem failure mid-stream ends the body
 * the same way because the response status is already committed.
 * @param fs - composed filesystem provider.
 * @param target - resolved file to read.
 * @param interval - inclusive byte interval to stream.
 * @param signal - request lifetime; aborts the active window read.
 * @returns the interval's bytes as a streaming body.
 */
function intervalStream(
  fs: FileSystem,
  target: FsTarget,
  interval: ByteInterval,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let offset = interval.start
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (signal.aborted || offset > interval.end) {
        controller.close()
        return
      }
      const length = Math.min(RANGE_WINDOW_BYTES, interval.end - offset + 1)
      try {
        const window = await fs.readByteRange(target, { offset, length }, signal)
        if (window.byteLength === 0) {
          controller.close()
          return
        }
        controller.enqueue(window)
        offset += window.byteLength
        if (window.byteLength < length) controller.close()
      } catch (error: unknown) {
        if (!(error instanceof FsError)) throw error
        controller.close()
      }
    },
  })
}

async function serveFile(request: Request, fs: FileSystem, maxBytes: number): Promise<Response> {
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: BASE_HEADERS })
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const mediaType = mime.lookup(target.displayPath) || 'application/octet-stream'
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mediaType,
      // Browsers seek by re-requesting byte intervals; this advertises them.
      'Accept-Ranges': 'bytes',
    }
    if (request.method === 'HEAD') {
      const info = await fs.stat(target, request.signal)
      if (info === undefined) return fail(404, 'not found')
      if (info.type !== 'file') return fail(403, 'not a regular file')
      if (info.size !== undefined) {
        if (info.size > maxBytes) return fail(413, 'file exceeds byte limit')
        headers['Content-Length'] = String(info.size)
      }
      return new Response(null, { headers })
    }
    const rangeHeader = request.headers.get('range')
    if (rangeHeader !== null) {
      // A ranged GET streams its interval windowed, so the whole-file cap —
      // a bound on the buffered complete read — does not apply to it.
      const info = await fs.stat(target, request.signal)
      if (info === undefined) return fail(404, 'not found')
      if (info.type !== 'file') return fail(403, 'not a regular file')
      if (info.size !== undefined) {
        const interval = resolveRange(rangeHeader, info.size)
        if (interval === 'unsatisfiable') {
          return new Response('range not satisfiable', {
            status: 416,
            headers: { ...headers, 'Content-Range': `bytes */${info.size}` },
          })
        }
        if (interval !== undefined) {
          return new Response(intervalStream(fs, target, interval, request.signal), {
            status: 206,
            headers: {
              ...headers,
              'Content-Range': `bytes ${interval.start}-${interval.end}/${info.size}`,
              'Content-Length': String(interval.end - interval.start + 1),
            },
          })
        }
      }
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveFile(request, ctx.fs, maxBytes),
    }), 'session-controller: /api/file')
  },
}
