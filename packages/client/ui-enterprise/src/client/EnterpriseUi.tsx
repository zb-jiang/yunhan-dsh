import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { BrandWordmark } from '@deepseek-ai/dsh-client-ui-primitives'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { EnterpriseServicesSection, type EnterpriseServicesInjected } from './EnterpriseServicesSection.tsx'
import {
  buildOidcAuthorizeUrl,
  clearAnonymousPreference,
  clearAuthSession,
  completeOidcCallback,
  fetchAuthConfig,
  getAuthMode,
  getOidcIssuer,
  readAnonymousPreference,
  readOidcCallback,
  readOidcLoginSuccessMessage,
  readToken,
  setAuthMode,
  setOidcIssuer,
  setOidcRelayUrl,
  tryOidcRefresh,
  writeAnonymousPreference,
  writeToken,
  type AuthMode,
  type AuthWebConfig,
} from './auth-session.ts'
import css from './EnterpriseUi.module.css'

type PlatformUserStatus = 'pending_approval' | 'active' | 'disabled' | 'locked'

type PlatformUserRow = {
  id: string
  authSubject: string
  loginName: string
  displayName: string
  email: string
  status: PlatformUserStatus
  platformRoles: string[]
}

// ── Supabase client (lazy, cached) ──

let supabaseClient: SupabaseClient | null = null
let supabaseInitPromise: Promise<SupabaseClient> | null = null

function getSupabaseClient(): Promise<SupabaseClient> {
  if (supabaseClient !== null) return Promise.resolve(supabaseClient)
  if (supabaseInitPromise !== null) return supabaseInitPromise
  supabaseInitPromise = (async () => {
    const config = await fetchAuthConfig()
    if (config.mode !== 'supabase') throw new Error('当前为认证中心登录模式，无需 Supabase 客户端')
    supabaseClient = createClient(config.url, config.anonKey, {
      // 会话化:session 持久化在 localStorage,access token 到期前由 supabase-js
      // 自动用 refresh token 换新,长驻页面与后台服务不再因 1 小时过期而 401
      auth: { persistSession: true, autoRefreshToken: true },
    })
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session?.access_token !== undefined) {
        if (session.access_token !== readToken()) {
          writeToken(session.access_token)
          // 重拉 /me:既刷新本地用户快照,也让 webserver 的身份快照换到新 token,
          // skill-sync/llm-access 等后台轮询随 platform-user/verified 拿到新 token
          void refreshAuthUser()
        }
      } else if (event === 'SIGNED_OUT') {
        // 本页登出(logout 已清理过,幂等)或其他标签页登出经 storage 同步过来;
        // 登出语义回登录页而非匿名态,一并清匿名放行(另一标签页的 logout 已清本地偏好,
        // 这里补齐本页内存快照)
        exitGuestMode()
        clearAuthSession()
        setAuthSnapshot({ currentUser: null, loading: false, mode: 'supabase', loginError: null })
      }
    })
    return supabaseClient
  })()
  return supabaseInitPromise
}

/**
 * 用当前 token 重拉 /me 刷新用户快照(TOKEN_REFRESHED 后由监听器调用)。
 * 401 时 OIDC 模式先用 refresh_token 换新 id_token 重试一次(带 retried 防死循环),
 * 仍被拒说明会话已失效(账号被禁用/吊销),回登录页;网络类瞬时失败保留当前快照。
 */
async function refreshAuthUser(retried = false): Promise<void> {
  const token = readToken()
  if (token === null) return
  try {
    const res = await fetch('api/enterprise/auth/me', { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 401) {
      if (!retried && getAuthMode() === 'oidc' && await tryOidcRefresh()) {
        await refreshAuthUser(true)
        return
      }
      clearAuthSession()
      setAuthSnapshot({ currentUser: null, loading: false, mode: getAuthMode(), loginError: null })
      return
    }
    if (!res.ok) return
    const user = await res.json() as PlatformUserRow
    setAuthSnapshot({ currentUser: user, loading: false, mode: getAuthMode(), loginError: null })
  } catch { /* 网络失败:保留当前状态,下一次 TOKEN_REFRESHED 再同步 */ }
}

// ── Auth store (module-level, shared across Nav + Overlay) ──

/** mode 随 loading→resolved 一次性落定,驱动 AuthPanel 在邮箱密码卡与企业账号卡间切换。 */
type AuthSnapshot = { currentUser: PlatformUserRow | null; loading: boolean; mode: AuthMode; loginError: string | null }

let authSnapshot: AuthSnapshot = { currentUser: null, loading: true, mode: 'supabase', loginError: null }
const authListeners = new Set<() => void>()
let authInitialized = false

// ── Guest store (匿名使用偏好,独立于认证快照) ──

/**
 * 匿名使用放行态:用户在登录页点过「匿名使用」且尚未登录。初始值读本地偏好,
 * 与认证快照分离——登录/退出/SSO 应用的清偏好路径各自动它的内存快照。
 */
let guestSnapshot = readAnonymousPreference()
const guestListeners = new Set<() => void>()

function subscribeGuest(fn: () => void): () => void {
  guestListeners.add(fn)
  return () => { guestListeners.delete(fn) }
}

function getGuestSnapshot(): boolean {
  return guestSnapshot
}

/** 置匿名放行(登录页「匿名使用」按钮):写本地偏好 + 通知订阅者。 */
function enterGuestMode(): void {
  writeAnonymousPreference()
  guestSnapshot = true
  guestListeners.forEach((fn) => { fn() })
}

/** 退出匿名放行(登录成功/显式登录/登出/SSO 应用/侧栏登录卡):清本地偏好 + 通知订阅者。 */
export function exitGuestMode(): void {
  clearAnonymousPreference()
  guestSnapshot = false
  guestListeners.forEach((fn) => { fn() })
}

/** 匿名放行态 hook:guest=true 且未登录时放行进入本机工作台。 */
export function useGuest(): boolean {
  return useSyncExternalStore(subscribeGuest, getGuestSnapshot, getGuestSnapshot)
}

function subscribeAuth(fn: () => void): () => void {
  authListeners.add(fn)
  return () => { authListeners.delete(fn) }
}

function getAuthSnapshot(): AuthSnapshot {
  return authSnapshot
}

function setAuthSnapshot(next: AuthSnapshot): void {
  authSnapshot = next
  authListeners.forEach((fn) => { fn() })
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const token = readToken()
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined ?? {}),
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(input, { ...init, headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function initAuth(): Promise<void> {
  if (authInitialized) return
  authInitialized = true
  let config: AuthWebConfig
  try {
    config = await fetchAuthConfig()
  } catch (e) {
    setAuthMode('supabase')
    setAuthSnapshot({ currentUser: null, loading: false, mode: 'supabase', loginError: e instanceof Error ? e.message : String(e) })
    return
  }
  setAuthMode(config.mode)
  setOidcIssuer(config.mode === 'oidc' ? config.issuer : '')
  // relay 中转基地址:仅 Pocket Access 手机端登录(非 loopback)使用,空串=未启用
  setOidcRelayUrl(config.mode === 'oidc' ? config.relayUrl : '')
  // OIDC 回调:认证中心 302 回 SPA 根路径 ?code=&state=,完成令牌交换后走下方统一 /me
  const callback = readOidcCallback()
  if (config.mode === 'oidc' && callback !== null) {
    try {
      await completeOidcCallback(callback)
    } catch (e) {
      setAuthSnapshot({ currentUser: null, loading: false, mode: config.mode, loginError: e instanceof Error ? e.message : String(e) })
      return
    }
  }
  const token = readToken()
  if (token === null) {
    setAuthSnapshot({ currentUser: null, loading: false, mode: config.mode, loginError: null })
    return
  }
  if (config.mode === 'supabase') {
    try {
      // 先等 supabase 恢复本地会话(getSession 内部等待初始化,access token 已过期
      // 时自动用 refresh token 续期并经 TOKEN_REFRESHED 写回 TOKEN_KEY),再调 /me
      const client = await getSupabaseClient()
      await client.auth.getSession()
    } catch {
      clearAuthSession()
      setAuthSnapshot({ currentUser: null, loading: false, mode: config.mode, loginError: null })
      return
    }
  }
  await refreshAuthUser()
  // /me 网络失败时 refreshAuthUser 保留快照(loading);initAuth 无自动续期兜底,
  // 回登录页避免卡在「检查登录状态」
  if (getAuthSnapshot().loading) {
    clearAuthSession()
    setAuthSnapshot({ currentUser: null, loading: false, mode: config.mode, loginError: null })
  }
}

export function useAuth() {
  const snapshot = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot)

  useEffect(() => { void initAuth() }, [])

  const login = useCallback(async (email: string, password: string) => {
    const client = await getSupabaseClient()
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error !== null) throw new Error(error.message)
    // oxlint-disable typescript/no-unnecessary-condition -- supabase is an external service; keep the runtime guard at the wire boundary
    const accessToken = data.session?.access_token
    if (accessToken === undefined) throw new Error('登录失败：未返回会话')
    // oxlint-enable typescript/no-unnecessary-condition -- restore the rule after the wire-boundary guard
    writeToken(accessToken)
    // 登录成功即升级为已登录:匿名放行作废(下次 token 过期回登录页而非匿名态)
    exitGuestMode()
    const user = await fetchJson<PlatformUserRow>('/api/enterprise/auth/me')
    setAuthSnapshot({ currentUser: user, loading: false, mode: 'supabase', loginError: null })
  }, [])

  const register = useCallback(async (email: string, password: string, loginName: string, displayName: string) => {
    const client = await getSupabaseClient()
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { login_name: loginName, display_name: displayName } },
    })
    if (error !== null) throw new Error(error.message)
    // If session is returned (email confirmation disabled), auto-login
    if (data.session?.access_token !== undefined) {
      writeToken(data.session.access_token)
      // 注册即自动登录:与 login 同口径清匿名放行
      exitGuestMode()
      const user = await fetchJson<PlatformUserRow>('/api/enterprise/auth/me')
      setAuthSnapshot({ currentUser: user, loading: false, mode: 'supabase', loginError: null })
    } else {
      // No session - show login prompt
      throw new Error('注册成功，请使用新账号登录')
    }
  }, [])

  const logout = useCallback(async () => {
    // 先带旧 token 通知本地 webserver 失效身份缓存(此时尚未清 TOKEN_KEY),
    // 再清本地与 supabase 会话;SIGNED_OUT 监听里的清理是幂等的
    const token = readToken()
    try {
      await fetch('api/enterprise/auth/signout', {
        method: 'POST',
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      })
    } catch { /* 缓存自愈：下一次 /me 会重建身份 */ }
    // 退出登录回登录页而非匿名态:匿名放行一并清,登录页保持可达
    exitGuestMode()
    clearAuthSession()
    setAuthSnapshot({ currentUser: null, loading: false, mode: getAuthMode(), loginError: null })
    // OIDC 模式留在 DSH 登录页,不整页跳认证中心;认证中心会话仍留在浏览器,
    // 但下次登录的 iframe 流带 prompt=login 强制重新认证,不会被静默重登同一账号
    if (getAuthMode() === 'oidc') return
    try {
      const client = await getSupabaseClient()
      await client.auth.signOut()
    } catch { /* ignore signout errors */ }
  }, [])

  return { ...snapshot, login, register, logout }
}

// ── Auth panel (login / register card) ──

/** 邮箱输入的行首图标。 */
const MailIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
    <path d="m3.5 6 5.8 4.4a2 2 0 0 0 2.4 0L17.5 6" />
  </svg>
)

/** 密码输入的行首图标。 */
const LockIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <rect x="4.5" y="8.5" width="11" height="8" rx="2" />
    <path d="M7 8.5V6.8a3 3 0 0 1 6 0v1.7" />
  </svg>
)

/** 用户名输入的行首图标。 */
const UserIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <circle cx="10" cy="6.5" r="2.8" />
    <path d="M4.5 16.5c.9-2.6 3-4 5.5-4s4.6 1.4 5.5 4" />
  </svg>
)

/** 密码可见性切换按钮的图标。 */
const EyeIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    {off
      ? <path d="M3.5 10s2.7-4.5 6.5-4.5c1 0 1.9.2 2.7.6M16.5 10s-.5.9-1.4 1.8c-1.3 1.4-2.8 2.2-4.6 2.2-1 0-1.9-.2-2.7-.6M3 3l14 14" />
      : <path d="M2.5 10S5.2 5.5 10 5.5 17.5 10 17.5 10 14.8 14.5 10 14.5 2.5 10 2.5 10Z" />}
    {!off && <circle cx="10" cy="10" r="2.2" />}
  </svg>
)

/** 错误提示的图标。 */
const AlertIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <circle cx="10" cy="10" r="7.2" />
    <path d="M10 6.5v4.2" strokeLinecap="round" />
    <circle cx="10" cy="13.4" r="0.9" fill="currentColor" stroke="none" />
  </svg>
)

/** hero 功能要点勾选图标。 */
const CheckIcon = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="m4 10.5 4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 带行首图标与可选行尾动作的输入框行。 */
function Field({
  icon, type = 'text', placeholder, value, onChange, trailing, autoComplete, autoFocus,
}: {
  icon: ReactNode
  type?: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  trailing?: ReactNode
  autoComplete?: string
  autoFocus?: boolean
}) {
  return (
    <div className={css.field}>
      <span className={css.fieldIcon}>{icon}</span>
      <input
        className={css.fieldInput}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value) }}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
      />
      {trailing !== undefined && <span className={css.fieldTrailing}>{trailing}</span>}
    </div>
  )
}

/** 认证中心登录卡:展示 loginError,一个大按钮打开内嵌认证中心的登录弹层。 */
function OidcLoginPanel({
  loginError,
  onOidcLogin,
}: {
  loginError: string | null
  onOidcLogin: () => void | Promise<void>
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className={css.authForm}>
      {(loginError ?? error) !== null && (
        <div className={css.authError} role="alert">
          <AlertIcon />
          <span>{loginError ?? error}</span>
        </div>
      )}
      <button
        type="button"
        className={css.authSubmitButton}
        disabled={loading}
        onClick={() => {
          setLoading(true)
          setError(null)
          // openOidcFrame 同步返回且失败已落到 loginError;Promise.resolve 兼容
          // 异步包装调用,完成后复位 loading(弹层已打开或错误已展示)
          void Promise.resolve(onOidcLogin()).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : String(e))
          }).finally(() => { setLoading(false) })
        }}
      >
        {loading && <span className={css.spinner} aria-hidden />}
        {loading ? '正在打开登录窗口…' : '使用企业账号登录'}
      </button>
      <div className={css.hint}>账号由企业认证中心统一管理，无需在本页注册。</div>
    </div>
  )
}

/** 登录卡路由:按认证模式渲染企业账号跳转卡或邮箱密码表单(无自身状态)。 */
function AuthPanel({
  mode,
  loginError,
  onLogin,
  onRegister,
  onOidcLogin,
}: {
  mode: AuthMode
  loginError: string | null
  onLogin: (email: string, password: string) => Promise<void>
  onRegister: (email: string, password: string, loginName: string, displayName: string) => Promise<void>
  onOidcLogin: () => void | Promise<void>
}) {
  if (mode === 'oidc') {
    return <OidcLoginPanel loginError={loginError} onOidcLogin={onOidcLogin} />
  }
  return <PasswordAuthPanel onLogin={onLogin} onRegister={onRegister} />
}

function PasswordAuthPanel({
  onLogin,
  onRegister,
}: {
  onLogin: (email: string, password: string) => Promise<void>
  onRegister: (email: string, password: string, loginName: string, displayName: string) => Promise<void>
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loginName, setLoginName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const registerBlocked = loginName.trim() === '' || displayName.trim() === '' || email.trim() === '' || password.trim() === '' || confirmPassword.trim() === ''
  const loginBlocked = email.trim() === '' || password.trim() === ''

  const submit = useCallback(async () => {
    if (mode === 'login' && loginBlocked) return
    if (mode === 'register' && registerBlocked) {
      setError('登录名、显示名、邮箱、密码和确认密码都必须填写')
      return
    }
    if (mode === 'register' && password.length < 6) {
      setError('密码至少 6 位')
      return
    }
    if (mode === 'register' && password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    setLoading(true)
    setError(null)
    try {
      if (mode === 'login') {
        await onLogin(email, password)
      } else {
        await onRegister(email, password, loginName, displayName)
        setConfirmPassword('')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode, email, password, confirmPassword, loginName, displayName, onLogin, onRegister, loginBlocked, registerBlocked])

  const passwordToggle = (
    <button
      type="button"
      className={css.eyeButton}
      onClick={() => { setShowPassword(v => !v) }}
      aria-label={showPassword ? '隐藏密码' : '显示密码'}
    >
      <EyeIcon off={!showPassword} />
    </button>
  )
  const confirmToggle = (
    <button
      type="button"
      className={css.eyeButton}
      onClick={() => { setShowConfirm(v => !v) }}
      aria-label={showConfirm ? '隐藏密码' : '显示密码'}
    >
      <EyeIcon off={!showConfirm} />
    </button>
  )

  return (
    <div className={css.authPanel}>
      <div className={css.authTabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'login'}
          className={clsx(css.authTab, mode === 'login' && css.authTabActive)}
          onClick={() => { setMode('login'); setError(null) }}
        >
          登录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'register'}
          className={clsx(css.authTab, mode === 'register' && css.authTabActive)}
          onClick={() => { setMode('register'); setError(null) }}
        >
          注册
        </button>
      </div>
      <form
        className={css.authForm}
        onSubmit={(e) => { e.preventDefault(); void submit() }}
      >
        {mode === 'register' && (
          <>
            <Field icon={<UserIcon />} placeholder="登录名" value={loginName} onChange={setLoginName} autoComplete="username" />
            <Field icon={<UserIcon />} placeholder="显示名" value={displayName} onChange={setDisplayName} />
          </>
        )}
        <Field icon={<MailIcon />} type="email" placeholder="邮箱" value={email} onChange={setEmail} autoComplete="email" autoFocus />
        <Field
          icon={<LockIcon />}
          type={showPassword ? 'text' : 'password'}
          placeholder="密码"
          value={password}
          onChange={setPassword}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          trailing={passwordToggle}
        />
        {mode === 'register' && (
          <Field
            icon={<LockIcon />}
            type={showConfirm ? 'text' : 'password'}
            placeholder="确认密码"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            trailing={confirmToggle}
          />
        )}
        {error !== null && (
          <div className={css.authError} role="alert">
            <AlertIcon />
            <span>{error}</span>
          </div>
        )}
        <button
          type="submit"
          className={css.authSubmitButton}
          disabled={loading || (mode === 'login' ? loginBlocked : registerBlocked)}
        >
          {loading && <span className={css.spinner} aria-hidden />}
          {loading ? '请稍候…' : (mode === 'login' ? '登 录' : '注 册')}
        </button>
      </form>
      {mode === 'register' && <div className={css.hint}>注册后需要管理员审批才能进入平台</div>}
    </div>
  )
}

// ── Service config sheet (登录页常驻逃生门) ──

/** 齿轮图标(服务配置入口)。 */
const GearIcon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <circle cx="10" cy="10" r="2.6" />
    <path d="M10 2.8v2.1M10 15.1v2.1M17.2 10h-2.1M4.9 10H2.8M15.2 4.8l-1.5 1.5M6.3 13.7l-1.5 1.5M15.2 15.2l-1.5-1.5M6.3 6.3 4.8 4.8" strokeLinecap="round" />
  </svg>
)

/** 关闭图标。 */
const CloseIcon = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
  </svg>
)

/**
 * 登录页「服务配置」弹层:认证/引擎/console/SkillHub 配错的软件内逃生门。
 * 与设置面板共用同一套 EnterpriseServicesSection(连通性测试 + 软阻止 +
 * 镜像写入),读写走注入的企业服务配置读写面,不依赖登录态。
 */
function ServiceConfigSheet({
  services,
  onClose,
}: {
  services: EnterpriseServicesInjected
  onClose: () => void
}) {
  // 挂载动画:首次渲染后置 mounted 触发淡入上浮
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => { setMounted(true) })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className={clsx(css.configSheetRoot, mounted && css.configSheetRootMounted)}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      role="presentation"
    >
      <div className={css.configSheet} role="dialog" aria-modal="true" aria-label="企业服务配置">
        <div className={css.configSheetHeader}>
          <div>
            <div className={css.configSheetTitle}>服务配置</div>
            <div className={css.configSheetSubtitle}>
              连不上服务器时在这里修正地址;保存即生效,无需重启。
            </div>
          </div>
          <button type="button" className={css.configSheetClose} onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className={css.configSheetBody}>
          <EnterpriseServicesSection load={services.load} save={services.save} saveSso={services.saveSso} />
        </div>
      </div>
    </div>
  )
}

// ── Overlay (right panel) ──

export function EnterpriseOverlay({ services }: { services?: EnterpriseServicesInjected }) {
  const { currentUser, loading, mode, loginError, login, register, logout } = useAuth()
  const [configOpen, setConfigOpen] = useState(false)
  /** 非 null 时弹 Modal 内嵌认证中心登录页(iframe),null 收起。 */
  const [oidcFrameUrl, setOidcFrameUrl] = useState<string | null>(null)
  /** iframe 引用:load 后读其地址提取授权码,兜住认证中心不发 postMessage 的第三方扫码路径。 */
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const openOidcFrame = useCallback(() => {
    void (async () => {
      try {
        // iframe 内嵌登录:授权 URL 带 popup=iframe,认证中心登录成功不 302 而是向本页 postMessage。
        // 恒带 prompt=login:认证中心会话仍可能在(退出只清了 DSH 侧),强制重新认证
        // 防静默重登同一账号,也兜住"切换账号"场景;首次登录无认证中心会话,无影响
        setOidcFrameUrl(await buildOidcAuthorizeUrl({ promptLogin: true, popupIframe: true }))
      } catch (e) {
        setAuthSnapshot({ currentUser: null, loading: false, mode: getAuthMode(), loginError: e instanceof Error ? e.message : String(e) })
      }
    })()
  }, [])

  /** 拿到授权码后的公共续程:state 校验、令牌交换、重拉 /me 推进认证状态;postMessage 与 iframe load 两条路径共用。 */
  const handleOidcCode = useCallback((callback: { code: string; state: string }) => {
    void (async () => {
      try {
        await completeOidcCallback(callback)
        // OIDC 登录成功:与 supabase login 同口径清匿名放行
        exitGuestMode()
        await refreshAuthUser()
        // /me 网络失败时 refreshAuthUser 保留 loading 快照,与 initAuth 一致兜底回登录页
        if (getAuthSnapshot().loading) {
          clearAuthSession()
          setAuthSnapshot({ currentUser: null, loading: false, mode: getAuthMode(), loginError: null })
        }
        // 收起 Modal:active 用户的登录页随之整体卸载,显式置 null 不影响结果;
        // pending/blocked 用户登录页不卸载,必须显式收起 iframe,否则卡在"登录成功"页
        setOidcFrameUrl(null)
      } catch (e) {
        setAuthSnapshot({ currentUser: null, loading: false, mode: getAuthMode(), loginError: e instanceof Error ? e.message : String(e) })
        setOidcFrameUrl(null)
      }
    })()
  }, [])

  useEffect(() => {
    if (oidcFrameUrl === null) return
    const onMessage = (event: MessageEvent) => {
      const callback = readOidcLoginSuccessMessage(event, getOidcIssuer())
      if (callback !== null) handleOidcCode(callback)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [oidcFrameUrl, handleOidcCode])

  /**
   * iframe load 兜底:账号密码路径认证中心会 postMessage(走上面的 onMessage),但钉钉等
   * 第三方 Provider 扫码路径拿到 code 后直接把 iframe 导航到 redirect_uri、不发消息。
   * 导航回本站后与父页面同源,这里读其地址提取 code/state;仍停在认证中心(跨源)或
   * 加载失败页时读取抛 SecurityError,静默等下一跳。load 派发早于 iframe 内 SPA 的
   * initAuth 网络往返,sessionStorage 一次性凭据由本页先取先删。
   */
  const onFrameLoad = useCallback(() => {
    const frame = frameRef.current
    if (frame === null) return
    let href: string
    try {
      href = frame.contentWindow?.location.href ?? ''
    } catch {
      return
    }
    const params = new URLSearchParams(new URL(href, window.location.origin).search)
    const code = params.get('code')
    const state = params.get('state')
    if (code !== null && state !== null) handleOidcCode({ code, state })
  }, [handleOidcCode])

  const guest = useGuest()
  const authState = useMemo<'loading' | 'guest' | 'anonymous' | 'pending' | 'blocked' | 'active'>(() => {
    if (loading) return 'loading'
    if (currentUser === null) return guest ? 'guest' : 'anonymous'
    if (currentUser.status === 'pending_approval') return 'pending'
    if (currentUser.status === 'disabled' || currentUser.status === 'locked') return 'blocked'
    return 'active'
  }, [currentUser, loading, guest])

  if (authState === 'active') return null

  // 匿名放行:整帧进入本机工作台(web profile 用法,模型在设置页自行配置),
  // 不渲染任何遮罩;登录引导卡在侧栏底部(GuestSidebarCard 占据
  // sidebar.footer.action 座位),不占用主帧区域
  if (authState === 'guest') return null

  return (
    <div className={css.authPageRoot}>
      {services !== undefined && (
        <button
          type="button"
          className={css.configGear}
          onClick={() => { setConfigOpen(true) }}
          aria-label="服务配置"
          title="服务配置"
        >
          <GearIcon />
          <span>服务配置</span>
        </button>
      )}
      <div className={css.authPageShell}>
        <div className={css.authHero}>
          <div className={css.authBadge}>Enterprise Profile</div>
          <div className={css.authBrand}>
            <BrandWordmark />
          </div>
          <div className={css.authPageTitle}>云汉企业AI工作台</div>
          <div className={css.authPageSubtitle}>
            基于DeepSeek Harness 企业AI工作台。
          </div>
          <ul className={css.authFeatures}>
            <li><CheckIcon />待办任务一站式处理</li>
            <li><CheckIcon />AI 会话辅助完成任务</li>
            <li><CheckIcon />流程进度与变量全程可视</li>
          </ul>
        </div>
        <div className={css.authPageCard}>
          <div className={css.authPageHeader}>
            <div className={css.authCardTitle}>
              {authState === 'loading' && '检查登录状态'}
              {authState === 'anonymous' && (mode === 'oidc' ? '企业账号登录' : '登录或注册')}
              {authState === 'pending' && '等待审批'}
              {authState === 'blocked' && '账号不可用'}
            </div>
            <div className={css.authCardSubtitle}>
              {authState === 'loading' && '正在确认你的企业身份信息...'}
              {authState === 'anonymous' && (mode === 'oidc' ? '通过企业认证中心验证身份后进入工作台。' : '使用企业账号进入当前工作台。')}
              {authState === 'pending' && '你的账号已注册成功，等待系统管理员审批后才能进入平台。'}
              {authState === 'blocked' && `当前账号已${currentUser?.status === 'disabled' ? '禁用' : '锁定'}，请联系管理员处理。`}
            </div>
          </div>
          {authState === 'anonymous' && (
            <>
              <AuthPanel
                mode={mode}
                loginError={loginError}
                onLogin={login}
                onRegister={register}
                onOidcLogin={openOidcFrame}
              />
              <div className={css.anonymousEntry}>
                <button
                  type="button"
                  className={css.authSecondaryButton}
                  onClick={() => { enterGuestMode() }}
                >
                  匿名使用
                </button>
                <div className={css.hint}>
                  不登录直接使用本机工作台，模型在设置中自行配置；待办、企业模型登录后可用。
                </div>
              </div>
            </>
          )}
          {(authState === 'pending' || authState === 'blocked') && (
            <div className={css.authBlockedActions}>
              <button
                type="button"
                className={css.authSecondaryButton}
                onClick={() => { void logout() }}
              >
                切换账号
              </button>
              <div className={css.hint}>
                点击后会退出当前账号，返回登录页，以便使用其他账号登录。
              </div>
            </div>
          )}
        </div>
      </div>
      {configOpen && services !== undefined && (
        <ServiceConfigSheet services={services} onClose={() => { setConfigOpen(false) }} />
      )}
      {oidcFrameUrl !== null && (
        <div
          className={clsx(css.configSheetRoot, css.configSheetRootMounted)}
          onClick={(event) => { if (event.target === event.currentTarget) setOidcFrameUrl(null) }}
          role="presentation"
        >
          <div className={css.configSheet} role="dialog" aria-modal="true" aria-label="企业账号登录">
            <div className={css.configSheetHeader}>
              <div className={css.configSheetTitle}>企业账号登录</div>
              <button
                type="button"
                className={css.configSheetClose}
                onClick={() => { setOidcFrameUrl(null) }}
                aria-label="关闭"
              >
                <CloseIcon />
              </button>
            </div>
            <iframe
              ref={frameRef}
              className={css.oidcFrame}
              src={oidcFrameUrl}
              title="企业认证中心登录"
              onLoad={onFrameLoad}
            />
          </div>
        </div>
      )}
    </div>
  )
}
