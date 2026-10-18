/**
 * bpmn-js-token-simulation 的类型声明(包未自带 .d.ts)。
 *
 * <p>默认导出为 additionalModules 用的 DI 模块对象,含 toggle-mode(仿真/建模切换)、
 * 画布锁定、建模禁用等子模块;本仓库只经 additionalModules 挂载,不直接调用其内部服务。
 */

declare module 'bpmn-js-token-simulation' {
  const TokenSimulationModule: Record<string, unknown>
  export default TokenSimulationModule
}
