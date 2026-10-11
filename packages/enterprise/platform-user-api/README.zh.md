---
description: "platform-user 认证的 HTTP API 路由（/auth/me、/auth/config）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-platform-user-api

[English](README.md) | 中文

## 概述

`dsh-platform-user-api` 通过本地 webserver 暴露员工侧认证触点：`GET /api/enterprise/auth/me` 验证 Supabase JWT 并发布 `platform-user/verified`，`POST /signout` 发布 `platform-user/signout`，`GET /config` 把 Supabase URL 与 anon key 交给浏览器，`POST /connectivity-check` 在浏览器无法探测时从 Node 侧探测服务地址。插件本身不持有状态；身份缓存消费者订阅事件。

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

在 enterprise profile 上把本包用作登录集成点：浏览器登录流程通过 `/me` 自证，设置面板读取 `/config` 并经 `/connectivity-check` 探测目标，登出触点通知本地缓存丢弃身份。治理写操作（注册、审批、禁用、锁定、恢复、角色、审计）在 web-console 后端，不在这里。

### 最小配置

两个字段均为必填且无默认值：缺任一字段的组合在加载时失败。它们正是浏览器直连 Supabase Auth 所需的 Supabase 项目坐标。

```yaml
- name: '@deepseek-ai/dsh-platform-user-api'
  config:
    supabaseUrl: 'https://your-project.supabase.co'
    supabaseAnonKey: 'your-anon-key'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `supabaseUrl` | 必填 | Supabase 项目 URL；volatile — 设置面板可不重载修改 |
| `supabaseAnonKey` | 必填 | 浏览器侧 Supabase Auth 使用的 anon key；volatile |

### 各端点的行为

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/enterprise/auth/me` | 验证 `Authorization: Bearer` JWT，返回用户记录，携带原始 token 发布 `platform-user/verified` |
| POST | `/api/enterprise/auth/signout` | 发布 `platform-user/signout`，应答 204 |
| GET | `/api/enterprise/auth/config` | 每次请求现读返回 `{ url, anonKey }` |
| POST | `/api/enterprise/auth/connectivity-check` | 从 Node 探测 URL（任意 HTTP 状态都算可达），5 秒超时 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### 事件而非状态

插件不保留身份状态（[src/index.ts](src/index.ts)）：一次通过验证的 `/me` 调用会发布携带原始 access token 的 `platform-user/verified` —— 身份缓存、skill 同步等消费者随后以登录员工身份对接服务端 API —— 登出触点发布 `platform-user/signout`。在客户端调用 `/me` 之前，订阅者不会得知登录。

### 为什么 connectivity-check 在 Node 侧运行

引擎、web-console、SkillHub 端点都不开 CORS，浏览器侧探测会把配置正确的服务器误报为不可达。因此该端点从 Node 发起 fetch：任意 HTTP 状态都意味着「主机有应答」；只接受 http/https URL。

### 为什么 anon key 不标记为 secret

标记为 secret 类型的配置字段一经 wire 读取即永久打码，设置面板将永远无法回显。anon key 本就是公开设计；面板在自身 UI 中打码，且 webserver 只绑定 localhost。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业组 README](../README.zh.md) — 同组企业包及两个 profile 如何组合它们。
- [内部通行证 SSO 设计](../../../docs/plans/2026-09-29-internal-pass-sso-design.md) — 这些端点服务的基于 Supabase 的身份模型。

-----

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：这些是认证端点与配置投影；不注册任何模型可见内容。

#### KV Cache 影响

登录与登出改变后续请求携带的身份，而非模型上下文；这里没有任何逻辑触碰缓存的会话前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事。它们是当前约束，不是任务清单。

- **事件只在 API 调用时发布** — `platform-user/verified` 在客户端请求 `/me` 时发布；没有来自 Supabase 的推送通道，从不调用这些端点的组件永远看不到登录。
- **只读投影** — 这些端点不暴露治理写路径；注册、审批、禁用、锁定与角色都在 web-console。
- **探测只是普通 GET** — connectivity-check 把任意 HTTP 状态（包括错误页）都算作可达；它回答「主机在不在」，不回答「服务健不健康」。
- **未认证的配置面** — `/config` 不做认证就交出 Supabase 坐标；在 webserver 只绑 localhost 的前提下安全，若这一点改变则不安全。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

身份验证本身（JWT 校验、用户查询、状态检查）由 dsh-platform-user 负责；本包只是路由管道加两个事件触点。不发布运行时不变量伴随导出：路由只是 platform-user 校验之上的薄管道，行为由本包端点测试直接覆盖。此处无未竟工作。

</details>
