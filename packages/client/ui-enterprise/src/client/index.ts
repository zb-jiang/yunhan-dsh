/**
 * 企业工作台客户端入口:三栏骨架的装配点。
 *
 * <p>待办队列注册进原生 sidebar 的 `sidebar.nav` 座位(SidebarRoot 的
 * enterpriseLayout 分支渲染),原生 workspaces 会话浏览/New Session/Settings
 * 全部保留(企业 profile 与上游 DSH 的合并面最大化保留原生能力);任务档案
 * 注册为 rightbar 标签页系统的 extension 类型(两阶段:类型入
 * ctx.sidebarRightTabs,主体入 `sidebar.right.pane.tab` keyed 座位),
 * openTask/openCompletedTask 经 ctx.sidebarRight.openTab 打开;中间会话区
 * 保持原生 ConversationRoot。EnterpriseWorkbench 在 apply 构造一次,经各
 * 占据者的 inject 面分发。认证遮罩(shell.overlay)未登录时盖住整帧;匿名
 * 放行态不盖,登录引导卡占据 sidebar.footer.action 座位(侧栏底部)。
 *
 * <p>知识库三面(design 2026-09-11 §6):KnowledgeWorkbench 同样在 apply
 * 构造一次;选择器入口占据 `conversation.input.left`(待办/已完成回执会话
 * 且应用已开通时渲染),已选文档 chip 行占据 `conversation.input.dock`,输入框
 * '@' 知识库文档触发源注册进 ctx.inputTriggers(待办/已完成会话候选 → 内联
 * chip),工作空间文件行的「上传到知识库」占据 ui-sidebar-files 声明的
 * `sidebar.files.entry.action`(readBytes 经 ctx.remote.workspaceFiles 绑定);
 * 历史消息里的 `知识库文档 docid: <id>` wire 文本经 ui-conversation 的
 * user-text 体系('kb-doc' 规则 + keyed 渲染器)恢复为文档徽标。座位由其他
 * 包的注册声明,经 ctx.slots.inject 延迟到声明后注册。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { IconApiOutlineMedium, IconPhoneOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: 拉入 ui-workspace 的 SlotMap 合并(sidebar.nav.directoryFlow 洞类型)。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
// Type-only: 拉入 ui-sidebar-documentpreview 的 SlotMap 合并
// (sidebar.right.tab.document.actions 座位类型,「引用到对话」挂载点)。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: 拉入 enterpriseFiles 域的 RemoteErrorDetailsMap 声明合并与 wire 请求类型。
import type { EnterpriseFileWriteRequest } from '@deepseek-ai/dsh-enterprise-file-write/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: 拉入 settings 域的 SlotMap 声明('settings.section' 座位类型)。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 生成态 remote contribution:客户端 bundle 内联(typert remote-client 产物),
// 挂载后在 ctx.remote.enterpriseFiles 暴露文件写端点。
import enterpriseFilesRemote from '@deepseek-ai/dsh-enterprise-file-write/remote'
import { EnterpriseOverlay } from './EnterpriseUi.tsx'
import { ARCHIVE_TAB_ID, ARCHIVE_TAB_KIND, EnterpriseWorkbench } from './enterprise-workbench.ts'
import { EnterpriseServicesSection } from './EnterpriseServicesSection.tsx'
import { PocketAccessSection } from './pocket/PocketAccessSection.tsx'
import { PocketPairingExpired } from './pocket/PocketPairingExpired.tsx'
import { createEnterpriseServicesAccess } from './enterprise-services-access.ts'
import { KnowledgeWorkbench } from './knowledge-workbench.ts'
import { buildKbDocsSource } from './kb-trigger-source.ts'
import { buildInstanceWorkspaceSource } from './instance-trigger-source.ts'
import { buildFileQuoteSource } from './file-quote-source.ts'
import { kbDocRule, KbDocNode } from './kb-doc-decorator.tsx'
import { TaskArchivePanel } from './TaskArchivePanel.tsx'
import { INSTANCE_FILES_TAB_ID, INSTANCE_FILES_TAB_KIND } from './instance-files-tab.ts'
import { InstanceFilesPanel } from './InstanceFilesPanel.tsx'
import { TaskQueueSidebar } from './TaskQueueSidebar.tsx'
import { GuestSidebarCard } from './GuestSidebarCard.tsx'
import { KbChipsDock } from './KbChipsDock.tsx'
import { KbPickerButton } from './KbPickerButton.tsx'
import { KbUploadAction } from './KbUploadAction.tsx'
import type { KbUploadInjected } from './KbUploadAction.tsx'
import { InstanceUploadAction } from './InstanceUploadAction.tsx'
import { QuoteToConversationAction } from './QuoteToConversationAction.tsx'
import {
  ENTERPRISE_FILE_EDITOR_EXTENSIONS, ENTERPRISE_FILE_EDITOR_ID, EnterpriseFileEditor,
} from './EnterpriseFileEditor.tsx'
import type { EnterpriseFileEditorInjected, EnterpriseFileSaveOutcome } from './EnterpriseFileEditor.tsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  DeleteSessionConfirmDialog, DeleteSessionMenuItem, DeleteSessionRowButton, deleteArchivedSessionRequest,
} from './DeleteSession.tsx'
import type {
  SessionDeleteActionInjected, SessionDeleteDialogInjected, SessionDeleteRequest,
} from './DeleteSession.tsx'

export const inject = [
  'slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'conversation', 'uiConversation', 'inputTriggers', 'sidebarRight',
  'sidebarRightTabs', 'documentPreviews', 'remote', 'remote.workspaceFiles', 'remote.settings', 'connection',
]

/**
 * 两阶段挂载企业文件写通道(voice-input `mountVoiceInput` 同款结构):先挂
 * remote contribution,再在注入 `remote.enterpriseFiles` 的子 fiber 里注册
 * 编辑器预览与保存闭包——闭包捕获子 fiber 的 ctx,该 fiber 对 mount 出的
 * namespace 向上可见且已声明注入,任何调用栈(含 React 事件回调)都能解析。
 * @param ctx - 客户端 Cordis 上下文(插件 apply fiber)
 * @returns 联合 disposer:先撤编辑器注册,再卸载 remote namespace
 */
async function mountEnterpriseFiles(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(enterpriseFilesRemote)
  const consumers = ctx.inject(['remote.enterpriseFiles', 'documentPreviews', 'slots'], (filesCtx) => {
    const enterpriseFiles = filesCtx.remote.enterpriseFiles
    const saveFile = (sessionId: string, request: EnterpriseFileWriteRequest, signal?: AbortSignal): Promise<EnterpriseFileSaveOutcome> =>
      enterpriseFiles.write(sessionId as SessionId, request, signal ?? new AbortController().signal).then(result => result.ok
        ? { ok: true, version: result.value.version, absolutePath: result.value.absolutePath }
        : { ok: false, code: result.error.code, message: result.error.message })
    // 右栏文件预览编辑器(CodeMirror 6 + Ctrl+S 保存):definition 以 extension
    // 优先级覆盖同后缀的官方只读预览(openWith 菜单仍可切回)。
    filesCtx.effect(() => filesCtx.documentPreviews.register({
      id: ENTERPRISE_FILE_EDITOR_ID,
      extensions: ENTERPRISE_FILE_EDITOR_EXTENSIONS,
      priority: 'extension',
      title: () => '编辑器',
      loading: 'bytes-complete',
      wrap: false,
    }), 'ui-enterprise: file editor definition')
    filesCtx.slots.inject('sidebar.right.tab.document', () => filesCtx.slots.register({
      name: 'sidebar.right.tab.document',
      key: ENTERPRISE_FILE_EDITOR_ID,
      inject: (): EnterpriseFileEditorInjected => ({ saveFile }),
    }, EnterpriseFileEditor))
  })
  try { await consumers } catch (error) { await consumers.dispose(); await disposeRemote(); throw error }
  return async () => { await consumers.dispose(); await disposeRemote() }
}

export function apply(ctx: ClientContext): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.dshEnterpriseProfile = 'true'
  }

  // 企业文件写 remote:两阶段挂载(见 mountEnterpriseFiles)——先挂 remote
  // contribution,再在注入 `remote.enterpriseFiles` 的子 fiber 里注册编辑器。
  // 不能把该 namespace 写进本插件 inject(等于等自己 mount 的服务,死锁);
  // 也不能在 apply 闭包里直接解析:effect 子 fiber 装的服务对 apply fiber 的
  // 向上查找不可见(报 without inject),apply 执行期 fiber.runtime 未就绪时
  // 更是软查找返回 undefined。voice-input 的 mountVoiceInput 是同款官方先例。
  ctx.effect(() => mountEnterpriseFiles(ctx), 'ui-enterprise: enterpriseFiles mount')

  const workbench = new EnterpriseWorkbench({
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    uiWorkspace: ctx.uiWorkspace,
    layout: ctx.layout,
    conversation: ctx.conversation,
    sidebarRight: ctx.sidebarRight,
  })

  const knowledge = new KnowledgeWorkbench({
    sessions: ctx.sessions,
    conversation: ctx.conversation,
  })

  // 企业服务配置读写面:设置面板座位与登录页「服务配置」弹层共用同一实例语义。
  const servicesAccess = createEnterpriseServicesAccess(ctx.remote.settings)

  // 输入框 '@' 知识库文档触发源:待办会话候选 → 内联 chip(退订器由 effect 持有)。
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(buildKbDocsSource({ workbench, knowledge })), 'ui-enterprise: @kbDocs source')

  // 输入框 '@' 实例空间文件触发源:绑定待办的会话候选 → 纯文本插入(退订器由 effect 持有)。
  ctx.effect(() => inputTriggers.registerSource(buildInstanceWorkspaceSource(workbench)), 'ui-enterprise: @instanceWorkspace source')

  // 「引用到对话」chip 触发源:不出菜单候选,承载右栏选区引用 chip 的点击
  // 定位(openReference)与模型序列化(codec);chip 的插入在
  // QuoteToConversationAction(退订器由 effect 持有)。
  ctx.effect(
    () => inputTriggers.registerSource(buildFileQuoteSource({ sidebarRight: ctx.sidebarRight, sessions: ctx.sessions })),
    'ui-enterprise: fileQuote source',
  )

  // 右边栏卡死哨兵:按钮+面板一起消失的脱节状态自愈 + 证据日志(见
  // workbench.armStuckSentinel;自愈只恢复 frame 轨道,不碰 surface)。
  ctx.effect(() => workbench.armStuckSentinel(), 'ui-enterprise: rightbar stuck sentinel')

  // 历史消息的知识库文档徽标:'kb-doc' 规则切节点,'kb-doc' keyed 渲染器出
  // chip(座位由 ui-conversation 声明,经 slots.inject 延迟到声明后注册)。
  ctx.effect(() => ctx.uiConversation.userText.register(kbDocRule), 'ui-enterprise: kb doc rule')
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node',
    key: 'kb-doc',
  }, KbDocNode))

  // 认证遮罩:未登录/待审批/被禁用时盖住整帧(匿名放行态不盖,登录引导卡在
  // 侧栏底部);注入企业服务配置读写面,登录页常驻「服务配置」弹层与设置面板
  // 共用同一套 load/save(含镜像与并发控制)。
  ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'enterprise',
      order: 50,
      inject: () => ({ services: createEnterpriseServicesAccess(ctx.remote.settings) }),
    },
    EnterpriseOverlay,
  )

  // 手机配对失效页:连接断开后经代理闸门探测配对状态,失效/被拒时盖住整帧
  // (order 60 晚于认证遮罩,DOM 靠后盖住一切)。PC 直连不经代理闸门,永不触发。
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'enterprise-pocket-expired',
      order: 60,
      inject: () => ({ connectionState: connection.state }),
    },
    PocketPairingExpired,
  )

  // 待办队列:原生 sidebar 的 enterprise nav 座位。children 声明本 entry
  // 的目录流程洞(目录 surface 包经 slots.inject 按此延迟注册),占用源经
  // hooks 下发——弹窗据此在洞空闲时隐藏"浏览本地文件夹"入口。
  const directoryFlowSource: HostObservable<boolean> = {
    getSnapshot: () => ctx.slots.entries('sidebar.nav.directoryFlow').length > 0,
    subscribe: listener => ctx.slots.subscribe('sidebar.nav.directoryFlow', listener),
  }
  ctx.slots.register({
    name: 'sidebar.nav',
    children: { 'sidebar.nav.directoryFlow': { kind: 'single', scope: 'root' } },
    inject: () => ({ workbench, hooks: { directoryFlow: directoryFlowSource } }),
  }, TaskQueueSidebar)

  // 匿名使用引导卡:侧栏底部(设置项上方)的登录入口——匿名放行态认证遮罩
  // 不盖帧,登录引导收进侧栏 footer(右上角悬浮条会挡顶栏控件,已废弃);
  // 登录态与未开启匿名偏好返回 null,窄轨收缩为单图标按钮。
  ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'enterprise-guest',
    order: 40,
  }, GuestSidebarCard)

  // 任务档案标签页,stage one:类型声明(extension 带,企业外部实现)。
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ARCHIVE_TAB_ID,
    kind: ARCHIVE_TAB_KIND,
    priority: 'extension',
    title: () => '任务档案',
  }), 'ui-enterprise: archive tab type')

  // 任务档案标签页,stage two:主体注册(keyed 座位,key=类型 id)。
  // 座位声明由 ui-sidebar-right 的 rightbar.session 挂载,inject 保证晚于声明。
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ARCHIVE_TAB_ID,
    inject: () => ({ workbench }),
  }, TaskArchivePanel))

  // 实例空间标签页,stage one:类型声明(extension 带,不注册 guide——仅
  // 程序化打开,见 workbench.openTask/confirmPendingTaskWorkspace)。
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: INSTANCE_FILES_TAB_ID,
    kind: INSTANCE_FILES_TAB_KIND,
    priority: 'extension',
    title: () => '实例空间',
  }), 'ui-enterprise: instance-files tab type')

  // 实例空间标签页,stage two:主体注册(keyed 座位,key=类型 id)。
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: INSTANCE_FILES_TAB_ID,
    inject: () => ({ workbench }),
  }, InstanceFilesPanel))

  // 知识库选择器入口:输入框左侧(待办/已完成回执会话且应用已开通时渲染)。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'kb-picker',
    inject: () => ({ workbench, knowledge }),
  }, KbPickerButton))

  // 知识库文档 chip 行:输入框上方 dock(已选文档展示与移除)。
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'kb-chips',
    order: 5,
    inject: () => ({ knowledge }),
  }, KbChipsDock))

  // 工作空间文件行「上传到知识库」:readBytes 无 range 读全文(受 maxFileBytes 上限) → 代理 multipart 上传。
  // workspaceFiles 由 api/remotes 预先挂载且在本插件 inject 声明,回调内按需
  // 解析合法——与 self-mount 的 enterpriseFiles 不同,无需子 fiber。
  const readWorkspaceFile: KbUploadInjected['readWorkspaceFile'] =
    (sessionId, path, signal) => ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
  ctx.slots.inject('sidebar.files.entry.action', () => ctx.slots.register({
    name: 'sidebar.files.entry.action',
    id: 'kb-upload',
    inject: () => ({ readWorkspaceFile }),
  }, KbUploadAction))

  // 工作空间文件行「上传到实例空间」(树上云,design 2026-10-14 §5.3):
  // 同 readBytes 读全文 → 代理 multipart 上传到流程实例云工作空间;仅绑定
  // 待办的会话渲染按钮(组件内经 workbench 判定,未绑定返回 null)。
  ctx.slots.inject('sidebar.files.entry.action', () => ctx.slots.register({
    name: 'sidebar.files.entry.action',
    id: 'instance-upload',
    inject: () => ({ readWorkspaceFile, workbench }),
  }, InstanceUploadAction))

  // 右栏文件预览「引用到对话」:预览正文右键选区 → 结构化引用 chip 经
  // inputActions 插入输入草稿,发送时序列化为带行号署名的 markdown 围栏
  // (座位由 ui-sidebar-documentpreview 的 TextPreview 声明,监听挂预览根,
  // 选区落在纯文本渲染器的行标记内才弹菜单)。
  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions',
    id: 'enterprise-quote-to-conversation',
  }, QuoteToConversationAction))

  // 右栏文件预览编辑器的注册在 mountEnterpriseFiles 内:保存闭包依赖
  // self-mount 的 enterpriseFiles namespace,必须在注入它的子 fiber 里创建。

  // 企业服务配置:settings.section 座位的聚合配置页(volatile 字段即时生效)。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'enterprise-services',
    order: 30,
    label: () => '企业服务配置',
    icon: () => createElement(IconApiOutlineMedium, { size: 16 }),
    inject: () => ({ load: servicesAccess.load, save: servicesAccess.save, saveSso: servicesAccess.saveSso }),
  }, EnterpriseServicesSection))

  // 手机访问:settings.section 座位(M1:状态轮询+总开关+局域网卡)。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'pocket-access',
    order: 31,
    label: () => '手机访问',
    icon: () => createElement(IconPhoneOutlineMedium, { size: 16 }),
  }, PocketAccessSection))

  // 已归档会话的「删除会话」三件套:菜单第一项(order 50,官方条目 100-400)
  // + 行悬停按钮 + shell.overlay 确认对话框;发起与确认经共享的 deleteRequest
  // store 连接,删除成功后 Host 的 domain/changed 变更经 feed 推回刷新列表。
  const deleteRequest = createSnapshotStore<SessionDeleteRequest | null>(null)
  const deleteActionInjected = (): SessionDeleteActionInjected => ({
    hooks: { deleteRequest },
    // 两个入口都带 owner 的 displayTitle(会话无持久标题时为空串),此时
    // 回退到会话快照的展示标题,再回退到会话 id。
    requestSessionDelete: (sessionId, displayTitle) => {
      deleteRequest.set({
        sessionId,
        displayTitle: displayTitle !== ''
          ? displayTitle
          : ctx.sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId,
      })
    },
  })
  const deleteDialogInjected = (): SessionDeleteDialogInjected => ({
    hooks: { deleteRequest },
    settleSessionDelete: () => { deleteRequest.set(null) },
    deleteSession: sessionId => deleteArchivedSessionRequest(sessionId),
  })
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'enterprise-delete-session',
    order: 50,
    inject: deleteActionInjected,
  }, DeleteSessionMenuItem))
  ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.row.action',
    id: 'enterprise-delete-session',
    order: 50,
    inject: deleteActionInjected,
  }, DeleteSessionRowButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'enterprise-delete-session',
    inject: deleteDialogInjected,
  }, DeleteSessionConfirmDialog))
}
