/**
 * Wire types of the `enterpriseFiles` Remote namespace. Types only: generated
 * Remote clients consume this module without Host runtime code.
 *
 * @module @deepseek-ai/dsh-enterprise-file-write/types
 */
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Request body of `enterpriseFiles.write`: one confined text write. */
export interface EnterpriseFileWriteRequest {
  /** Workspace-relative target path; resolved against the session workspace root. */
  readonly path: string
  /** Full replacement text written to the file (UTF-8). */
  readonly content: string
  /**
   * Optimistic-concurrency guard: when present, the write only applies if the
   * current file version equals this value; otherwise the write fails with
   * `enterprise-file/stale-version`.
   */
  readonly expectedVersion?: string
}

/** Result of a successful `enterpriseFiles.write`. */
export interface EnterpriseFileWriteResult {
  /** Absolute path of the written file, as reported by the Host filesystem. */
  readonly absolutePath: string
  /** Version handle of the file after the write; pass it back as `expectedVersion`. */
  readonly version: string
  /** Whether this write created the file or updated an existing one. */
  readonly operation: 'create' | 'update'
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'enterprise-file/session-not-found': { readonly sessionId: string }
    'enterprise-file/outside-workspace': { readonly path: string }
    'enterprise-file/too-large': { readonly path: string; readonly limit: number }
    'enterprise-file/stale-version': { readonly path: string }
    'enterprise-file/denied': { readonly path: string }
  }
}
