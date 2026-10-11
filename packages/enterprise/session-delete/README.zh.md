---
description: "永久删除一个已归档会话的 HTTP 端点（JSONL 工件目录 + pending 登记 + 投影缓存记录 + workspace 注册表记账）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-delete

[English](README.md) | 中文

## 概述

`dsh-session-delete` 向本地 webserver 添加一条路由：`POST /api/enterprise/sessions/delete` 永久删除一个已归档会话。归档成员身份是安全闸门，已归档会话没有进行中的写入。端点丢弃进程内的 pending 登记、删除 JSONL 工件目录与投影缓存记录、把 id 从每个 workspace 摘除、取消归档，并补发 `api-session/removed` 事件让已连接客户端立即移除列表行。写句柄仍持有该 id 时，端点在触碰磁盘之前以 409 拒绝；工件缺失时跳过目录删除，重试即收敛。无配置，不注册任何模型可见内容。

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

把本包挂载到任何运行本地 webserver 且使用 JSONL 会话持久化与 workspace 注册表的 profile 上；删除触点即位于 `POST /api/enterprise/sessions/delete`。插件自身不声明任何配置 —— 它从挂载的持久化后端探测持久化根目录，无需指定存储位置。调用方是管理界面（企业工作台的已归档会话列表）；该路由不属于任何 agent 会话流程。

### 端点的行为

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `/api/enterprise/sessions/delete` | 请求体 `{ "sessionId": "<id>" }`；丢弃该已归档会话的进程内 pending 登记、删除其 JSONL 工件目录与投影缓存记录、把 id 从每个 workspace 摘除、移出归档集、补发 `api-session/removed` 让已连接客户端立即移除列表条目，应答 `{ deleted: "<id>" }` |

失败以 JSON 错误返回，每种原因对应一个状态码：

| 状态码 | 含义 |
|---|---|
| 400 | 请求体缺失、非法、超过 64KB，或 `sessionId` 不是非空字符串 |
| 405 | 方法不是 POST |
| 409 | 会话未归档；或写句柄仍持有该 id（`code: "session-in-use"`）—— 重启应用后重试 |
| 500 | 持久化后端未暴露 JSONL 根目录，或解析出的目录逃逸出根目录 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### 归档成员身份是删除闸门

删除要求 id 位于注册表的归档集内（[src/index.ts](src/index.ts)）。归档闸门挡住所有 `agent/pre-step` 唤醒，非强制归档会拒绝活跃会话，因此「已归档」恰好是没有进行中写入还能触碰工件的条件。其余情况一律应答 409。

### 先清 pending 登记，再删工件，最后清记账

删除顺序：先丢弃本进程的「已创建未落盘」登记 —— 写句柄仍持有该 id 时在此处以 409 拒绝、磁盘不动，因为残留句柄的后续写入可能重建已删工件（幽灵会话失效模式）；随后移除 JSONL 目录、丢弃会话的投影缓存记录，再把 id 从每个 workspace 的记账清单摘除，最后从注册表全局归档集移除。未落盘的已创建会话在磁盘上没有工件：它的全部存在就是 JSONL 后端进程内的 pending 登记与会话创建时写入的投影缓存检查点，跳过任何一处清理都会让 id 永远留在清单里。持久化里找不到 snapshot（工件已被外部删除）或目录缺失时跳过目录删除、直接清记账，因此失败或中断的删除在重试时必然收敛。在执行 `rm` 前有一道容器检查，确保被删目录位于持久化根目录之内。

### 根目录靠探测，不靠配置

插件不复制任何存储配置：它从挂载的持久化后端自己的配置读取根目录；非 JSONL 后端直接应答 500，而非猜测目录布局。

### 冷删除经 `api-session/removed` 自我宣告

客户端会话列表 store 的增量移除只走 `api-session/removed` 这一个 Remote 事件，其余一切经由有序 baseline 到达。Host 只在 live 会话被处置时发这个事件，而冷删除的会话没有 live 生命周期 —— 没有任何别的环节会宣告它的消失。因此端点在全部清理步骤成功之后自己补发该事件，让已连接客户端立即移除条目，而不是继续端出一个死条目（点击会应答 `session/not-found`）直到下次重启重建 baseline。拒绝路径（409、500）从不补发：磁盘状态仍然支撑着那个条目。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业组 README](../README.zh.md) — 同组企业包及两个 profile 如何组合它们。
- [部署架构](../../../docs/plans/dsh_enterprise_architecture_v5.html) — 本地 webserver 在 v5 拓扑中的位置。

-----

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：本包是已归档会话的工件删除；不注册任何模型可见内容。

#### KV Cache 影响

删除发生在会话已经结束之后；端点触碰的是工件文件与注册表记账，从不触碰活跃的模型上下文，因此任何缓存的会话前缀都不会改变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事。它们是当前约束，不是任务清单。

- **只删已归档会话** — 路由拒绝注册表未归档的任何会话（409）；删除活跃或仅关闭的会话在设计上不在范围内。
- **写句柄活跃时阻塞删除** — 先前对话遗留的 live agent 会持有写句柄直到进程退出；此时删除应答 409（`code: "session-in-use"`），需重启应用释放句柄。在进程内终结 agent 需要 agent 注册表提供按 id dispose 的 seam，列为延期工作。
- **仅支持 JSONL 后端** — 非 JSONL 持久化后端直接应答 500，而非猜测目录布局。
- **靠重试收敛** — 若在删工件与写记账之间崩溃，id 会保留在清单中直到重试；下一次调用跳过目录删除（目录缺失或 snapshot 缺失）并收敛。
- **无法恢复** — 删除是永久的；没有回收站、软删除或恢复路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

删除顺序是注册表自身归档流程的逆序；若那里的 unarchive 语义变化，这里的顺序随之变化。此处无未竟工作。

</details>
