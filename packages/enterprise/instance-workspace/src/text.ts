/**
 * Deterministic rendering of the model-visible instance-workspace block
 * (design docs/plans/2026-10-14-instance-workspace-design.md §5.1c/§6.2).
 * The backend task injects it as a prompt section; the employee-side task
 * reuses it as the pre-step message source wording. Pure function, no I/O.
 *
 * @module
 */

/** Section name carried by the injected message's plugin source (employee-side pre-step). */
export const INSTANCE_WORKSPACE_SECTION = 'instance-workspace'

/** One resolved instance-workspace binding. */
export interface InstanceWorkspaceBlockData {
  /** Flowable process instance id owning the shared cloud workspace. */
  processInstanceId: string
  /** Current node id (BPMN activity id); null when the caller has no node context. */
  taskId: string | null
}

/** Collapse line breaks so one field can never forge the next line of the block. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

/**
 * Render the durable instance-workspace block for one resolved instance.
 * @param data - resolved process instance id and optional node id.
 * @returns the exact text carried by the injected prompt section.
 */
export function renderInstanceWorkspaceContextText(data: InstanceWorkspaceBlockData): string {
  return '<instance_workspace>\n'
    + '本会话关联流程实例云工作空间（实例内所有节点共享）。\n'
    + `instanceId: ${singleLine(data.processInstanceId)}\n`
    + `taskId: ${data.taskId === null ? '(无)' : singleLine(data.taskId)}\n`
    + '对话与 @引用 中出现的实例空间文件用以下工具操作：\n'
    + '  workspace_list(instanceId)                             列出文件\n'
    + '  workspace_read(instanceId, path)                       读文本文件\n'
    + '  workspace_write(instanceId, path, content, taskId?)     写/覆盖文本文件\n'
    + '  workspace_upload(instanceId, localPath, path, taskId?)  上传本地文件\n'
    + '  workspace_download(instanceId, path)                    下载到本会话本地工作区（同名冲突默认拒绝）\n'
    + '  workspace_delete(instanceId, path)                     删除文件\n'
    + '写或上传文件时把上面的 taskId 作为工具的 taskId 参数传入，用于记录来源节点。\n'
    + '</instance_workspace>'
}
