/**
 * 企业服务配置读写面:把 settings RPC 的 describe/update 封装为
 * {@link EnterpriseServicesInjected},供两处入口共用——
 * 设置面板的 settings.section 座位与登录页的常驻「服务配置」弹层。
 *
 * <p>镜像规则:SUPABASE_URL 双写 platform-user-console(JWT 校验条目);
 * WEB_CONSOLE_URL 八条目镜像(user-identity-context / knowledge / process-start /
 * llm-access / kb-context / instance-workspace / pocket-access 各一份)。
 * 保存带 revision 乐观并发:打开期间被其他入口改过则拒绝。
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { EnterpriseServicesInjected, FieldSpec, FieldValues } from './EnterpriseServicesSection.tsx'
import { ALL_FIELDS, SUPABASE_URL_MIRROR_NS, WEB_CONSOLE_URL_MIRROR_NS } from './EnterpriseServicesSection.tsx'

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

    // SUPABASE_URL 双写:platform-user-console 的 JWT 校验条目保持一致
    if (field.ns === 'platform-user-api' && field.key === 'supabaseUrl') {
      const mirror = await remote.update(
        SUPABASE_URL_MIRROR_NS, { supabaseUrl: typed }, revisionOf(SUPABASE_URL_MIRROR_NS),
      )
      if (!mirror.ok) {
        return { ok: false, message: `主条目已保存,但 ${SUPABASE_URL_MIRROR_NS} 同步失败: ${mirror.error.message}` }
      }
    }
    // WEB_CONSOLE_URL 四条目镜像:组织身份/知识库/流程发起消费者与主条目保持一致
    if (field.ns === 'platform-user-console' && field.key === 'webConsoleBaseUrl') {
      for (const ns of WEB_CONSOLE_URL_MIRROR_NS) {
        const mirror = await remote.update(ns, { webConsoleBaseUrl: typed }, revisionOf(ns))
        if (!mirror.ok) {
          return { ok: false, message: `主条目已保存,但 ${ns} 同步失败: ${mirror.error.message}` }
        }
      }
    }
    return { ok: true }
  }

  return { load, save }
}
