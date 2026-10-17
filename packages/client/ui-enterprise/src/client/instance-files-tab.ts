/**
 * 实例空间 UI 的常量、纯函数与响应式派生(design
 * 2026-10-14-instance-workspace-design.md §5.2/§5.3):类型标识、会话→流程
 * 实例解析、文件清单组树、字节数人读格式与云路径默认计算。组件在
 * {@link ./InstanceFilesPanel.tsx} 与 {@link ./InstanceUploadAction.tsx}。
 *
 * <p>标签页只对绑定待办的会话有意义:openTask/确认绑定后程序化打开,不注册
 * guide(不进 guide 页),未绑定会话即使手工打开也只渲染空态。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import type { InstanceWorkspaceFile } from './instance-workspace-api.ts'
import { useSnapshot } from './workbench/hooks.ts'

/** 实例空间标签页的类型标识(rightbar 标签页系统 openTab 的 kind)。 */
export const INSTANCE_FILES_TAB_KIND = 'instanceFiles'

/** 实例空间标签页实现的注册 id(stage-two keyed 座位的 key)。 */
export const INSTANCE_FILES_TAB_ID = '@deepseek-ai/dsh-client-ui-enterprise/instance-files'

/**
 * 解析会话绑定的流程实例(实例空间标签页与 @ 触发源共用的归属判断)。
 * @param workbench - 工作台编排器。
 * @param sessionId - 目标会话。
 * @returns 绑定待办的流程实例 id;未绑定待办(null)时不展示实例空间。
 */
export function resolveSessionInstance(workbench: EnterpriseWorkbench, sessionId: SessionId): string | null {
  return workbench.taskOfSession(sessionId)?.processInstanceId ?? null
}

/**
 * 会话绑定的流程实例的响应式解析(渲染路径用,经快照订阅保持响应式);
 * 事件处理器与单测用非响应式的 {@link resolveSessionInstance}。
 * @param workbench - 工作台编排器。
 * @param sessionId - 目标会话。
 * @returns 绑定待办的流程实例 id;未绑定(null)时实例空间各面不渲染。
 */
export function useSessionInstance(workbench: EnterpriseWorkbench, sessionId: SessionId): string | null {
  const tasks = useSnapshot(workbench.tasks)
  const bindings = useSnapshot(workbench.bindings)
  const taskId = bindings.sessionToTask[sessionId]
  return taskId === undefined ? null : tasks.items.find(item => item.id === taskId)?.processInstanceId ?? null
}

/** 文件树节点:目录节点无 file;文件节点携带元数据(name 即末段)。 */
export type InstanceFileTreeNode = {
  name: string
  file?: InstanceWorkspaceFile
  children: InstanceFileTreeNode[]
}

/**
 * 平铺文件清单组目录树(relPath 按 `/` 分段)。
 *
 * <p>排序:目录在前、文件在后,同类按名称中文字典序——树形渲染顺序确定,
 * 单测可断言。同名文件与目录并存时互不干扰(目录匹配只认目录节点)。
 * @param files - 实例空间文件清单。
 * @returns 树根(空清单为 children 为空的根)。
 */
export function buildFileTree(files: readonly InstanceWorkspaceFile[]): InstanceFileTreeNode {
  const root: InstanceFileTreeNode = { name: '', children: [] }
  for (const file of files) {
    const segments = file.relPath.split('/')
    let node = root
    for (const segment of segments.slice(0, -1)) {
      let child = node.children.find(candidate => candidate.file === undefined && candidate.name === segment)
      if (child === undefined) {
        child = { name: segment, children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.children.push({ name: segments[segments.length - 1] ?? '', file, children: [] })
  }
  const sortNode = (node: InstanceFileTreeNode): void => {
    node.children.sort((a, b) => {
      if ((a.file === undefined) !== (b.file === undefined)) return a.file === undefined ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    for (const child of node.children) sortNode(child)
  }
  sortNode(root)
  return root
}

/**
 * 字节数人读格式(B/KB/MB/GB,一位小数)。
 * @param sizeBytes - 文件字节数。
 * @returns 形如 `3 B` / `2.5 KB` 的展示文本。
 */
export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`
  return `${(sizeBytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/**
 * 云上传的默认目标路径:绝对路径相对会话工作目录的部分(统一 POSIX 分隔);
 * 路径不在工作目录下时返回 null(调用方回退文件名)。
 * @param cwd - 会话工作目录绝对路径。
 * @param absolutePath - 工作空间文件绝对路径。
 * @returns 实例空间 relPath 候选(如 `reports/weekly.md`);不属于 cwd 下为 null。
 */
export function relativePathUnder(cwd: string, absolutePath: string): string | null {
  const base = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  const full = absolutePath.replaceAll('\\', '/')
  if (!full.startsWith(`${base}/`)) return null
  return full.slice(base.length + 1)
}
