---
description: "dsh backend-profile 组合包：基于 dsh-base 的服务器端无人值守 backend task 运行器（webserver + backend-task 插件；无浏览器 UI）。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-enterprise-backend

[English](README.md) | 中文

## 概述

`dsh-enterprise-backend` 是 backend-profile 组合包：一份 patch 清单，把 `dsh --profile enterprise-backend` 变成服务器端无人值守的 backend task 运行器。patch 挂载四个插件 —— 控制台日志、HTTP webserver（默认端口 3190）、带注册/心跳与 skill 同步 daemon 的 dsh-backend-task、以及提供 `kb_*` 工具的 knowledge 插件 —— 除此之外什么都没有：无浏览器 UI，也无员工侧插件。所有取值都来自环境变量，实例在启动时配置，而非写在 yml 里。

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

每个 backend profile 启动一个实例。每个实例在自己的工作目录（任务工作空间）启动，从常规设置/环境面取 LLM 凭据，并且必须能让 flowable-engine 与 web-console 通过 `DSH_BACKEND_URL` 访问到。组合包是单个依赖，其 `dsh.bundle.patch` 指针携带整个组合；没有任何运行时 API 可调用。

### patch 挂载了什么

| 行 | 包 | 角色 |
|---|---|---|
| `logger-console` | @deepseek-ai/cordis-plugin-logger-console | 常驻进程的 stdout 日志导出器；levels 必须显式声明，省略会静默丢弃 warn |
| `webserver` | @deepseek-ai/dsh-host-webserver | 默认绑定 `127.0.0.1:3190` 的 HTTP 服务 —— v5 部署下引擎、控制台与本服务同机；跨主机调用时把 `DSH_BACKEND_HOST` 设为本机具体地址（webserver 配置校验拒绝 wildcard 地址） |
| `backend-task` | @deepseek-ai/dsh-backend-task | REST 任务端点 + 注册/心跳与 skill 同步 daemon |
| `knowledge` | @deepseek-ai/dsh-knowledge | 经 web-console 服务密钥端点的 `kb_*` 工具；每个任务 payload 携带 `kbId` |

### 环境变量

| 环境变量 | 默认值 | 供给 |
|---|---|---|
| `DSH_LOG_LEVEL` | `3` | logger-console 级别 |
| `DSH_BACKEND_HOST` | `127.0.0.1` | webserver 主机；跨主机部署设为本机具体 IPv4/IPv6 地址 |
| `DSH_BACKEND_PORT` | `3190` | webserver 端口 |
| `WEB_CONSOLE_URL` | `http://127.0.0.1:8080` | backend-task 与 knowledge 的 web-console 基地址 |
| `DSH_BACKEND_URL` | `http://127.0.0.1:3190` | backend-task selfUrl —— 必须是 flowable-engine 与 web-console 能访问到的地址 |
| `DSH_BACKEND_NAME` | `backend-1` | 注册名 |
| `SKILLHUB_URL` | `http://127.0.0.1:8095` | backend-task 的 SkillHub 基地址 |
| `SKILLHUB_API_TOKEN` | 空 | backend-task 的 SkillHub token |
| `DSH_BACKEND_SYNC_INTERVAL_MS` | `300000` | skill 同步间隔 |
| `DSH_BACKEND_REGISTER_INTERVAL_MS` | `60000` | 心跳间隔 |
| `DSH_SERVICE_KEY` | 空 | knowledge 服务密钥 —— 必须与 web-console `dsh.service-key`、flowable-engine `dsh.web-console.service-key` 一致 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### 静态 patch 清单载体

包不提供任何运行时 API（[src/index.ts](src/index.ts) 什么也不导出）：全部行为在被插入行的包里。组合包的存在让一个 profile 就是一个依赖加一个 patch 指针，四行一起版本化、一起评审。

### 环境变量，而非 yml 配置

每个值都在 patch 加载时以 `!!js process.env` 读取（[cordis.patch.yml](cordis.patch.yml)）。默认值假设引擎、控制台与本实例同机共用 `127.0.0.1`；跨主机部署覆盖 `WEB_CONSOLE_URL` 与 `DSH_BACKEND_URL`。

### 组合包刻意省略了什么

无浏览器 UI、无员工侧插件、无身份块：运行器不持有登录身份。knowledge 用服务密钥访问 web-console，skill 同步用只读分发 token，因此无人值守运行从不需要登录员工。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [DSH backend task 设计](../../../docs/plans/2026-09-14-dsh-backend-task-design.md) — 本组合包所组合的任务模型与 backend profile。
- [企业组 README](../../enterprise/README.zh.md) — 运行器侧协作的 enterprise 包。

-----

<a id="model-experience"></a>
## 模型体验

无直接模型上下文贡献：经由 patch 清单插入的包；每行各自的包负责自己的模型可见行为。

#### KV Cache 影响

组合包自身不添加任何 prompt、工具或事件；到达模型的内容都来自被插入插件的契约，因此本包从不触碰会话前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事。它们是当前约束，不是任务清单。

- **没有运行时面** — 包什么也不导出；改组合行为只能改被插入的插件或 patch 文件。
- **构造上无人值守** — 无身份块、无员工侧插件；实例只服务 backend task。
- **环境变量加载时读取** — 值在 patch 加载时固定；改环境变量意味着重启实例。
- **本机默认值** — 内置 URL 假设引擎、控制台与 SkillHub 都在 `127.0.0.1`；跨主机部署必须覆盖，否则各 daemon 指向空处。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

不发布运行时不变量伴随导出：本包是静态 patch 清单载体，没有需要审计的可变状态。此处无未竟工作。

</details>
