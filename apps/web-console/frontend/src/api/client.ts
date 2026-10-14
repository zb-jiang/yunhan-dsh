import axios, { type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { clearAuthSession, getAuthMode, readToken, tryOidcRefresh } from '../auth/auth-session'
import { getSupabaseClient } from '../lib/supabase'
import type { ApiError, ApiResponse } from './types'

const baseURL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

/**
 * Web Console 后端 axios 客户端。
 *
 * <p>request 拦截器:从本地会话读 access_token 加 Authorization: Bearer
 * (supabase 模式由 AuthContext 的 onAuthStateChange 同步写入,OIDC 模式由
 * 授权码回调/refresh 写入)。
 * <p>response 拦截器:解包 ApiResponse(success → data;fail → 抛 Error 含 code/message)。
 *
 * V1 dev 时 baseURL 为空,通过 Vite proxy /api → http://localhost:8080;
 * 生产环境 VITE_API_BASE_URL 填后端实际地址。
 */
export const http = axios.create({
  baseURL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
})

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = readToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

http.interceptors.response.use(
  (resp: AxiosResponse<ApiResponse<unknown>>) => {
    const body = resp.data
    if (body && typeof body === 'object' && 'success' in body) {
      if (body.success) {
        // 把 ApiResponse<T> 解包成裸 T 直接返回,调用方拿到的就是 data 字段
        return body.data as unknown as AxiosResponse
      }
      const err: ApiError | null = body.error
      const e = new Error(err?.message ?? '请求失败')
      ;(e as Error & { code?: string; details?: string[] }).code = err?.code
      ;(e as Error & { details?: string[] }).details = err?.details
      return Promise.reject(e)
    }
    // 非标准 ApiResponse(如 Flowable 透传响应)直接返回
    return resp as unknown as AxiosResponse
  },
  async (err: AxiosError<ApiResponse<unknown>>) => {
    if (err.response?.status === 401) {
      // 标记重放过的请求,防止 refresh 后仍 401 造成的死循环
      const config = err.config as (InternalAxiosRequestConfig & { __retried401?: boolean }) | undefined
      const oidc = getAuthMode() === 'oidc'
      if (oidc && config && config.__retried401 !== true) {
        const refreshed = await tryOidcRefresh()
        if (refreshed) {
          config.__retried401 = true
          // request 拦截器会用新 token 覆盖 Authorization
          return http.request(config)
        }
      }
      // 会话失效,清本地并跳登录。跳转放在调用方处理,这里只 reject
      clearAuthSession()
      if (!oidc) {
        void getSupabaseClient()
          .then(client => client.auth.signOut())
          .catch(() => {
            // Supabase 客户端未就绪(如 config 拉取失败)时忽略,本地会话已清
          })
      }
    }
    const body = err.response?.data
    if (body && typeof body === 'object' && 'success' in body && !body.success) {
      const apiErr: ApiError | null = body.error
      const e = new Error(apiErr?.message ?? err.message)
      ;(e as Error & { code?: string; details?: string[] }).code = apiErr?.code
      ;(e as Error & { details?: string[] }).details = apiErr?.details
      ;(e as Error & { status?: number }).status = err.response?.status
      return Promise.reject(e)
    }
    ;(err as Error & { status?: number }).status = err.response?.status
    return Promise.reject(err)
  },
)

/**
 * 类型化 GET 包装:成功时直接返回 data 字段(T)。
 */
export async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const resp = await http.get<ApiResponse<T>>(url, { params })
  return resp as unknown as T
}

/**
 * 类型化 POST 包装。
 */
export async function post<T>(url: string, body?: unknown): Promise<T> {
  const resp = await http.post<ApiResponse<T>>(url, body)
  return resp as unknown as T
}

/**
 * 类型化 PATCH 包装。
 */
export async function patch<T>(url: string, body?: unknown): Promise<T> {
  const resp = await http.patch<ApiResponse<T>>(url, body)
  return resp as unknown as T
}

/**
 * 类型化 DELETE 包装(后端 delete 返回 ApiResponse<T>)。
 */
export async function del<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const resp = await http.delete<ApiResponse<T>>(url, { params })
  return resp as unknown as T
}
