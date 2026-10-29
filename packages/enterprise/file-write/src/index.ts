/**
 * Enterprise workspace file write service: confined text writes with
 * optimistic concurrency, exposed as `enterpriseFiles`.
 *
 * Every write resolves the Session's workspace root and refuses paths outside
 * it, so the editor save channel cannot escape the workspace the way the
 * read-side `workspaceFiles` previews may. The write runs under a per-call
 * `workspace-write` sandbox policy carrying the Session identity, an optional
 * version guard gives the editor stale-save detection, and a configured byte
 * cap bounds one write.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import { FsVersion, type FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { EnterpriseFileWriteRequest, EnterpriseFileWriteResult } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `enterpriseFiles` Remote namespace. */
    enterpriseFiles: EnterpriseFiles
  }
}

/** Deployment caps on one write. */
export interface Config {
  /**
   * Inclusive byte cap on one write's UTF-8 content; a larger write is
   * refused, not shortened, because a silently cut save would corrupt the file.
   */
  readonly maxWriteBytes: number
}

/** Host Remote text writes into one Session's workspace over the composed filesystem. */
export class EnterpriseFiles extends TypertRemoteService {
  static inject = ['fs', 'sandboxPolicy', 'sessions', 'typert']

  static Config: z<Config> = z.object({
    maxWriteBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  })

  /**
   * @param ctx - Host context carrying the filesystem and the sandbox policy.
   * @param config - deployment caps on one write.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'enterpriseFiles')
  }

  /**
   * Write one text file inside the Session's workspace, creating or replacing it.
   * @param sessionId - Session identity whose workspace root confines the write.
   * @param request - the target path, full replacement text, and optional expected version.
   * @param signal - caller cancellation.
   * @returns the file's absolute path, its version after the write, and whether it was created or updated.
   */
  @Remote
  async write(sessionId: SessionId, request: EnterpriseFileWriteRequest, signal: AbortSignal): Promise<EnterpriseFileWriteResult> {
    const path = request.path
    if (path.length === 0 || path.includes('\0')) {
      throw new RemoteError('gateway/bad-request', 'path is required and must not contain NUL', {})
    }
    const workspaceRoot = await this.resolveWorkspaceRoot(sessionId)
    const root = await this.ctx.fs.resolve(workspaceRoot, { signal })
    const target = await this.ctx.fs.resolve(path, { cwd: workspaceRoot, signal })
    if (!this.ctx.fs.contains(root, target)) {
      throw new RemoteError('enterprise-file/outside-workspace', `"${path}" is outside the workspace`, { path })
    }
    const bytes = Buffer.byteLength(request.content, 'utf8')
    if (bytes > this.config.maxWriteBytes) {
      throw new RemoteError(
        'enterprise-file/too-large',
        `"${path}" carries ${bytes} bytes over the ${this.config.maxWriteBytes} byte write cap`,
        { path, limit: this.config.maxWriteBytes },
      )
    }
    const expected: FsWriteIntent | undefined = request.expectedVersion === undefined
      ? undefined
      : { kind: 'replaceIfVersion', version: FsVersion(request.expectedVersion) }
    const sandboxPolicy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot, sessionId }
    const outcome = await this.ctx.fs.writeText(target, request.content, expected, signal, sandboxPolicy)
      .catch((cause: unknown) => {
        if (typeof cause === 'object' && cause !== null && 'code' in cause) {
          if (cause.code === 'FS_STALE_VERSION') {
            throw new RemoteError('enterprise-file/stale-version', `"${path}" changed since it was opened`, { path }, { cause })
          }
          if (cause.code === 'FS_SANDBOX_DENIED') {
            throw new RemoteError('enterprise-file/denied', `"${path}" is denied by the sandbox policy`, { path }, { cause })
          }
        }
        throw cause
      })
    return {
      absolutePath: this.ctx.fs.processPath(target),
      version: outcome.version,
      operation: outcome.operation,
    }
  }

  /**
   * Resolve the Session's workspace root from its live header, falling back to
   * the persisted header and then the deployment sandbox root, so a write to a
   * session that only exists on disk still lands where the session worked.
   */
  private async resolveWorkspaceRoot(sessionId: SessionId): Promise<string> {
    const live = this.ctx.sessions.get(sessionId)?.header
    const stored = live === undefined
      ? await this.ctx.get('sessionPersistence')?.stat(sessionId)
      : undefined
    const header = live ?? stored?.header
    if (header === undefined) {
      throw new RemoteError('enterprise-file/session-not-found', `no session "${sessionId}"`, { sessionId })
    }
    return header.cwd ?? this.ctx.sandboxPolicy.workspaceRoot
  }
}

export default EnterpriseFiles
