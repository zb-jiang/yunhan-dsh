/**
 * 企业服务配置面板:settings.section 座位的员工端服务配置页。
 *
 * <p>读取 Host settings describe() 的四个企业插件条目(platform-user-console、
 * platform-user-api、flowable-task-proxy、skill-sync),把散落的端点配置聚合为
 * 三组字段:认证服务(Supabase URL/Anon Key)、流程引擎(Engine URL)、技能分发
 * (SkillHub URL/Token/同步间隔)。保存经 ctx.remote.settings.update 写入用户
 * profile 文档,volatile 字段即时生效、持久化(重启后仍生效,优先级高于启动
 * 环境变量)。改 SUPABASE_URL 时弹确认框明示"当前登录会话将失效"。
 *
 * <p>敏感字段(Anon Key/Token)由本组件 UI 层打码显示(小眼睛切换明文);
 * 插件 schema 不标 role('secret'),否则 wire 读取永久打码、无法回显。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
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
}

/** 面板分组:一组字段 + 一次保存动作。 */
interface GroupSpec {
  title: string
  fields: FieldSpec[]
}

/** 四个分组的字段编排;镜像字段(SUPABASE_URL/WEB_CONSOLE_URL)由 save 逻辑特殊处理。 */
const GROUPS: readonly GroupSpec[] = [
  {
    title: '认证服务',
    fields: [
      { ns: 'platform-user-api', key: 'supabaseUrl', label: 'SUPABASE_URL', hint: 'Supabase 项目地址,登录认证使用', probe: 'supabase' },
      { ns: 'platform-user-api', key: 'supabaseAnonKey', label: 'SUPABASE_ANON_KEY', hint: 'Supabase anon key', secret: true },
    ],
  },
  {
    title: '管理控制台',
    fields: [
      { ns: 'platform-user-console', key: 'webConsoleBaseUrl', label: 'WEB_CONSOLE_URL', hint: 'Web Console 基地址(用户自读/组织身份/知识库/流程发起)', probe: 'actuator' },
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

/** SUPABASE_URL 在两个条目各存一份(platform-user-api 暴露给前端,platform-user-console 做 JWT 校验),保存时双写。 */
export const SUPABASE_URL_MIRROR_NS = 'platform-user-console'

/**
 * WEB_CONSOLE_URL 消费者镜像:主条目 platform-user-console(JWT 自读)之外,
 * user-identity-context(组织身份)、knowledge(知识库代理)、process-start
 * (流程发起)、llm-access(LLM 网关)、kb-context(知识库上下文)、
 * instance-workspace(实例工作区)、pocket-access(口袋代理)各持有一份,
 * 保存时同步写入,八处保持一致。
 */
export const WEB_CONSOLE_URL_MIRROR_NS: readonly string[] = [
  'user-identity-context',
  'knowledge',
  'process-start',
  'llm-access',
  'kb-context',
  'instance-workspace',
  'pocket-access',
]

/** 加载结果:字段名 → 当前生效值。 */
export type FieldValues = Record<string, string>

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

/** @param props - 注入的读写面。 @returns 企业服务配置设置页。 */
export function EnterpriseServicesSection({ load, save }: EnterpriseServicesSectionProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>({ loaded: {}, drafts: {} })
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  // 手动测试状态:字段名 → 探测中 / 最近一次结果(null=未测过)
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult | 'failed'>>({})
  // 保存确认框:URL 字段连通性测试失败(软阻止)或 SUPABASE_URL 变更时弹出
  const [confirming, setConfirming] = useState<{ field: FieldSpec; value: string; probeError?: string } | null>(null)

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

  const saveField = (field: FieldSpec, value: string): void => {
    setSavingKey(field.label)
    setMessage(null)
    void save(field, value).then((result) => {
      setSavingKey(null)
      if (result.ok) {
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
          // 连通正常:仅 SUPABASE_URL 需要登录失效确认
          if (field.ns === 'platform-user-api' && field.key === 'supabaseUrl') {
            setConfirming({ field, value })
          } else {
            saveField(field, value)
          }
        } else {
          setConfirming({
            field,
            value,
            probeError: result.error ?? `探测目标无响应(HTTP ${result.status})`,
          })
        }
      })
      return
    }
    // SUPABASE_URL 变更 → 登录会话失效,先确认
    if (field.ns === 'platform-user-api' && field.key === 'supabaseUrl') {
      setConfirming({ field, value })
      return
    }
    saveField(field, value)
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
          {group.fields.map(field => (
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
                <Button
                  variant="outline"
                  disabled={savingKey !== null
                    || form.drafts[field.label] === form.loaded[field.label]}
                  onClick={() => { requestSave(field) }}
                >
                  {savingKey === field.label ? '保存中…' : '保存'}
                </Button>
              </span>
            </label>
          ))}
        </fieldset>
      ))}

      {status === 'ready' && dirty && (
        <p className={css.dirtyHint}>存在未保存的修改;每个字段单独保存。</p>
      )}

      <Modal
        open={confirming !== null}
        onClose={() => { setConfirming(null) }}
        title={confirming?.probeError !== undefined ? '连通性测试失败' : '确认修改 Supabase 地址'}
        headless={true}
        className={css.modal ?? ''}
      >
        {confirming !== null && (
          <div className={css.dialog}>
            <div className={css.dialogHeader}>
              <h3 className={css.dialogTitle}>
                {confirming.probeError !== undefined
                  ? `连通性测试失败,确认保存 ${confirming.field.label}?`
                  : '修改 SUPABASE_URL 后需要重新登录'}
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
            {confirming.probeError === undefined && confirming.field.ns === 'platform-user-api' && confirming.field.key === 'supabaseUrl' && (
              <div className={css.warning}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M10 3.5 18 16.5H2L10 3.5Z" strokeLinejoin="round" />
                  <path d="M10 8.5v3.6" strokeLinecap="round" />
                  <circle cx="10" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
                </svg>
                <span>保存后当前登录会话将失效,你需要退出并使用新地址重新登录。</span>
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
