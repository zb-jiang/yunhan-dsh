import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { PLATFORM_ROLE } from '../api/types'

/**
 * 路由守卫:未登录 → /login;pending_approval/disabled/locked → /pending;
 * 已 active 用户按角色放行:
 * - normal_user 只能访问首页(/)、部门管理、流程实例与 LLM 用量分析;访问其他路径会重定向到 /
 * - app_admin / system_admin 放行
 *
 * <p>pending/disabled/locked 用户跳 /pending 由 PendingGate 渲染对应提示,
 * 不进入后台菜单(避免无权限调用任何业务 API)。
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated, me, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return null // 或全屏 spinner
  }
  if (!authenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  if (!me) {
    // 已登录但 platform_users 表无记录(trigger 未触发或被删)
    return <Navigate to="/pending" replace />
  }
  if (me.status !== 'active') {
    return <Navigate to="/pending" replace />
  }

  const roles = me.roles ?? []
  const isAdmin = roles.includes(PLATFORM_ROLE.SYSTEM_ADMIN) || roles.includes(PLATFORM_ROLE.APP_ADMIN)
  // normal_user 可访问首页、流程实例(仅自己发起的,后端按 JWT sub 过滤)、部门管理(只读)
  // 与 LLM 用量分析(非管理员由后端强制收敛到本人数据)
  const readOnlyAllowed =
    location.pathname === '/org-units' || location.pathname.startsWith('/instances')
    || location.pathname === '/llm/usage'
  if (!isAdmin && location.pathname !== '/' && !readOnlyAllowed) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}

/**
 * pending 状态守卫:已 active 用户访问 /pending 自动跳回 /。
 */
export function PendingGate({ children }: { children: ReactNode }) {
  const { authenticated, me, loading } = useAuth()
  if (loading) return null
  if (!authenticated) return <Navigate to="/login" replace />
  if (me && me.status === 'active') {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}
