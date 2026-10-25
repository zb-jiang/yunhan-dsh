---
description: "企业会话知识库上下文：客户端上报的会话-应用绑定 + 每回合模型可见的知识库块。"
kind: "package-reference"
---

# @deepseek-ai/dsh-kb-context

[English](README.md) | 中文

## 概述

`dsh-kb-context` 让企业任务会话无需 '@' 插入即可获得所属应用的知识库：客户端上报每个会话所属的应用，插件在每回合 step 1 注入一条模型可见的 `<knowledge_base>` 块，携带该应用的 kb id 与名称，助手因此可以直接调用 `kb_search` / `kb_list` / `kb_read`。没有上报的会话——普通对话、未开通知识库的应用、已解除的绑定——不注入任何内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把插件注册进员工端 harness profile；客户端侧是 `@deepseek-ai/dsh-ui-enterprise`，经本地 webserver 上报绑定。已上报应用且知识库解析成功的会话，每回合注入一条持久块：

```text
<knowledge_base>
本会话所属应用的知识库：
kbId: <id>
名称：<name>
检索用 kb_search(kbId, query)，浏览清单用 kb_list(kbId)，读取全文用 kb_read(docId)；用户以 '@' 插入的知识库文档即来自此库。
此归属由系统注入并保持最新，仅供企业知识库检索使用。
</knowledge_base>
```

上报通道：`POST /api/enterprise/kb/session-context`（本地 webserver 的 exact 路由），携带员工 JWT 与 `{ "entries": [{ "sessionId": "...", "applicationId": "..." | null }] }`。客户端在新绑定时上报、任务列表刷新后重放持久绑定、完成解绑时上报 `null`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `webConsoleBaseUrl` | volatile string | web-console 基地址（协议+主机，无路径）；用于按应用解析知识库。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### 上报映射是内存 + 重放兜底

会话到应用的映射存在内存里；webserver 重启后由客户端下一次重放自愈，不新增持久存储。

### 伪造上报无法越权

知识库解析始终以当前登录员工的 JWT 调 web-console 按应用接口，非成员得到 404 → 不注入。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-knowledge](../knowledge/README.zh.md) — 注入块所指向的知识库工具。
- [企业组 README](../README.zh.md) — 周边企业包集合。

-----

<a id="model-experience"></a>
## 模型体验

### 会话知识库块

#### 模型看到什么

每回合 step 1，已上报应用且知识库解析成功的会话携带一条持久 `<knowledge_base>` 块，写明该应用的 `kbId`、显示名称，以及哪个工具负责什么用途（`kb_search`、`kb_list`、`kb_read`）。

#### Token 影响

每回合一条固定块——几十个 token——无论模型是否调用知识库工具；没有上报的会话不注入任何内容。

#### KV Cache 影响

块注入在固定位置（开放 step 内、`request/header` 之前），文本在会话生命周期内稳定，因此跨回合都位于缓存前缀之内。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本包不尝试做什么。它们是当前约束，不是任务清单。

- **内存态上报映射** — 会话到应用的映射存在 webserver 内存里；重启后块会缺失，直到客户端下一次重放。
- **每应用一个知识库** — 解析只返回该应用唯一的知识库；一个应用多个知识库没有表达方式。
- **静默降级** — web-console 不可达或非成员上报都解析为无块，且无用户可见错误；会话照常运行，只是没有知识库上下文。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`src/text.ts` 的 `renderKbContextText` 拥有块的逐字措辞。上报路由 `/api/enterprise/kb/session-context` 与客户端上报方 `@deepseek-ai/dsh-ui-enterprise` 共用；改名必须两侧同步。此处无未竟工作。

</details>
