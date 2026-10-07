/**
 * 覆盖 diagram-js translate 服务的汉化字典。
 *
 * <p>官方 bpmn-js-properties-panel 内置 provider 的 tab 标题(General/Documentation)、
 * 组标题与条目标签均经 translate 服务输出;此模块只映射需要汉化的字符串,
 * 未命中的原样返回,DSH 自定义 provider 的中文文案不受影响。
 */
const dict: Record<string, string> = {
  // 组标题(与 DSH provider 的中文组标题风格一致,不带英文回注)
  General: '通用设置',
  Documentation: '文档',
  'Multi-instance': '多实例',
  // 二级属性名(中文在前,括号内保留英文原名)
  Name: '名称 (Name)',
  'Element documentation': '元素文档 (Element documentation)',
  'Completion condition': '完成条件 (Completion condition)',
  'Loop cardinality': '循环基数 (Loop cardinality)',
  'Element variable': '元素变量 (Element variable)',
  Value: '值 (Value)',
}

const translateZh = (str: string): string => dict[str] ?? str

/** diagram-js 模块形态:以 value 注入同名 translate 服务完成覆盖。 */
export const TranslateZhModule = {
  translate: ['value', translateZh],
}
