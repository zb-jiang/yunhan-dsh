/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because the
     * stored document no longer parses. The details name only the reference,
     * never the value.
     */
    'credential/rejected': { readonly ref: string }
    /**
     * The global rules file read or write failed on the host filesystem; the
     * details name the target file without diagnosing the filesystem error.
     */
    'globalRules/rejected': { readonly path: string }
  }
}

/** View of the user-global instructions file served to the settings Global Rules page. */
export interface GlobalInstructionsValue {
  /** Absolute host path of the file, for diagnostics and native-editor handoff. */
  readonly path: string
  /**
   * Symbolic home label (`~/.dsh` or `$DSH_HOME`) the file lives under; the
   * page composes the displayed location instead of showing a machine path.
   */
  readonly homeDisplay: string
  /** Whether the file exists; an absent file reads as empty content. */
  readonly exists: boolean
  /** The file's UTF-8 text; empty when the file does not exist. */
  readonly content: string
  /**
   * Injection budget in UTF-8 bytes from the mounted agent-instructions entry.
   * Absent when the budget is not discoverable on this host, which hides the
   * usage meter; an over-budget file is still saved but ignored by injection.
   */
  readonly maxBytes?: number
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}
