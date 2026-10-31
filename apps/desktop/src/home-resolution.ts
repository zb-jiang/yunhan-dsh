/** Desktop-shell harness-home resolution: the `--dsh-home` argument layered over the official chain. */

import { isAbsolute } from 'node:path'
import { DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Which entry supplied the resolved harness home. */
export type DesktopHomeSource = 'argument' | 'environment' | 'default'

/** The final harness home shared by the main process and the Host subprocess. */
export interface DesktopHomeResolution {
  /** Absolute harness home the shell and every Host subprocess must agree on. */
  readonly homeDir: string
  /** Which entry supplied the home. */
  readonly source: DesktopHomeSource
  /** The `--dsh-home` value; undefined unless the argument supplied the home. */
  readonly configured: string | undefined
}

/** Command-line flag that overrides the harness home for this launch. */
const DSH_HOME_FLAG = '--dsh-home'

/**
 * Extract the `--dsh-home` value from the desktop-shell argv, accepting both
 * `--dsh-home <path>` and `--dsh-home=<path>`; a later occurrence wins.
 * @param argv - the main-process argv.
 * @returns the flag value, or undefined when the flag is absent.
 * @throws with an actionable message when the value is missing, empty, contains a NUL byte, or is not absolute.
 */
export function parseDesktopHomeArgument(argv: readonly string[]): string | undefined {
  let value: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) break
    if (argument === DSH_HOME_FLAG) {
      value = argv[index + 1]
      if (value === undefined) throw new Error(`${DSH_HOME_FLAG} requires an absolute directory path`)
    } else if (argument.startsWith(`${DSH_HOME_FLAG}=`)) {
      value = argument.slice(DSH_HOME_FLAG.length + 1)
    }
  }
  if (value === undefined) return undefined
  if (value.length === 0 || value.includes('\0')) {
    throw new Error(`${DSH_HOME_FLAG} requires a non-empty absolute directory path`)
  }
  if (!isAbsolute(value)) throw new Error(`${DSH_HOME_FLAG} requires an absolute directory path, got "${value}"`)
  return value
}

/**
 * Resolve the harness home for the desktop shell: the `--dsh-home` argument first,
 * then the official `$DSH_HOME`-over-default chain of `resolveDshHome`. The shell
 * passes the result once to every consumer, so the main process and the Host
 * subprocess never resolve different homes.
 * @param argv - the main-process argv.
 * @param env - environment mapping read for `$DSH_HOME`.
 * @returns the final home with its source; `configured` carries the argument value for same-source environment injection.
 */
export function resolveDesktopHome(argv: readonly string[], env: Record<string, string | undefined>): DesktopHomeResolution {
  const configured = parseDesktopHomeArgument(argv)
  if (configured !== undefined) return { homeDir: resolveDshHome(configured, env), source: 'argument', configured }
  // Mirror `resolveDshHome`'s env reading (non-empty after trim) only to label the source; the value stays its output.
  const fromEnv = env[DSH_HOME_ENV]
  const source: DesktopHomeSource = fromEnv !== undefined && fromEnv.trim().length > 0 ? 'environment' : 'default'
  return { homeDir: resolveDshHome(undefined, env), source, configured: undefined }
}
