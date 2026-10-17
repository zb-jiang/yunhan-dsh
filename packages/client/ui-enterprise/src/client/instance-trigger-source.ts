/**
 * '@' 实例空间文件触发源(design 2026-10-14-instance-workspace-design.md
 * §5.4):绑定待办的会话里敲 '@' 出现实例空间文件候选,选中在输入框插入
 * 纯文本 `@实例空间/<relPath>`(无 chip、无 codec——序列化即原文进模型,
 * 与实例空间工具的路径字面一致)。
 *
 * <p>候选解析:会话 → 待办绑定(EnterpriseWorkbench)→ 流程实例 id → 云
 * 工作空间文件清单(经代理 GET,每次冷拉)。空 query 列全部文件,非空按
 * relPath 大小写不敏感包含匹配,截取前 20 条(菜单承载上限,更多靠输入更
 * 具体的前缀过滤)。未绑定待办的会话不出候选。
 */
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { resolveSessionInstance } from './instance-files-tab.ts'
import { listInstanceFiles } from './instance-workspace-api.ts'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'

/** 菜单里本源候选的分组标题(候选 section 原样渲染,不经字典)。 */
const SECTION_LABEL = '实例空间文件'

/** 候选条数上限:实例空间文件数可能很大,菜单只承载前 20 条。 */
const CANDIDATE_LIMIT = 20

/**
 * 构造 '@' 实例空间文件触发源(apply 时注册一次,退订器由 ctx.effect 持有)。
 * @param workbench - 待办绑定来源。
 * @returns 触发源。
 */
export function buildInstanceWorkspaceSource(workbench: EnterpriseWorkbench): InputTriggerSource {
  return {
    trigger: '@',
    name: 'instanceWorkspace',
    order: 11,
    showGroupTitle: false,
    async candidates(session: ClientSessionContext, { query, signal }) {
      const instanceId = resolveSessionInstance(workbench, session.sessionId)
      if (instanceId === null) return []
      const files = await listInstanceFiles(instanceId)
      if (signal.aborted) return []
      const needle = query.trim().toLowerCase()
      return files
        .filter((file) => {
          if (needle === '') return true
          return file.relPath.toLowerCase().includes(needle)
        })
        .slice(0, CANDIDATE_LIMIT)
        .map(file => ({
          name: file.relPath,
          icon: 'file' as const,
          section: SECTION_LABEL,
          value: file.relPath,
        }))
    },
    warm(session) {
      const instanceId = resolveSessionInstance(workbench, session.sessionId)
      if (instanceId === null) return
      void listInstanceFiles(instanceId)
        .then(() => undefined)
        .catch(() => { /* 会话诞生预热失败不阻塞;candidates 冷拉会按需重取 */ })
    },
    onPick({ candidate }) {
      const relPath = candidate.value
      if (relPath === undefined) return undefined
      return { text: `@实例空间/${relPath}` }
    },
  }
}
