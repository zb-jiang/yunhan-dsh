---
description: "叠在 dsh-web-app 之上的企业平台用户认证 bundle：只读平台用户缝、员工待办工作台代理与企业客户端面，面向 dsh web profile 的企业部署。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-enterprise-app`

[English](README.md) | 中文

## 概述

企业 profile bundle，作为叠在 [`dsh-web-app`](../web-app/README.zh.md) 之上的 patch 层，随 `enterprise` profile 交付（`dsh --profile enterprise`）。本包是静态 patch 清单载体，自身没有运行时 API：插入平台用户缝及其 Web-Console 后端 provider、浏览器侧 `/auth` 路由、flowable-engine 任务代理、企业 skill 分发、知识库工具、流程发起工具与企业 client-UI 行，并把目录选择交互 pin 到应用内 browse 表面。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用 `dsh --profile enterprise` 启动员工端；组合为 [`dsh-base`](../base/README.zh.md) + `dsh-web-app` + 本 bundle，本 patch 在 web-app 之后应用。部署端点来自加载时读取的环境变量：认证配置用 `SUPABASE_URL`/`SUPABASE_ANON_KEY`，治理服务用 `WEB_CONSOLE_URL`，流程引擎用 `FLOWABLE_ENGINE_URL`，另有 `SKILLHUB_*`、`DSH_LOG_LEVEL`、`KB_READ_MAX_CHARS`、`SKILL_SYNC_INTERVAL_MS` 配置项。

| 插入行 | 职责 |
|---|---|
| `logger-console` | stdout 日志 exporter，让 headless webserver 进程的控制台可见 `ctx.logger` |
| `platform-user` | 只读的 `ctx.platformUsers` 服务 |
| `platform-user-console` | JWKS 本地验 JWT，经 web-console 读 `/api/users/me` 自身记录 |
| `platform-user-api` | 浏览器侧 `/api/enterprise/auth` 路由（`/auth/me`、`/auth/config`） |
| `user-identity-context` | 维护 `ctx.currentUser`，并注入每轮身份展示块 |
| `flowable-task-proxy` | `/dsh/tasks`、`/dsh/history` 代理至 flowable-engine |
| `skill-sync` | 周期 daemon，预装 SkillHub 要求的 skill |
| `knowledge` | `/api/enterprise/kb` 代理，加 `kb_search`/`kb_read`/`kb_list` 工具 |
| `process-start` | `dsh_process_list`/`dsh_process_start_form`/`dsh_process_start` 工具 |
| `pocket-access` | 配对与同账号双闸门之后的手机访问 LAN 代理 |
| `directory-picker-browse` + `ui-directory-picker-browse` | pin 应用内目录浏览器替代 boot 解析的 picker，让 Pocket Access 手机在页面内选工作区目录，而不是在宿主屏幕上弹出对话框 |
| `directory-picker`（禁用） | web-app 的 `-auto` 行，boot 时无法区分手机与本地显示器；由上方 browse 两行替代 |
| `ui-enterprise` | 企业 client-UI 分支（布局、待办工作台） |

部署通过环境变量或 profile 级 patch 修改端点。patch 替换目标行的整个 `config`，因此覆盖 patch 必须重述其拥有的每个键。

<a id="model-experience"></a>
## 模型体验

### 员工身份上下文

#### 模型看到什么

平台用户缝解析出已认证用户后，`user-identity-context` 在每轮第一个 step 发布一个身份块：展示身份与 web-console 组织属性（单位、角色）。该块仅为展示上下文；待办与审批仍归引擎所有。

#### Token 影响

每个会话一个稳定大小的身份块，加上 web-app 的表面段落。

#### KV Cache 影响

身份块位于 turn 专属前缀中，登录员工不同则该前缀不同；同一员工的会话内保持稳定。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **外部服务必须可达** — web-console 与 flowable-engine 的 URL 是部署配置；表面可以在它们离线时启动，但工作台功能在服务应答前不可用。
- **patch 顺序固定** — 本 bundle 在 `dsh-web-app` 之后应用；手工搭建且省略 web-app 的树会丢失本 patch 未重述的行。
- **配置修改需重启** — patch 行仅在启动时生效；环境变量变更在下一个进程生效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布运行时不变量伴随导出：本包是静态 patch 清单载体，没有需要审计的可变状态。
