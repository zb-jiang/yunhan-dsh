/**
 * 会话头部「实例空间/任务档案」重开入口:conversation.session.header.utilities
 * 座位占据者。仅绑定待办的会话渲染两个紧凑图标按钮,右栏标签页被 × 关闭后
 * 从此处一键重开(openTabIn 幂等,已开即聚焦);未绑定会话返回 null,头部
 * utilities 区域经 :empty 塌缩,普通会话零占位。
 *
 * 当前会话必然已挂载(按钮就渲染在该会话头部),openTabIn 无 openArchiveTab
 * 的时序缺口(见 workbench.openTaskArchiveTab 文档)。
 */
import type { ReactNode } from 'react'

import {
  IconArchiveOutlineMedium,
  IconFolderCloseMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import { useSessionInstance } from './instance-files-tab.ts'
import css from './ArchiveTabsHeaderButton.module.css'

/** header.utilities 座位注入面:工作台编排器(绑定判定与标签页打开)。 */
export type ArchiveTabsHeaderInjected = {
  workbench: EnterpriseWorkbench
}

/** header.utilities 座位组件 props:session 标准 kit + 注入面。 */
export type ArchiveTabsHeaderButtonProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & ArchiveTabsHeaderInjected

/** 绑定待办的会话头部右侧的实例空间/任务档案重开按钮(见模块文档)。 */
export function ArchiveTabsHeaderButton({
  sessionId,
  workbench,
}: ArchiveTabsHeaderButtonProps): ReactNode {
  const instanceId = useSessionInstance(workbench, sessionId)
  // 未绑定待办的会话没有实例空间与任务档案,不渲染。
  if (instanceId === null) return null
  return (
    <>
      <button
        type="button"
        className={css.button}
        aria-label="实例空间"
        title="实例空间"
        onClick={() => { workbench.openInstanceFilesTab(sessionId) }}
      >
        <IconFolderCloseMedium />
      </button>
      <button
        type="button"
        className={css.button}
        aria-label="任务档案"
        title="任务档案"
        onClick={() => { workbench.openTaskArchiveTab(sessionId) }}
      >
        <IconArchiveOutlineMedium />
      </button>
    </>
  )
}
