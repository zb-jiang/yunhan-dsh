/**
 * 匿名使用引导卡:sidebar.footer.action 座位的匿名态占据者。
 *
 * <p>匿名放行(guest)时在侧栏底部(设置项上方)渲染登录引导——宽态是标题 +
 * 说明 + 通宽「登录企业账号」主按钮的紧凑卡,窄轨(56px)收缩为单图标按钮;
 * 点击退出匿名态回登录页。登录后(用户栏由 TaskQueueSidebar 的 footer 渲染)
 * 与未开启匿名偏好(登录墙盖帧)时返回 null。
 */
import { IconUserOutlineMedium, IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { exitGuestMode, useAuth, useGuest } from './EnterpriseUi.tsx'
import css from './EnterpriseUi.module.css'

/** footer.action 座位占据者 props:只需列显示状态。 */
export type GuestSidebarCardProps = PropsRuntime<'sidebar.footer.action'>

/** 匿名态侧栏登录引导卡(见模块文档)。 */
export function GuestSidebarCard({ wide }: GuestSidebarCardProps) {
  const { currentUser } = useAuth()
  const guest = useGuest()
  if (currentUser !== null || !guest) return null
  if (!wide) {
    return (
      <button
        type="button"
        className={css.guestRailButton}
        title="登录企业账号"
        aria-label="登录企业账号"
        onClick={() => { exitGuestMode() }}
      >
        <IconUserOutlineMedium size={18} />
      </button>
    )
  }
  return (
    <div className={css.guestCard}>
      <div className={css.guestCardTitle}>
        <span className={css.guestCardGlyph} aria-hidden="true">
          <IconUserOutlineRegular size={14} />
        </span>
        <span>匿名使用中</span>
      </div>
      <p className={css.guestCardHint}>会话与模型配置保存在本机，登录后可用待办等企业功能。</p>
      <button type="button" className={css.guestCardButton} onClick={() => { exitGuestMode() }}>
        登录企业账号
      </button>
    </div>
  )
}
