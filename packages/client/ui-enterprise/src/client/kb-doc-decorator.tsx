/**
 * 历史消息里的知识库文档徽标(design 2026-09-11 §6):把已发送用户消息与
 * 队列草稿里的 `知识库文档 docid: <id>` wire 文本恢复为文档徽标(文档图标
 * + 文档名)。
 *
 * <p>输入框 chip 发送后编辑器里只剩 wire 文本(草稿持久化的已知降级),
 * 历史气泡经 ui-conversation 的 user-text 体系重投影:'kb-doc' 规则
 * (ctx.uiConversation.userText 注册)把 wire 文本切成业务节点,keyed 渲染
 * 器(conversation.user.text.node 的 'kb-doc' entry)渲染为徽标;匹配只认
 * 服务端 UUID 形态的 docid,手工敲出的同形文本除外。徽标纯展示不可点,
 * 悬停 title 显示完整 wire 文本。docid → 文档名经 web-console 文档元数据
 * 端点异步反查:成功名按 docid 进程内缓存,失败进 30s 负缓存,TTL 内降级
 * 显示 id 前 8 位、过期重试——瞬时失败(登录态刷新、web-console 不可达)
 * 不把徽标永久钉在降级态,文档删除/失权的稳定失败重试代价只是一次 404,
 * 不影响消息阅读。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { UserTextNodeProps, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReferenceIconRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { getDocument } from './kb-api.ts'
import css from './KbDocChip.module.css'

// UserTextDataMap 声明合并:'kb-doc' 节点携带服务端 docid,渲染器经
// UserTextNodeProps<'kb-doc'> 读同一 payload 类型。
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'kb-doc': { readonly docId: string }
  }
}

/** wire 文本形态(knowledge-workbench.kbReferenceText 的字面契约,docid 为服务端 UUID)。 */
const KB_DOC_WIRE_RE =
  /知识库文档 docid: ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/gu

/** 已结算的 docid → 文档名(仅成功结果)。 */
const settledNames = new Map<string, string>()
/** 负缓存:docid → 失败结算时间;TTL 内降级不重试,过期重新出站。 */
const failedNames = new Map<string, number>()
const NEGATIVE_TTL_MS = 30_000
/** pending 表去重并发出站。 */
const pendingNames = new Map<string, Promise<string | null>>()

/** 负缓存是否仍在有效期内。 */
function failedRecently(docId: string): boolean {
  const failedAt = failedNames.get(docId)
  return failedAt !== undefined && Date.now() - failedAt < NEGATIVE_TTL_MS
}

/**
 * 反查文档名(缓存优先)。成功名永久缓存;失败只进短负缓存——瞬时失败
 * (登录态刷新、web-console 不可达)不应把徽标永久钉在降级态,文档删除/
 * 失权重试的代价只是一次 404。
 */
function resolveDocName(docId: string): Promise<string | null> {
  const settled = settledNames.get(docId)
  if (settled !== undefined) return Promise.resolve(settled)
  if (failedRecently(docId)) return Promise.resolve(null)
  const pending = pendingNames.get(docId)
  if (pending !== undefined) return pending
  const inflight = getDocument(docId)
    .then((doc) => {
      settledNames.set(docId, doc.name)
      return doc.name
    })
    .catch(() => {
      failedNames.set(docId, Date.now())
      return null
    })
    .finally(() => { pendingNames.delete(docId) })
  pendingNames.set(docId, inflight)
  return inflight
}

/** 名称解析的同步快照:已结算返回名称(null = 负缓存内确认失败),未结算 undefined。 */
function settledDocName(docId: string): string | null | undefined {
  const settled = settledNames.get(docId)
  if (settled !== undefined) return settled
  return failedRecently(docId) ? null : undefined
}

/** 名称未结算时的降级展示(id 前 8 位足以区分同屏徽标,完整 id 在 title 里)。 */
function fallbackLabel(docId: string): string {
  return `文档 ${docId.slice(0, 8)}`
}

/** 历史消息里的单个知识库文档徽标(纯展示;名称异步反查,先出降级文本)。 */
function KbDocChip({ docId, title }: { docId: string; title: string }): ReactNode {
  const [name, setName] = useState<string | null | undefined>(() => settledDocName(docId))
  useEffect(() => {
    if (settledDocName(docId) !== undefined) return undefined
    let alive = true
    void resolveDocName(docId).then((resolved) => {
      if (alive) setName(resolved)
    })
    return () => { alive = false }
  }, [docId])
  return (
    <span className={css.chip} title={title} data-kb-doc-chip={docId}>
      <ReferenceIconRegular kind="file" size={16} className={css.icon} />
      {name ?? fallbackLabel(docId)}
    </span>
  )
}

/**
 * 'kb-doc' 匹配规则(apply 时经 ctx.uiConversation.userText 注册一次,
 * 退订器由 ctx.effect 持有)。wire 文本带中文前缀,与内置规则(会话标签、
 * 空白)不存在同起点候选,order 只需有限,取 20。
 */
export const kbDocRule: UserTextRule<'kb-doc'> = {
  id: 'kb-doc',
  order: 20,
  match(text, from) {
    KB_DOC_WIRE_RE.lastIndex = from
    const wire = KB_DOC_WIRE_RE.exec(text)
    if (wire === null) return undefined
    return {
      id: 'kb-doc',
      start: wire.index,
      end: wire.index + wire[0].length,
      data: { docId: wire[1] as string },
    }
  },
}

/**
 * keyed 渲染器:conversation.user.text.node 的 'kb-doc' entry(座位由
 * ui-conversation 声明,经 ctx.slots.inject 延迟到声明后注册)。
 */
export function KbDocNode({ node, raw }: UserTextNodeProps<'kb-doc'>): ReactNode {
  return <KbDocChip docId={node.data.docId} title={raw} />
}
