/**
 * 企业服务配置读写面:把 settings RPC 的 describe/update 封装为
 * {@link EnterpriseServicesInjected},供两处入口共用——
 * 设置面板的 settings.section 座位与登录页的常驻「服务配置」弹层。
 *
 * <p>镜像规则:SSO 三项(Provider/Issuer/JWKS URL)与 SUPABASE_URL 双写
 * platform-user-console(JWT 校验条目);WEB_CONSOLE_URL 双写七个消费条目
 * (user-identity-context / knowledge / process-start / llm-access / kb-context /
 * instance-workspace / pocket-access)。镜像目标由字段 mirrorNs 声明。
 * 保存带 revision 乐观并发:打开期间被其他入口改过则拒绝。
 *
 * <p>认证服务组整组应用(saveSso)一次写齐:主条目 platform-user-api 按 provider
 * 分支写键——supabase 模式写验签三元组(issuer/jwksUrl 显式清空,残留会让 JWT
 * 验签按旧认证中心取值)+ SUPABASE_URL/ANON_KEY;非 supabase 模式写验签三元组
 * (真实值)+ clientId/scopes,不动 SUPABASE_URL/ANON_KEY(引擎端不读,切回
 * supabase 无需重填)。镜像条目 platform-user-console 只写验签三元组(supabase
 * 模式附 SUPABASE_URL;console 条目不持 clientId/scopes/anon key)。
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { EnterpriseServicesInjected, FieldSpec, FieldValues, SsoDraft } from './EnterpriseServicesSection.tsx'
import { ALL_FIELDS, validateSsoDraft } from './EnterpriseServicesSection.tsx'

/** ui-enterprise `remote.settings` inject 的使用子集(结构化类型,便于测试桩)。 */
export interface SettingsRpcFace {
  describe: () => Promise<
    | { ok: true; value: { namespaces: readonly { ns: string; revision: number; value: unknown }[] } }
    | { ok: false; error: { message: string } }
  >
  update: (
    ns: string,
    patch: Record<string, JsonValue>,
    expectedRevision?: number,
  ) => Promise<{ ok: true } | { ok: false; error: { message: string } }>
}

/**
 * 从 settings RPC 构造企业服务配置的读写面(两处入口共用同一实例语义)。
 * @param remote ui-enterprise `remote.settings` inject 的使用子集。
 * @returns 承载 load/save 的 {@link EnterpriseServicesInjected} 读写面。
 */
export function createEnterpriseServicesAccess(remote: SettingsRpcFace): EnterpriseServicesInjected {
  const load: EnterpriseServicesInjected['load'] = async () => {
    const response = await remote.describe()
    if (!response.ok) return { ok: false, message: response.error.message }
    const byNs = new Map(response.value.namespaces.map(view => [view.ns, view]))
    const values: FieldValues = {}
    for (const field of ALL_FIELDS) {
      const raw = (byNs.get(field.ns)?.value as Record<string, unknown> | undefined)?.[field.key]
      // object/array 值序列化为 JSON 文本,避免 String() 产生 "[object Object]"。
      values[field.label] = raw === undefined || raw === null
        ? ''
        // oxlint-disable-next-line typescript/no-base-to-string -- false positive: typeof narrowing already excludes objects
        : typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
    }
    return { ok: true, values }
  }

  const save: EnterpriseServicesInjected['save'] = async (field: FieldSpec, value: string) => {
    const typed = field.number ? Number(value) : value
    if (field.number && !Number.isFinite(typed)) {
      return { ok: false, message: `${field.label} 必须是数字(毫秒)` }
    }
    // 先读 describe 拿 revision(乐观并发:入口打开期间被改过则拒绝)
    const describe = await remote.describe()
    if (!describe.ok) return { ok: false, message: describe.error.message }
    const revisionOf = (ns: string): number | undefined =>
      describe.value.namespaces.find(view => view.ns === ns)?.revision
    const primary = await remote.update(field.ns, { [field.key]: typed }, revisionOf(field.ns))
    if (!primary.ok) return { ok: false, message: primary.error.message }

    // 镜像条目跟随:同一配置被多个插件条目各持一份(SSO 三项与 SUPABASE_URL
    // 双写 platform-user-console,WEB_CONSOLE_URL 双写七个消费插件),
    // 主条目保存成功后逐一同步,任一失败即报出未完成条目。
    for (const ns of field.mirrorNs ?? []) {
      const mirror = await remote.update(ns, { [field.key]: typed }, revisionOf(ns))
      if (!mirror.ok) {
        return { ok: false, message: `主条目已保存,但 ${ns} 同步失败: ${mirror.error.message}` }
      }
    }
    return { ok: true }
  }

  const saveSso: EnterpriseServicesInjected['saveSso'] = async (draft: SsoDraft) => {
    const invalid = validateSsoDraft(draft)
    if (invalid !== null) return { ok: false, message: invalid }
    // 字段定义是本文件编译期已知清单,find 不到说明定义被破坏,fails loud
    const fieldByLabel = (label: string): FieldSpec => {
      const found = ALL_FIELDS.find(field => field.label === label)
      if (found === undefined) throw new Error(`字段定义缺失: ${label}`)
      return found
    }
    const providerField = fieldByLabel('SSO_PROVIDER')
    const supabase = draft.provider === 'supabase'
    // 验签三元组:主条目与镜像条目共用的部分;supabase 模式显式清空 issuer/jwksUrl
    const verifyPatch: Record<string, JsonValue> = {
      [providerField.key]: draft.provider,
      [fieldByLabel('SSO_ISSUER').key]: supabase ? '' : draft.issuer.trim(),
      [fieldByLabel('SSO_JWKS_URL').key]: supabase ? '' : draft.jwksUrl.trim(),
    }
    // supabase 登录参数:主条目写两键;镜像条目只跟 SUPABASE_URL(console 不持 anon key)
    const supabaseUrlKey = fieldByLabel('SUPABASE_URL').key
    const supabasePatch: Record<string, JsonValue> = {
      [supabaseUrlKey]: draft.supabaseUrl.trim(),
      [fieldByLabel('SUPABASE_ANON_KEY').key]: draft.supabaseAnonKey.trim(),
    }
    // 非 supabase 模式不动 SUPABASE_URL/ANON_KEY(引擎端不读,切回 supabase 无需重填)
    const primaryPatch: Record<string, JsonValue> = supabase
      ? { ...verifyPatch, ...supabasePatch }
      : {
        ...verifyPatch,
        [fieldByLabel('SSO_CLIENT_ID').key]: draft.clientId.trim(),
        [fieldByLabel('SSO_SCOPES').key]: draft.scopes.trim(),
      }
    // 先读 describe 拿 revision(乐观并发:入口打开期间被改过则拒绝)
    const describe = await remote.describe()
    if (!describe.ok) return { ok: false, message: describe.error.message }
    const revisionOf = (ns: string): number | undefined =>
      describe.value.namespaces.find(view => view.ns === ns)?.revision
    const primary = await remote.update(providerField.ns, primaryPatch, revisionOf(providerField.ns))
    if (!primary.ok) return { ok: false, message: primary.error.message }

    const mirrorPatch: Record<string, JsonValue> = supabase
      ? { ...verifyPatch, [supabaseUrlKey]: draft.supabaseUrl.trim() }
      : verifyPatch
    for (const ns of providerField.mirrorNs ?? []) {
      const mirror = await remote.update(ns, mirrorPatch, revisionOf(ns))
      if (!mirror.ok) {
        return { ok: false, message: `主条目已保存,但 ${ns} 同步失败: ${mirror.error.message}` }
      }
    }
    return { ok: true }
  }

  return { load, save, saveSso }
}
