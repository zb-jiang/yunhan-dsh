---
description: "企业工作台 UI：认证门 + 待办队列侧栏 + 任务档案详情，挂在三栏外壳之上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enterprise

[English](README.md) | 中文

## 概述

`dsh-client-ui-enterprise` 是企业工作台的浏览器侧半边：一个以 Supabase 登录与审批状态为闸门、罩住整个外壳的认证浮层，一个挂进原生侧栏导航的待办队列侧栏（待办与已完成两组），以及右侧栏中的任务档案标签页。首次点击待办会打开显式的工作空间选择器，创建专属会话并预填节点 prompt，且不覆盖已编辑内容；提交经映射对话框路由并记录回执。知识库选择器、chips、'@' 触发、上传动作、服务设置与已归档会话删除补全了整个界面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包是企业 Web 客户端的 `./client` bundle：宿主侧入口是一个空的 `apply()`，以下一切都在浏览器里运行。它与企业 profile 的服务端插件配对——认证浮层与 dsh-platform-user-api 通信，待办队列读 flowable 代理，知识库界面与 knowledge 插件通信。

### 各部件挂载在哪里

| 座位 | 组件 | 角色 |
|---|---|---|
| `shell.overlay` | EnterpriseOverlay | 认证门：登录页、服务配置弹层、阻断态（待审批、已禁用、已锁定） |
| `shell.overlay` | PocketPairingExpired | 手机配对失效页：连接断开后经代理闸门探测，配对被撤销/失效、局域网关闭或代理停止应答（总开关关闭/电脑关机）时盖住整帧；探测带短超时（对已死监听端口的 TCP 失败在真实网络里可挂数十秒），停止应答的失效页会持续轮询，代理恢复后自动消失，其余结论为终态（仅手机端经代理可达，PC 直连不触发） |
| `sidebar.nav` | TaskQueueSidebar | 原生侧栏 enterprise 分支中的待办 + 已完成队列 |
| `sidebar.right.pane.tab` | TaskArchivePanel | 档案标签页（两阶段：类型声明 + keyed 主体） |
| `conversation.input.left` / `conversation.input.dock` | KbPickerButton / KbChipsDock | 知识文档选择入口与已选文档 chips |
| `sidebar.files.entry.action` | KbUploadAction | 文件行级「上传到知识库」 |
| `settings.section` | EnterpriseServicesSection | 企业服务配置聚合页 |
| 会话菜单 / 行 / 浮层 | DeleteSession 三件套 | 已归档会话删除入口与确认对话框 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### Slots 组合；工作台编排

一个 `EnterpriseWorkbench` 在 apply 中构造，经各占据者的 inject 分发（[src/client/index.ts](src/client/index.ts)）。注册落点在其他包声明的座位里，因此走 `ctx.slots.inject`，并在声明者挂载后才注册；档案标签页分两阶段注册类型与主体。

### 认证门同时是身份泵

Supabase 会话持久化在 localStorage 并自动刷新。收到 `TOKEN_REFRESHED` 时浮层重拉 `/me`，既刷新本地用户快照，也把新 token 交给 webserver 的身份缓存——所有轮询 `platform-user/verified` 的 daemon 跟随换新。收到 `SIGNED_OUT`（本标签页或其他标签页，经 storage 事件）时画面重新被门罩住。

### 待办绝不覆盖员工的编辑

Prompt 预填仅在草稿为空时经会话草稿路径写入；失败以侧栏通知呈现。首次点击未绑定的待办需要显式的工作空间确认——取消则不产生会话。绑定持久化在 localStorage，刷新后回到同一会话；skill 就绪检查降级为通知，不阻断会话。点击已完成任务优先回到提交时的会话；会话已不存在（本地清理后）则主视图回到新会话空界面，任务档案改在右栏只读展示。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业组 README](../../enterprise/README.zh.md) — 本 UI 配合的服务端企业包。
- [部署架构](../../../docs/plans/dsh_enterprise_architecture_v5.html) — 浏览器、本地 webserver 与企业服务器在 v5 拓扑中的位置。

-----

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：本包是浏览器侧的企业工作台 UI；只渲染状态，不注册任何 prompt、工具或会话事件。

#### KV Cache 影响

这里的一切都是读 store 渲染 DOM；prompt 预填与 kb chips 经会话输入通道走，发送时变成普通 session events，UI 自身从不触碰缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本包不尝试做什么。它们是当前约束，不是任务清单。

- **仅 Web 平台** — bundle 面向 web 客户端平台；没有桌面变体。
- **渲染服务器状态** — 队列与档案经本地 webserver 镜像引擎；引擎不可达时侧栏只显示错误，仅此而已。
- **端口靠断言，不改上游** — 任务创建与标签页打开经本包内部断言的结构化端口；上游契约零改动，因此上游变更可能使断言静默失效。
- **绑定依赖 localStorage** — 待办↔会话绑定与已完成回执存在浏览器里；清站点数据会遗忘它们，引擎历史仍在。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

文件行级上传 slot `sidebar.files.entry.action` 是企业 deviation，与上游的 header-action slot 并存；动它之前先看仓库 AGENTS.md 的 merge-preserve notes。不发布运行时不变量伴随导出：UI 只渲染 store 状态并注册 slots，没有会与组件测试分叉的独立维护观测。此处无未决工作。

</details>
