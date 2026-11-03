/**
 * 个人工作台引导卡:sidebar.footer.action 座位的个人模式占据者。
 *
 * <p>个人工作台放行(guest)时在侧栏底部(设置项上方)渲染升级引导——宽态是标题 +
 * 说明 + 通宽「切换到企业工作台」主按钮的紧凑卡,窄轨(56px)收缩为单图标按钮;
 * 点击退出个人模式回模式选择页。登录后(用户栏由 TaskQueueSidebar 的 footer 渲染)
 * 与未开启个人偏好(登录墙盖帧)时返回 null。
 */
import { IconUserOutlineMedium, IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { exitGuestMode, useAuth, useGuest } from './EnterpriseUi.tsx'
import css from './EnterpriseUi.module.css'

/** footer.action 座位占据者 props:只需列显示状态。 */
export type GuestSidebarCardProps = PropsRuntime<'sidebar.footer.action'>

/** 个人模式侧栏升级引导卡(见模块文档)。 */
export function GuestSidebarCard({ wide }: GuestSidebarCardProps) {
  const { currentUser } = useAuth()
  const guest = useGuest()
  if (currentUser !== null || !guest) return null
  if (!wide) {
    return (
      <button
        type="button"
        className={css.guestRailButton}
        title="切换到企业工作台"
        aria-label="切换到企业工作台"
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
        <span>个人模式</span>
      </div>
      <p className={css.guestCardHint}>会话与模型配置保存在本机，登录企业账号可升级到企业工作台。</p>
      <button type="button" className={css.guestCardButton} onClick={() => { exitGuestMode() }}>
        切换到企业工作台
      </button>
    </div>
  )
}
