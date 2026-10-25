/** Remote calls for the Global-rules section and their outcome vocabulary. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { GlobalInstructionsValue } from '@deepseek-ai/dsh-api-remotes/client'

/** Result of reading the user-global instructions file. */
export type GlobalRulesReadOutcome =
  | { readonly kind: 'loaded'; readonly view: GlobalInstructionsValue }
  | { readonly kind: 'failed'; readonly message: string }

/** Result of replacing the user-global instructions file. */
export type GlobalRulesWriteOutcome =
  | { readonly kind: 'written'; readonly view: GlobalInstructionsValue }
  | { readonly kind: 'too-large'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string }

/** The section's remote surface, bound once where the Remote namespaces activate. */
export interface GlobalRulesOperations {
  read: () => Promise<GlobalRulesReadOutcome>
  write: (content: string) => Promise<GlobalRulesWriteOutcome>
}

/**
 * Bind the settings-controller global-rules remotes into outcome values the
 * section renders; no RemoteError escapes to the component.
 * @param ctx - client root context.
 * @returns the bound operations.
 */
export function createGlobalRulesOperations(ctx: ClientContext): GlobalRulesOperations {
  return {
    read: async () => {
      const response = await ctx.remote.settings.readGlobalInstructions()
      return response.ok
        ? { kind: 'loaded', view: response.value }
        : { kind: 'failed', message: response.error.message }
    },
    write: async (content: string) => {
      const response = await ctx.remote.settings.writeGlobalInstructions(content)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'gateway/bad-request'
        ? { kind: 'too-large', message }
        : { kind: 'refused', message }
    },
  }
}
