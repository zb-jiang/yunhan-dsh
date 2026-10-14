import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  clearAuthSession,
  completeOidcCallback,
  fetchAuthConfig,
  readOidcCallback,
  readToken,
  setAuthMode,
  setOidcIssuer,
  startOidcAuthorize,
  writeToken,
  type AuthMode,
} from './auth-session'
import { getSupabaseClient } from '../lib/supabase'
import { get } from '../api/client'
import type { AuthContext as MeDto } from '../api/types'

interface Me extends MeDto {
  status?: string
  platformRoles?: string[]
}

function normalizeMe(value: unknown): Me | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const platformRoles = Array.isArray(raw.platformRoles)
    ? raw.platformRoles.map(r => String(r))
    : []
  return {
    platformUserId: String(raw.platformUserId ?? raw.id ?? ''),
    authSubject: String(raw.authSubject ?? ''),
    email: String(raw.email ?? ''),
    loginName: String(raw.loginName ?? ''),
    displayName: String(raw.displayName ?? ''),
    roles: platformRoles,
    status: raw.status === undefined ? undefined : String(raw.status),
    platformRoles,
  }
}

interface AuthState {
  me: Me | null
  /** 部署级认证模式:supabase 直连邮箱密码 / oidc 认证中心授权码+PKCE。 */
  mode: AuthMode
  loading: boolean
  authenticated: boolean
  /** OIDC 回调失败信息(认证中心错误、state 校验失败、令牌交换失败),登录页展示。 */
  loginError: string | null
  signIn: (email: string, password: string) => Promise<void>
  loginWithOidc: (options?: { promptLogin?: boolean }) => Promise<void>
  /**
   * iframe 内嵌登录的授权码续程:交换 token 后把 authenticated/me 状态推进到位
   * (父页面是既有会话,initAuth 已跑过,不会自己消费这个 code)。
   */
  completeOidcLogin: (callback: { code: string; state: string }) => Promise<void>
  signOut: () => Promise<void>
  refreshMe: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

/**
 * 认证上下文:按部署级认证模式初始化会话。
 *
 * <p>OIDC 模式:授权码回环落在 SPA 根路径(?code=&state=),由 initAuth 消费并
 * 交换 token;token 续期由 axios 拦截器在 401 时用 refresh_token 重放,登出只清
 * 本地会话回登录页(管理后台不做 SSO 静默重登)。
 *
 * <p>supabase 模式:supabase-js 自管会话持久化与自动续期,onAuthStateChange 把
 * 新 access_token 同步进本地会话层(axios 拦截器统一 readToken)。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AuthMode>('supabase')
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  const refreshMe = async () => {
    try {
      const result = await get<unknown>('/api/users/me')
      setMe(normalizeMe(result))
    } catch (e) {
      // 401 已由 axios 拦截器处理(oidc 刷新重放或清会话);token 被清则落未认证态
      // biome-ignore lint/suspicious/noConsole: 启动期诊断
      console.warn('[auth] fetch me failed', e)
      setMe(null)
      setAuthenticated(readToken() !== null)
    }
  }

  useEffect(() => {
    let mounted = true
    let unsubscribe: (() => void) | null = null

    const initAuth = async () => {
      try {
        const config = await fetchAuthConfig()
        if (!mounted) return
        setAuthMode(config.mode)
        setMode(config.mode)

        if (config.mode === 'oidc') {
          setOidcIssuer(config.issuer)
          const callback = readOidcCallback()
          if (callback !== null) {
            try {
              await completeOidcCallback(callback)
            } catch (e) {
              if (!mounted) return
              setLoginError(e instanceof Error ? e.message : String(e))
            }
          }
          if (mounted && readToken() !== null) {
            setAuthenticated(true)
            await refreshMe()
          }
          return
        }

        // supabase 模式:恢复持久化会话,并把 access_token 同步进本地会话层
        const client = await getSupabaseClient()
        if (!mounted) return
        const { data } = await client.auth.getSession()
        if (!mounted) return
        if (data.session) {
          writeToken(data.session.access_token)
          setAuthenticated(true)
          await refreshMe()
        }
        // 登录/注册(SIGNED_IN)与 token 刷新(TOKEN_REFRESHED)都同步进本地会话层;
        // 登出(含 401 后的兜底 signOut)清本地会话
        const { data: sub } = client.auth.onAuthStateChange((event, newSession) => {
          if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && newSession) {
            writeToken(newSession.access_token)
            setAuthenticated(true)
            void refreshMe()
          } else if (event === 'SIGNED_OUT') {
            clearAuthSession()
            setAuthenticated(false)
            setMe(null)
          }
        })
        unsubscribe = () => {
          sub.subscription.unsubscribe()
        }
      } catch (e) {
        // config 拉取失败(后端未启动等):保持未认证,错误留在登录页可见范围外
        // biome-ignore lint/suspicious/noConsole: 启动期诊断
        console.warn('[auth] init failed', e)
        setLoginError(e instanceof Error ? e.message : String(e))
      } finally {
        if (mounted) setLoading(false)
      }
    }

    void initAuth()
    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [])

  const signIn = async (email: string, password: string) => {
    const client = await getSupabaseClient()
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw error
    if (data.session) writeToken(data.session.access_token)
    setAuthenticated(true)
    await refreshMe()
  }

  const loginWithOidc = async (options?: { promptLogin?: boolean }) => {
    await startOidcAuthorize({ promptLogin: options?.promptLogin === true })
  }

  const completeOidcLogin = async (callback: { code: string; state: string }) => {
    await completeOidcCallback(callback)
    if (readToken() !== null) {
      setAuthenticated(true)
      await refreshMe()
    }
  }

  const signOut = async () => {
    if (mode === 'oidc') {
      // 管理后台登出即回登录页,不自动重跳认证中心(prompt=login 只用于显式换账号)
      clearAuthSession()
      setAuthenticated(false)
      setMe(null)
      return
    }
    const client = await getSupabaseClient()
    await client.auth.signOut() // SIGNED_OUT 事件回调会清本地会话
    setAuthenticated(false)
    setMe(null)
  }

  return (
    <AuthContext.Provider
      value={{ me, mode, loading, authenticated, loginError, signIn, loginWithOidc, completeOidcLogin, signOut, refreshMe }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
