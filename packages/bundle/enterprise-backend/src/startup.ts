/**
 * The backend profile's command-line provider: a resident server process with
 * no flags, so the invocation owns only its `--help`. Help and a rejected
 * argument are terminal for the process; a successful parse keeps booting the
 * resident plugins, which own the process lifetime.
 * @module @deepseek-ai/dsh-enterprise-backend/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'enterprise-backend-startup'

/** Launcher service required before this app can parse its invocation. */
export const inject = ['cmdlineArgs']

/** Service this plugin provides once the invocation is accepted. */
export const BACKEND_APP_STARTUP_SERVICE = 'enterpriseBackendStartup'

/**
 * Build this profile's zero-option command and help.
 * @returns a fresh program for one invocation.
 */
function backendCommand(): Command {
  return new Command()
    .name('dsh --profile enterprise-backend')
    .description('Run the resident server-side backend task runner: REST task endpoints for flowable-engine, plus the web-console register/heartbeat and skill-sync daemons.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  dsh --profile enterprise-backend     run the backend task runner until stopped

The process is configured through environment variables (DSH_BACKEND_HOST, DSH_BACKEND_PORT, WEB_CONSOLE_URL, DSH_BACKEND_URL); see the bundle README.
`)
}

/**
 * Accept the backend profile invocation. The resident plugins own the process
 * lifetime; this action only marks the parsed invocation as accepted.
 * @param ctx - plugin context carrying the command line and exit request.
 */
export function apply(ctx: Context): void {
  const program = backendCommand()
  program.action(() => {
    ctx.provide(BACKEND_APP_STARTUP_SERVICE, { accepted: true })
  })
  parseCmdline(ctx, program)
}
