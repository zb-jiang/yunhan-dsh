/**
 * `GET /api/ppt/status` 的健康载荷。经同包内部模块共享(安装闭环验证的
 * 观测点),不进 plugin entry 导出(verify-plugin-entry-exports)。
 *
 * @module @deepseek-ai/dsh-ppt-core/status
 */

/** `GET /api/ppt/status` 的响应体。 */
export interface PptStatus {
  ok: true
  plugin: 'ppt'
}

/**
 * 健康端点载荷(纯函数,安装闭环验证的观测点)。
 * @returns 固定的健康载荷 `{ ok: true, plugin: 'ppt' }`。
 */
export function statusPayload(): PptStatus {
  return { ok: true, plugin: 'ppt' }
}
