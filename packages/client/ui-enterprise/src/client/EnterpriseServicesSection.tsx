/**
 * 企业服务配置面板:settings.section 座位的员工端服务配置页。
 *
 * <p>读取 Host settings describe() 的四个企业插件条目(platform-user-console、
 * platform-user-api、flowable-task-proxy、skill-sync),把散落的端点配置聚合为
 * 四组字段:认证服务(SSO_PROVIDER 下拉置组首位,按 provider 条件显示参数——
 * supabase 显示 SUPABASE_URL/ANON_KEY,casdoor/customer-oidc 显示
 * SSO_ISSUER/JWKS_URL/CLIENT_ID/SCOPES;后端 platform-user-api 与
 * platform-user-console 已暴露同名 volatile 字段)、管理控制台(Console URL)、
 * 流程引擎(Engine URL)、技能分发(SkillHub URL/Token/同步间隔)。保存经
 * ctx.remote.settings.update 写入用户 profile 文档,volatile 字段即时生效、
 * 持久化(重启后仍生效,优先级高于启动环境变量)。认证服务组整组应用(provider
 * 决定其余字段语义,两种模式的登录参数互斥:auth-session 按判别联合切换;
 * supabase 模式应用时清空 SSO_ISSUER/SSO_JWKS_URL 残留,非 supabase 模式
 * 不动 SUPABASE_URL/ANON_KEY),其余字段单独保存;认证中心参数落盘成功后
 * 自动清空本地登录凭据并整页刷新,强制按新认证中心重新登录(Electron 打包版
 * 没有手动刷新通道)。镜像条目(SSO 三项与 SUPABASE_URL 双写
 * platform-user-console,WEB_CONSOLE_URL 双写七个消费插件)由字段 mirrorNs
 * 声明,保存时逐一同步写入。
 *
 * <p>敏感字段(Anon Key/Token)由本组件 UI 层打码显示(小眼睛切换明文);
 * 插件 schema 不标 role('secret'),否则 wire 读取永久打码、无法回显。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { clearAnonymousPreference, clearStoredLoginState } from './auth-session.ts'
import css from './EnterpriseServicesSection.module.css'

/** 单个配置字段的展示定义。 */
export interface FieldSpec {
  /** settings 命名空间(profile entry id)。 */
  ns: string
  /** 命名空间内字段名。 */
  key: string
  /** 显示名(环境变量名)。 */
  label: string
  /** 用途说明。 */
  hint: string
  /** 是否敏感字段(UI 打码 + 小眼睛)。 */
  secret?: boolean
  /** 数字字段(同步间隔)。 */
  number?: boolean
  /**
   * 连通性探测目标类型(URL 字段才有):supabase→/auth/v1/health;
   * actuator→/actuator/health;root→仅探测基地址可达(SkillHub 无 health 端点)。
   */
  probe?: 'supabase' | 'actuator' | 'root'
  /**
   * 镜像命名空间:保存时把同名字段同步写入的其他 profile 条目——同一配置
   * 被多个插件条目各持一份(SSO 三项与 SUPABASE_URL 双写 platform-user-console,
   * WEB_CONSOLE_URL 双写七个消费插件),改一处必须全部跟随。
   */
  mirrorNs?: readonly string[]
  /** 保存前弹「登录会话失效」确认(认证中心参数,改动使当前 JWT/登录流程失效)。 */
  requireRelogin?: true
  /** 下拉选项(声明后渲染 select 而非文本框;当前仅 SSO_PROVIDER)。 */
  options?: readonly string[]
  /**
   * 按 SSO provider 的可见性谓词:返回 false 的字段在当前 provider 下整个
   * 隐藏而非禁用(认证服务组按模式收缩,只呈现该模式需要填的参数)。
   */
  visibleWhen?: (provider: SsoProvider) => boolean
}

/** 面板分组:一组字段 + 一次保存动作。 */
interface GroupSpec {
  title: string
  fields: FieldSpec[]
  /**
   * 组级应用:组内字段不单独保存,组底部一个「应用」按钮整组提交
   * (认证服务组专用——provider 决定其余字段的语义,拆开保存会出现中间态)。
   */
  groupApply?: true
}

/**
 * WEB_CONSOLE_URL 消费者镜像:主条目 platform-user-console(JWT 自读)之外,
 * user-identity-context(组织身份)、knowledge(知识库代理)、process-start
 * (流程发起)、llm-access(LLM 网关)、kb-context(知识库上下文)、
 * instance-workspace(实例工作区)、pocket-access(口袋代理)各持有一份,
 * 保存时同步写入,八处保持一致。
 */
const WEB_CONSOLE_URL_MIRROR_NS: readonly string[] = [
  'user-identity-context',
  'knowledge',
  'process-start',
  'llm-access',
  'kb-context',
  'instance-workspace',
  'pocket-access',
]

/** SSO 认证中心类型枚举(下拉选项;与平台侧 SSO_PROVIDER 的合法值一致)。 */
export const SSO_PROVIDERS = ['supabase', 'casdoor', 'customer-oidc'] as const
/** SSO 认证中心类型。 */
export type SsoProvider = (typeof SSO_PROVIDERS)[number]

/** 四个分组的字段编排;镜像条目由字段 mirrorNs 声明,save 侧统一双写。 */
const GROUPS: readonly GroupSpec[] = [
  {
    title: '认证服务',
    groupApply: true,
    fields: [
      { ns: 'platform-user-api', key: 'provider', label: 'SSO_PROVIDER', hint: '认证中心类型,缺省 supabase;非 supabase 须先配好 ISSUER/CLIENT_ID 再切换', options: SSO_PROVIDERS, requireRelogin: true, mirrorNs: ['platform-user-console'] },
      { ns: 'platform-user-api', key: 'supabaseUrl', label: 'SUPABASE_URL', hint: 'Supabase 项目地址,登录认证使用', probe: 'supabase', requireRelogin: true, mirrorNs: ['platform-user-console'], visibleWhen: provider => provider === 'supabase' },
      { ns: 'platform-user-api', key: 'supabaseAnonKey', label: 'SUPABASE_ANON_KEY', hint: 'Supabase anon key', secret: true, visibleWhen: provider => provider === 'supabase' },
      { ns: 'platform-user-api', key: 'issuer', label: 'SSO_ISSUER', hint: '认证中心 issuer;非 supabase 必填(casdoor 填隧道域名)', requireRelogin: true, mirrorNs: ['platform-user-console'], visibleWhen: provider => provider !== 'supabase' },
      { ns: 'platform-user-api', key: 'jwksUrl', label: 'SSO_JWKS_URL', hint: 'JWKS 端点;留空按 OIDC 发现推导;Casdoor 无 .json 后缀,必须显式设置', probe: 'root', requireRelogin: true, mirrorNs: ['platform-user-console'], visibleWhen: provider => provider !== 'supabase' },
      { ns: 'platform-user-api', key: 'clientId', label: 'SSO_CLIENT_ID', hint: '员工端在认证中心注册的 client id,非 supabase 必填', visibleWhen: provider => provider !== 'supabase' },
      { ns: 'platform-user-api', key: 'scopes', label: 'SSO_SCOPES', hint: 'OIDC 授权码流程 scopes,为空缺省 openid profile;不含 openid 则认证中心不签 id_token', visibleWhen: provider => provider !== 'supabase' },
    ],
  },
  {
    title: '管理控制台',
    fields: [
      { ns: 'platform-user-console', key: 'webConsoleBaseUrl', label: 'WEB_CONSOLE_URL', hint: 'Web Console 基地址(用户自读/组织身份/知识库/流程发起)', probe: 'actuator', mirrorNs: WEB_CONSOLE_URL_MIRROR_NS },
    ],
  },
  {
    title: '流程引擎',
    fields: [
      { ns: 'flowable-task-proxy', key: 'engineBaseUrl', label: 'FLOWABLE_ENGINE_URL', hint: '流程引擎基地址(待办/历史代理目标)', probe: 'actuator' },
    ],
  },
  {
    title: '技能分发',
    fields: [
      { ns: 'skill-sync', key: 'skillhubBaseUrl', label: 'SKILLHUB_URL', hint: 'SkillHub 后端地址', probe: 'root' },
      { ns: 'skill-sync', key: 'skillhubToken', label: 'SKILLHUB_API_TOKEN', hint: 'SkillHub 分发 token', secret: true },
      { ns: 'skill-sync', key: 'intervalMs', label: 'SKILL_SYNC_INTERVAL_MS', hint: '同步间隔毫秒(10 分钟 = 600000)', number: true },
    ],
  },
]

/** 全部字段展平(加载/保存遍历用;apply 侧读取 describe 时遍历同一清单)。 */
export const ALL_FIELDS: readonly FieldSpec[] = GROUPS.flatMap(group => group.fields)

/** 探测结果(Node 侧端点返回)。 */
export interface ProbeResult {
  ok: boolean
  status: number
  latencyMs: number
  error?: string
}

/** 按探测类型拼装实际探测 URL。 */
export function probeTarget(kind: NonNullable<FieldSpec['probe']>, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  switch (kind) {
    case 'supabase': return `${base}/auth/v1/health`
    case 'actuator': return `${base}/actuator/health`
    case 'root': return base
  }
}

/**
 * 经本地 Node 侧端点探测目标连通性(绕浏览器 CORS:引擎/console/SkillHub
 * 端点不开 CORS,浏览器直连会把正确配置误报为不可达)。
 */
export async function probeConnectivity(kind: NonNullable<FieldSpec['probe']>, baseUrl: string): Promise<ProbeResult> {
  const res = await fetch('api/enterprise/auth/connectivity-check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: probeTarget(kind, baseUrl) }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`探测请求失败: ${res.status} ${text}`)
  }
  return await res.json() as ProbeResult
}

/** 加载结果:字段名 → 当前生效值。 */
export type FieldValues = Record<string, string>

/**
 * @param value settings 原始字符串值(无类型保证)。
 * @returns 是否为合法 SSO provider 枚举值。
 */
export function isSsoProvider(value: string): value is SsoProvider {
  return (SSO_PROVIDERS as readonly string[]).includes(value)
}

/** 认证服务组整组草稿:provider + 两种模式的登录参数(组级一次应用,不逐字段保存)。 */
export interface SsoDraft {
  provider: SsoProvider
  /** supabase 模式登录参数;非 supabase 模式应用时保持原值不动。 */
  supabaseUrl: string
  supabaseAnonKey: string
  /** 非 supabase 模式登录参数;supabase 模式应用时由 access 侧清空 issuer/jwksUrl 残留。 */
  issuer: string
  jwksUrl: string
  clientId: string
  scopes: string
}

/**
 * 从字段值表提取认证服务组草稿(settings 值无类型保证):provider 非法/缺失回落
 * supabase,与后端缺省一致。
 * @param values 字段名 → 生效值/草稿值。
 * @returns 归一化后的认证服务组草稿。
 */
export function toSsoDraft(values: FieldValues): SsoDraft {
  const provider = values.SSO_PROVIDER ?? ''
  return {
    provider: isSsoProvider(provider) ? provider : 'supabase',
    supabaseUrl: values.SUPABASE_URL ?? '',
    supabaseAnonKey: values.SUPABASE_ANON_KEY ?? '',
    issuer: values.SSO_ISSUER ?? '',
    jwksUrl: values.SSO_JWKS_URL ?? '',
    clientId: values.SSO_CLIENT_ID ?? '',
    scopes: values.SSO_SCOPES ?? '',
  }
}

/**
 * 校验认证服务组草稿,返回首个错误消息;合法返回 null。只校验当前模式必需的
 * 参数:supabase 模式要求 SUPABASE_URL/ANON_KEY(issuer/jwksUrl 残留由 access
 * 侧清空);非 supabase 模式 issuer/clientId 必填(jwksUrl 留空按 OIDC 发现推导)。
 * @param draft 待校验的认证服务组草稿。
 */
export function validateSsoDraft(draft: SsoDraft): string | null {
  if (draft.provider === 'supabase') {
    if (draft.supabaseUrl.trim() === '') return 'SUPABASE_URL 必填:supabase 认证中心的项目地址'
    if (draft.supabaseAnonKey.trim() === '') return 'SUPABASE_ANON_KEY 必填:supabase 认证中心的 anon key'
    return null
  }
  if (draft.issuer.trim() === '') return 'SSO_ISSUER 必填:非 supabase 认证中心必须显式提供 issuer'
  if (draft.clientId.trim() === '') return 'SSO_CLIENT_ID 必填:员工端在认证中心注册的 client id'
  return null
}

/** Host 读写面(apply 注入,组件保持 Cordis-free)。 */
export interface EnterpriseServicesInjected {
  /** 读取全部字段的当前生效值;失败携带可展示消息。 */
  load: () => Promise<{ ok: true; values: FieldValues } | { ok: false; message: string }>
  /**
   * 保存一个字段。
   * @param field - 字段定义。
   * @param value - 新值(字符串;数字字段由 Host schema 校验)。
   * @returns 保存结果;失败携带可展示消息。
   */
  save: (field: FieldSpec, value: string) => Promise<{ ok: boolean; message?: string }>
  /**
   * 整组应用认证服务配置:主条目与镜像条目一次写齐;supabase 模式显式清空
   * SSO_ISSUER/SSO_JWKS_URL 残留(残留会让 JWT 验签按旧认证中心取值)并写入
   * SUPABASE_URL/ANON_KEY;非 supabase 模式不动 SUPABASE_URL/ANON_KEY。
   * @param draft - 归一化后的认证服务组草稿。
   * @returns 应用结果;失败携带可展示消息。
   */
  saveSso: (draft: SsoDraft) => Promise<{ ok: boolean; message?: string }>
}

/**
 * 组合 props:仅依赖注入的读写面(设置面板座位与登录页弹层共用;
 * 座位渲染时的 runtime props 是超集,组件只解构 load/save)。
 */
export type EnterpriseServicesSectionProps = InjectFace<EnterpriseServicesInjected>

/** 表单状态:加载值(判断是否变更/展示占位)、草稿值。 */
interface FormState {
  loaded: FieldValues
  drafts: FieldValues
}

/** 保存确认框:字段级保存与 SSO 组级应用两种确认形态。 */
type ConfirmState =
  | { kind: 'field'; field: FieldSpec; value: string; probeError?: string }
  | { kind: 'sso'; draft: SsoDraft; probeError?: string }

/** 认证服务组草稿逐字段相等比较(组级应用按钮的 dirty 判定)。 */
function sameSsoDraft(a: SsoDraft, b: SsoDraft): boolean {
  return a.provider === b.provider && a.supabaseUrl === b.supabaseUrl
    && a.supabaseAnonKey === b.supabaseAnonKey && a.issuer === b.issuer
    && a.jwksUrl === b.jwksUrl && a.clientId === b.clientId && a.scopes === b.scopes
}

/** @param props - 注入的读写面。 @returns 企业服务配置设置页。 */
export function EnterpriseServicesSection({ load, save, saveSso }: EnterpriseServicesSectionProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>({ loaded: {}, drafts: {} })
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  // 手动测试状态:字段名 → 探测中 / 最近一次结果(null=未测过)
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult | 'failed'>>({})
  // 保存确认框:字段级(URL 连通失败软阻止/认证参数变更)与 SSO 组级应用两种形态
  const [confirming, setConfirming] = useState<ConfirmState | null>(null)

  const runProbe = useCallback((field: FieldSpec, value: string): Promise<ProbeResult> => {
    setProbing(prev => ({ ...prev, [field.label]: true }))
    return probeConnectivity(field.probe as NonNullable<FieldSpec['probe']>, value)
      .catch((error: unknown) => {
        const result: ProbeResult = { ok: false, status: 0, latencyMs: 0, error: error instanceof Error ? error.message : String(error) }
        setProbeResults(prev => ({ ...prev, [field.label]: result }))
        return result
      })
      .finally(() => {
        setProbing(prev => Object.fromEntries(
          Object.entries(prev).filter(([key]) => key !== field.label),
        ))
      })
      .then((result) => {
        setProbeResults(prev => ({ ...prev, [field.label]: result }))
        return result
      })
  }, [])

  const handleProbe = (field: FieldSpec): void => {
    const value = (form.drafts[field.label] ?? '').trim()
    if (value === '') return
    void runProbe(field, value)
  }

  const refresh = useCallback(() => {
    setStatus('loading')
    void load().then((result) => {
      if (result.ok) {
        setForm({ loaded: result.values, drafts: result.values })
        setStatus('ready')
        setMessage(null)
      } else {
        setStatus('failed')
        setMessage(result.message)
      }
    })
  }, [load])
  useEffect(() => { refresh() }, [refresh])

  const dirty = ALL_FIELDS.some(field => form.drafts[field.label] !== form.loaded[field.label])

  // 认证服务组:归一化草稿/生效值 → 组级 dirty。残留条款:provider 为 supabase 但
  // 生效值仍持有 issuer/jwksUrl(此前配过认证中心又切回)——残留会让 JWT 验签
  // 按旧认证中心取值、全员登录失败,此时草稿与生效值相等也要可应用以触发清理。
  const ssoLoaded = toSsoDraft(form.loaded)
  const ssoDraft = toSsoDraft(form.drafts)
  const ssoResidual = ssoLoaded.provider === 'supabase' && (ssoLoaded.issuer !== '' || ssoLoaded.jwksUrl !== '')
  const ssoDirty = !sameSsoDraft(ssoDraft, ssoLoaded) || ssoResidual

  const saveField = (field: FieldSpec, value: string): void => {
    setSavingKey(field.label)
    setMessage(null)
    void save(field, value).then((result) => {
      setSavingKey(null)
      if (result.ok) {
        // 认证中心参数变更使本地会话失效:清全部本地凭据(含匿名放行,刷新后回
        // 登录页重新选择登录形态)后整页刷新,initAuth 重新读 config
        // (Electron 打包版没有手动刷新通道)
        if (field.requireRelogin === true) {
          clearStoredLoginState()
          clearAnonymousPreference()
          window.location.reload()
          return
        }
        setForm(prev => ({
          loaded: { ...prev.loaded, [field.label]: value },
          drafts: { ...prev.drafts, [field.label]: value },
        }))
        setMessage(`${field.label} 已保存并生效`)
      } else {
        setMessage(result.message ?? '保存失败')
      }
    })
  }

  const requestSave = (field: FieldSpec): void => {
    const value = form.drafts[field.label] ?? ''
    if (value === form.loaded[field.label]) return
    // URL 字段软阻止:保存前自动探测连通性,失败不强拦但弹强确认框明示后果
    if (field.probe !== undefined && value.trim() !== '') {
      setSavingKey(field.label)
      void runProbe(field, value).then((result) => {
        setSavingKey(null)
        if (result.ok) {
          // 连通正常:影响登录会话的字段仍需确认(认证中心参数变更使现有会话失效)
          if (field.requireRelogin === true) {
            setConfirming({ kind: 'field', field, value })
          } else {
            saveField(field, value)
          }
        } else {
          setConfirming({
            kind: 'field',
            field,
            value,
            probeError: result.error ?? `探测目标无响应(HTTP ${result.status})`,
          })
        }
      })
      return
    }
    // 认证中心参数变更 → 登录会话失效,先确认
    if (field.requireRelogin === true) {
      setConfirming({ kind: 'field', field, value })
      return
    }
    saveField(field, value)
  }

  /** 认证服务组级应用:先校验,非 supabase 且 JWKS URL 非空时探测软阻止,再弹确认框。 */
  const requestSsoApply = (): void => {
    const invalid = validateSsoDraft(ssoDraft)
    if (invalid !== null) {
      setMessage(invalid)
      return
    }
    if (ssoDraft.provider !== 'supabase' && ssoDraft.jwksUrl.trim() !== '') {
      const jwksField = ALL_FIELDS.find(field => field.label === 'SSO_JWKS_URL') as FieldSpec
      setSavingKey('SSO')
      void runProbe(jwksField, ssoDraft.jwksUrl).then((result) => {
        setSavingKey(null)
        setConfirming(result.ok
          ? { kind: 'sso', draft: ssoDraft }
          : { kind: 'sso', draft: ssoDraft, probeError: result.error ?? `探测目标无响应(HTTP ${result.status})` })
      })
      return
    }
    setConfirming({ kind: 'sso', draft: ssoDraft })
  }

  /** 认证服务组级应用落盘:成功即清本地登录凭据(含匿名放行,刷新后回登录页)并整页刷新(强制按新认证中心重登)。 */
  const applySso = (draft: SsoDraft): void => {
    setSavingKey('SSO')
    setMessage(null)
    void saveSso(draft).then((result) => {
      if (result.ok) {
        clearStoredLoginState()
        clearAnonymousPreference()
        window.location.reload()
        return
      }
      setSavingKey(null)
      setMessage(result.message ?? '认证服务配置保存失败')
    })
  }

  return (
    <div className={css.page}>
      <p className={css.lede}>
        以下配置在保存后立即生效并持久保存(重启后仍生效,优先于启动环境变量)。
        由环境变量注入的值在修改前原样显示。
      </p>

      {status === 'failed' && (
        <div className={css.error}>{message ?? '配置读取失败'}</div>
      )}
      {status === 'ready' && message !== null && (
        <div className={css.notice} role="status">{message}</div>
      )}

      {status === 'loading' && <div className={css.loading}>正在读取配置…</div>}

      {status === 'ready' && GROUPS.map(group => (
        <fieldset key={group.title} className={css.group}>
          <legend className={css.groupTitle}>{group.title}</legend>
          {group.fields.map((field) => {
            // 条件可见性:不属于当前 provider 的登录参数整个隐藏(组按模式收缩),
            // 草稿保持原值,应用时按 provider 分支写盘
            if (field.visibleWhen !== undefined && !field.visibleWhen(ssoDraft.provider)) return null
            return (
              <label key={field.label} className={css.field}>
                <span className={css.fieldHead}>
                  <span className={css.fieldLabel}>{field.label}</span>
                  {field.secret && (
                    <button
                      type="button"
                      className={css.eye}
                      aria-label={revealed[field.label] ? '隐藏明文' : '显示明文'}
                      onClick={() => { setRevealed(prev => ({ ...prev, [field.label]: !prev[field.label] })) }}
                    >
                      {revealed[field.label]
                        ? <EyeOffIcon />
                        : <EyeIcon />}
                    </button>
                  )}
                </span>
                {field.options !== undefined ? (
                  <select
                    className={css.select}
                    value={ssoDraft.provider}
                    onChange={(event) => {
                      const next = event.target.value
                      setForm(prev => ({ ...prev, drafts: { ...prev.drafts, [field.label]: next } }))
                    }}
                  >
                    {field.options.map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <input
                    className={css.input}
                    type={field.secret && !revealed[field.label] ? 'password' : 'text'}
                    inputMode={field.number ? 'numeric' : undefined}
                    value={form.drafts[field.label] ?? ''}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      const next = event.target.value
                      setForm(prev => ({ ...prev, drafts: { ...prev.drafts, [field.label]: next } }))
                    }}
                  />
                )}
                <span className={css.fieldHint}>
                  {field.hint}
                  {form.drafts[field.label] !== form.loaded[field.label] && (
                    <span className={css.dirtyMark}> · 已修改</span>
                  )}
                  {field.probe !== undefined && probeResults[field.label] !== undefined && (
                    probeResults[field.label] === 'failed'
                      ? <span className={css.probeFail}> · 探测请求失败</span>
                      : (probeResults[field.label] as ProbeResult).ok
                        ? <span className={css.probeOk}> · 可达({(probeResults[field.label] as ProbeResult).latencyMs}ms)</span>
                        : <span className={css.probeFail}> · 不可达:{(probeResults[field.label] as ProbeResult).error ?? '无响应'}</span>
                  )}
                </span>
                <span className={css.fieldActions}>
                  {field.probe !== undefined && (
                    <Button
                      variant="ghost"
                      disabled={probing[field.label] === true || (form.drafts[field.label] ?? '').trim() === ''}
                      onClick={() => { handleProbe(field) }}
                    >
                      {probing[field.label] === true ? '测试中…' : '测试'}
                    </Button>
                  )}
                  {group.groupApply !== true && (
                    <Button
                      variant="outline"
                      disabled={savingKey !== null
                        || form.drafts[field.label] === form.loaded[field.label]}
                      onClick={() => { requestSave(field) }}
                    >
                      {savingKey === field.label ? '保存中…' : '保存'}
                    </Button>
                  )}
                </span>
              </label>
            )
          })}
          {group.groupApply === true && (
            <div className={css.groupActions}>
              {ssoResidual && (
                <span className={css.dirtyMark}>应用时将清空 SSO_ISSUER / SSO_JWKS_URL 残留值</span>
              )}
              <Button
                variant="outline"
                disabled={savingKey !== null || !ssoDirty}
                onClick={() => { requestSsoApply() }}
              >
                {savingKey === 'SSO' ? '应用中…' : '应用'}
              </Button>
            </div>
          )}
        </fieldset>
      ))}

      {status === 'ready' && dirty && (
        <p className={css.dirtyHint}>存在未保存的修改;认证服务组整组应用,其余字段单独保存。</p>
      )}

      <Modal
        open={confirming !== null}
        onClose={() => { setConfirming(null) }}
        title={confirming === null
          ? ''
          : confirming.kind === 'sso'
            ? '确认应用 SSO 配置'
            : `确认修改 ${confirming.field.label}`}
        headless={true}
        className={css.modal ?? ''}
      >
        {confirming !== null && confirming.kind === 'field' && (
          <div className={css.dialog}>
            <div className={css.dialogHeader}>
              <h3 className={css.dialogTitle}>
                {confirming.probeError !== undefined
                  ? `连通性测试失败,确认保存 ${confirming.field.label}?`
                  : `修改 ${confirming.field.label} 后需要重新登录`}
              </h3>
            </div>
            <p className={css.dialogBody}>
              新地址:<span className={css.dialogValue}>{confirming.value}</span>
            </p>
            {confirming.probeError !== undefined && (
              <div className={css.warning}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M10 3.5 18 16.5H2L10 3.5Z" strokeLinejoin="round" />
                  <path d="M10 8.5v3.6" strokeLinecap="round" />
                  <circle cx="10" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
                </svg>
                <span>
                  探测失败({confirming.probeError})。保存后{confirming.field.label === 'SUPABASE_URL' ? '将无法登录,且只能通过登录页服务配置或手改配置文件恢复' : '相关功能将持续不可用'}。请确认地址无误,或检查网络后重试。
                </span>
              </div>
            )}
            {confirming.probeError === undefined && confirming.field.requireRelogin === true && (
              <div className={css.warning}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M10 3.5 18 16.5H2L10 3.5Z" strokeLinejoin="round" />
                  <path d="M10 8.5v3.6" strokeLinecap="round" />
                  <circle cx="10" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
                </svg>
                <span>保存后当前登录会话将失效,你需要退出并重新登录。</span>
              </div>
            )}
            <div className={css.actions}>
              <Button variant="outline" onClick={() => { setConfirming(null) }}>取消</Button>
              <Button
                onClick={() => {
                  const { field, value } = confirming
                  setConfirming(null)
                  saveField(field, value)
                }}
              >
                确认保存
              </Button>
            </div>
          </div>
        )}
        {confirming !== null && confirming.kind === 'sso' && (
          <div className={css.dialog}>
            <div className={css.dialogHeader}>
              <h3 className={css.dialogTitle}>
                {confirming.probeError !== undefined
                  ? '连通性测试失败,确认应用认证服务配置?'
                  : '应用认证服务配置'}
              </h3>
            </div>
            <p className={css.dialogBody}>
              认证中心类型:<span className={css.dialogValue}>{confirming.draft.provider}</span>
            </p>
            {confirming.draft.provider !== 'supabase' && (
              <p className={css.dialogBody}>
                SSO_ISSUER:<span className={css.dialogValue}>{confirming.draft.issuer.trim()}</span>
                <br />
                SSO_JWKS_URL:<span className={css.dialogValue}>
                  {confirming.draft.jwksUrl.trim() === '' ? '(空,按 OIDC 发现推导)' : confirming.draft.jwksUrl.trim()}
                </span>
                <br />
                SSO_CLIENT_ID:<span className={css.dialogValue}>{confirming.draft.clientId.trim()}</span>
                <br />
                SSO_SCOPES:<span className={css.dialogValue}>
                  {confirming.draft.scopes.trim() === '' ? '(空,缺省 openid profile)' : confirming.draft.scopes.trim()}
                </span>
              </p>
            )}
            {confirming.draft.provider === 'supabase' && (
              <p className={css.dialogBody}>
                SUPABASE_URL:<span className={css.dialogValue}>{confirming.draft.supabaseUrl.trim()}</span>
                <br />
                SUPABASE_ANON_KEY:
                <span className={css.dialogValue}>
                  {confirming.draft.supabaseAnonKey.trim() === '' ? '(空)' : '(已填写,不回显)'}
                </span>
              </p>
            )}
            {confirming.draft.provider === 'supabase' && ssoResidual && (
              <p className={css.dialogBody}>应用时将清空 SSO_ISSUER / SSO_JWKS_URL 的残留值。</p>
            )}
            <div className={css.warning}>
              <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M10 3.5 18 16.5H2L10 3.5Z" strokeLinejoin="round" />
                <path d="M10 8.5v3.6" strokeLinecap="round" />
                <circle cx="10" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
              </svg>
              <span>保存后当前登录会话将失效,页面将刷新到登录页。</span>
            </div>
            <div className={css.actions}>
              <Button variant="outline" onClick={() => { setConfirming(null) }}>取消</Button>
              <Button
                onClick={() => {
                  const { draft } = confirming
                  setConfirming(null)
                  applySso(draft)
                }}
              >
                确认应用
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

/** 睁眼图标(明文态)。 */
function EyeIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.4" />
    </svg>
  )
}

/** 闭眼图标(掩码态)。 */
function EyeOffIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2 10s3-5.5 8-5.5c1.6 0 3 .5 4.2 1.2M18 10s-3 5.5-8 5.5c-1.6 0-3-.5-4.2-1.2" strokeLinecap="round" />
      <path d="M3 17 17 3" strokeLinecap="round" />
    </svg>
  )
}
