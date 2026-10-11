---
description: "平台用户治理缝（ctx.platformUsers），负责企业账号审批、角色与状态管理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-platform-user

[English](README.md) | 中文

## 概述

`dsh-platform-user` 是平台用户治理 Service Definition（`ctx.platformUsers`）：叠加在外部身份后端（如 Supabase Auth）之上的 Harness 侧记录。覆盖待审批注册、平台角色分配、按 auth subject 查询、管理员禁用/锁定/恢复。provider 经 `registerProvider` 挂载；seam 会在调用 provider 之前校验角色名、拒绝重复角色并拒绝非法状态迁移。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

从 provider 包（挂载后端适配器）或读取、管理治理记录的 consumer 处消费 `ctx.platformUsers`。Service API：

- `registerProvider(provider)`：挂载唯一活动 provider。重复 provider 会以 `PlatformUserError` 代码 `DUPLICATE_PROVIDER` 失败。
- `registerPendingUser(request)`：在外部身份后端创建 subject 之后，创建一条待审批治理记录。
- `getById(id)` / `getByAuthSubject(authSubject)`：读取单条记录。
- `list({ statuses?, role? })`：列出匹配记录。
- `approve(id, { approvedBy, platformRoles })`：只允许审批 `pending_approval` 用户，并写入初始平台角色集。
- `setRoles(id, { changedBy, platformRoles })`：整体替换现有用户的平台角色集。
- `disable(id, { disabledBy, reason? })` / `lock(id, { lockedBy, reason? })`：管理员状态变更。
- `restore(id, { restoredBy })`：把 `disabled` 或 `locked` 用户恢复到 `active`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### provider 之前的校验

seam 会在调用 provider 之前校验角色名、拒绝重复角色并拒绝非法状态迁移，畸形请求永远到不了后端适配器。

### 无运行时不变量伴随导出

不发布运行时不变量伴随导出：seam 拥有唯一 provider 槽位和单一读取入口，在 provider 承载的记录之外没有独立事件流或可检查的持久关系；provider 之前的校验与被行为测试直接覆盖的校验在同一模块内。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-platform-user-console](../platform-user-console/README.zh.md) — 挂进本缝的 Web Console provider。
- [内部通行证 SSO 设计](../../../docs/plans/2026-09-29-internal-pass-sso-design.md) — 本缝服务的 Supabase 身份模型。

-----

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：本包是治理记录缝；不注册任何模型可见内容。

#### KV Cache 影响

治理调用发生在 webserver 请求处理里，在 prompt 组装之外；本缝返回的记录从不进入 prompt 或缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本包不尝试做什么。它们是当前约束，不是任务清单。

- **尚无认证会话 seam**：本包只治理 Harness 侧用户记录；登录、令牌刷新、密码重置和 SSO 握手仍留在外部身份后端及后续 consumer 包中。
- **尚无内置审计流**：这条 seam 直接返回更新后的记录；后续的 consumer 或 companion 包应补充持久化治理审计事件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`platform-user/verified` 与 `platform-user/signout` 事件名是三方契约：在本包 `src/index.ts` 声明、由 `dsh-platform-user-api` 发射、由 `dsh-user-identity-context` 消费，改名必须三侧同步。`PlatformUserError` 错误码与状态迁移校验也在同一 `src/index.ts`，且先于任何 provider 调用执行，provider 永远看不到畸形记录。此处无未竟工作。

</details>
