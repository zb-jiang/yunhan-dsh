---
description: "platform-user 缝的 Web Console provider：JWKS 本地验 JWT + 用调用者自己的 token 自读 /api/users/me。"
kind: "package-reference"
---

# @deepseek-ai/dsh-platform-user-console

[English](README.md) | 中文

## 概述

`dsh-platform-user-console` 是 platform-user 缝的 Web Console provider：注册进 `ctx.platformUsers`，用 JWKS 本地验证调用者的认证中心 JWT，再携带调用者自己的 bearer token 从 Web Console 后端（`GET /api/users/me`）读取该用户的治理记录。它与按认证方式解析 provider 的 dsh-platform-user 配对，自身不持有服务密钥——每次读取都是用户本人的身份。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件注册进 webserver 位于企业 Web 客户端之后的 profile。插件契约：

- `inject = ['platformUsers']`
- `Config` — 五个字段全部必填、volatile，由 enterprise-app patch 用环境变量（`SSO_*`、`WEB_CONSOLE_URL`）填充
  - `provider` — 认证中心类型：`supabase / casdoor / customer-oidc`
  - `supabaseUrl` — Supabase 项目 URL；supabase 模式下唯一作用是 `issuer` 为空时推导 issuer（`<url>/auth/v1`）
  - `issuer` — 认证中心 issuer URL；非 supabase 提供方必须非空；解析结果为空（尚未配置任何坐标）时挂载「未配置」provider，拒绝所有请求
  - `jwksUrl` — JWKS 端点；为空时按 `<issuer>/.well-known/jwks.json` 推导
  - `webConsoleBaseUrl` — 服务 `GET /api/users/me` 的 Web Console 后端基地址
- `apply(ctx, config)` — 解析配置（非法值加载期失败）、挂载 provider，并在每次 `loader/volatile-update` 时重挂载；volatile 更新携带非法值时沿用旧 provider

dsh-platform-user 按认证方式解析已注册的 provider，因此没有其他包直接 import 本包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### 自读契约

provider 假定 Web Console 的 `GET /api/users/me` 端点返回 `ApiResponse` 信封（`{ success, data, error }`），其 `data` 为 camelCase 治理记录（`id`、`authSubject`、`loginName`、`displayName`、`email`、`status`、`platformRoles`、`createdAt` 及可选的审批/禁用/锁定留痕字段）。未知字段（如 `orgUnits`）被忽略。不发布运行时不变量伴随导出：本 provider 是薄传输适配器，本地验证 JWT 后每个请求读取一个后端端点，没有可检查的持久关系。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-platform-user](../platform-user/README.zh.md) — 本 provider 注册进的能力缝。
- [部署架构](../../../docs/plans/dsh_enterprise_architecture_v5.html) — web console 后端在 v5 拓扑中的位置。

-----

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：本包是只读的治理身份 provider；不注册任何模型可见内容。

#### KV Cache 影响

JWT 验证与 `/api/users/me` 自读发生在解析请求身份的阶段，先于任何模型上下文组装；provider 不向 prompt 或缓存前缀贡献任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本包不尝试做什么。它们是当前约束，不是任务清单。

- **待审批用户读到 `pending_approval`** — seam 值保留后端状态；由消费方决定待审批用户能否继续操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本 provider 从 `GET /api/users/me` 读取的 `ApiResponse` 信封与 camelCase 治理记录字段是同 web-console 后端（`apps/web-console`）的契约；字段改名必须两侧同步。provider 在 `apply` 中按解析后的 issuer（显式 `issuer`，或 supabase 模式下从 `supabaseUrl` 推导）挂载，并在每次成功的 `loader/volatile-update` 时重挂载；解析结果为空时挂载「未配置」provider，拒绝请求直到真实坐标到达。此处无未竟工作。

</details>
