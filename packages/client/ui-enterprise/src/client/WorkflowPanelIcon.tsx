/**
 * 工作流侧栏入口图标:sidebar.panellist 座位的工作流面板图标。
 *
 * <p>侧栏拥有按钮、标签与选中态,本组件只出图标(企业偏离:官方
 * panellist 图标均为纯图标,待办数徽标为 ui-enterprise 扩展)——右上角
 * 叠待办计数徽标,无待办不渲染,>99 显示"99+";计数经注入的 workbench
 * 从待办队列快照读取。徽标不承载交互(点击整行按钮即打开工作流面板)。
 */
import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import { useSnapshot } from './workbench/hooks.ts'
import css from './WorkflowPanelIcon.module.css'

/** panellist 座位注入面:工作台编排器(待办计数来源)。 */
export type WorkflowPanelIconInjected = {
  workbench: EnterpriseWorkbench
}

/** panellist 图标 props:侧栏图标面(尺寸/选中态)+ 注入面。 */
export type WorkflowPanelIconProps =
  & PropsRuntime<'sidebar.panellist'>
  & WorkflowPanelIconInjected

/** 工作流入口图标 + 待办数徽标(见模块文档)。 */
export function WorkflowPanelIcon({ size, workbench }: WorkflowPanelIconProps): ReactNode {
  const tasks = useSnapshot(workbench.tasks)
  const count = tasks.items.length
  return (
    <span className={css.glyph}>
      <IconBranchOutlineRegular size={size} />
      {count > 0 && (
        <span className={css.badge}>{count > 99 ? '99+' : count}</span>
      )}
    </span>
  )
}
