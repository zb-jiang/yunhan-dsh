/**
 * 登录用户栏:sidebar.footer.action 座位的登录态占据者。
 *
 * <p>登录用户在侧栏底部(设置项上方)显示账户卡:内嵌圆角卡片承载首字头像
 * 圆片 + 姓名一行 + 「退出」按钮(静态即有完整按钮形,hover 转错误色调)。
 * 副行不带邮箱:casdoor/钉钉等 OIDC 登录不下发 email claim
 * (platform_users.email 存 NULL),姓名经 JIT 取值链兜底在所有 SSO 模式
 * (supabase/casdoor/customer-oidc)下都有值;匿名放行态由 GuestSidebarCard
 * 占据同一座位渲染登录引导,未登录(登录墙盖帧)或登录检查中返回 null。
 * 窄轨(56px 折叠态)不渲染——与原待办队列窄轨行为一致,退出操作随侧栏
 * 展开后的宽态可用。
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useAuth } from './EnterpriseUi.tsx'
import css from './UserFooterCard.module.css'

/** footer.action 座位占据者 props:只需列显示状态。 */
export type UserFooterCardProps = PropsRuntime<'sidebar.footer.action'>

/** 登录用户侧栏底栏(内嵌账户卡:头像 + 姓名 + 退出)——见模块文档。 */
export function UserFooterCard({ wide }: UserFooterCardProps) {
  const { currentUser, logout } = useAuth()
  if (currentUser === null || !wide) return null
  const initial = (currentUser.displayName || currentUser.loginName || '?').slice(0, 1)
  return (
    <div className={css.footer}>
      <div className={css.card}>
        <span className={css.avatar} aria-hidden>{initial}</span>
        <span className={css.name} title={currentUser.displayName}>{currentUser.displayName}</span>
        <button type="button" className={css.logout} title="退出登录" onClick={() => { void logout() }}>
          退出
        </button>
      </div>
    </div>
  )
}
