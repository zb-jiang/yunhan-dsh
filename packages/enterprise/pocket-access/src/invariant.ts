/** Package-owned invariant companion for `@deepseek-ai/dsh-pocket-access`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-pocket-access'

/** Cordis companion plugin name. */
export const name = 'pocket-access-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * 无运行时不变量：双闸门（设备 cookie HMAC 校验、同账号身份比对）与监听器
 * 生命周期（随 enabled 开关启停）的全部断言只从插件自持状态（设备清单、
 * Config.enabled、代理 server 句柄）推导，均有直接单测覆盖（tests/ 下按
 * 设计文档 §9 全表），不存在可与之分叉的独立观测源。
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
