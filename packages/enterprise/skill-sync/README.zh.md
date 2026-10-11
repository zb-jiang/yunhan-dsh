---
description: "企业 skill 分发：对 flowable-engine 周期扫描所需 skill，从 SkillHub 下载到专用缓存根目录，并注入 ctx.skills。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-sync

[English](README.md) | 中文

## 概述

`dsh-skill-sync` 负责员工的 enterprise skill 安装：daemon 周期性询问 flowable-engine 当前登录员工的待办需要哪些 skill，拉取每个 SkillHub 命名空间清单，把缺失或过期的包下载到专用缓存根目录，并注册 filesystem provider 让 `ctx.skills` 提供它们。登录事件或 `POST /api/enterprise/skills/ensure` 端点也能触发一轮同步；端点以仍缺失的名字作答，让 UI 走降级继续而非阻塞会话。每次失败都记日志并在下一轮重试；没有任何环节阻塞启动。

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

把本包挂载到 enterprise profile 上、与身份块并列：daemon 的每个请求都以登录员工的 JWT 签名，它发布的缓存根目录位于本实例的家目录下。`ensure` 端点是待办打开触点 —— web UI 在创建会话前把任务的 `dshMeta.skillRefs` 发过来，读取 `missing` 决定是否展示降级继续提示。

### 最小配置

四个 volatile 字段在 cordis.yml 中必填，但空字符串是合法的「尚未配置」状态：登录页是首次配置入口，值经 volatile 更新到达之前各轮跳过并告警。

```yaml
- name: '@deepseek-ai/dsh-skill-sync'
  config:
    flowableBaseUrl: 'http://flowable-engine:8090'
    skillhubBaseUrl: 'https://skillhub.example.com'
    skillhubToken: 'read-only-token'
    intervalMs: 300000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `flowableBaseUrl` | 必填 | flowable-engine 基地址（协议 + 主机 + 端口）；volatile — 设置面板可不重载修改 |
| `skillhubBaseUrl` | 必填 | SkillHub 后端 API 基地址；volatile |
| `skillhubToken` | 必填 | SkillHub 只读分发 token；空字符串跳过清单与下载环节；volatile |
| `intervalMs` | 必填 | daemon 扫描间隔毫秒；volatile — 变更即重排定时器 |
| `skillDir` | `$DSH_HOME/skill-sync/skills` | 缓存根目录覆盖 |

### 各端点的行为

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `/api/enterprise/skills/ensure` | 请求体 `{ names: [...] }` 为 skill 裸名数组；任一名字不在缓存根目录时立即执行一轮同步，然后以仍不可用的名字应答 `{ missing: [...] }` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### 只在有人登录时干活的 daemon

每轮读取员工的 token（[src/index.ts](src/index.ts)）：无 token 跳过本轮，token 过期（401）同样跳过并在重新认证后的下一轮自动恢复，登录事件（`platform-user/verified`）触发即时一轮，用户不必等间隔。并发触发 —— daemon、登录、端点 —— 合并为同一轮。

### 指纹差分，原子安装

`state.json` 把每个已装 skill 映射到其命名空间与指纹。一轮只拉一次命名空间清单，比对指纹，仅重装缺失或过期的 skill：下载 zip、对每个条目做容器检查（绝对路径与 `..` 段拒绝整个安装）、解压到临时目录、原子改名到位、随后失效 skill 注册表缓存，让下一次渲染看到新内容。

### 降级，绝不阻塞

每类失败 —— 引擎不可达、清单失败、zip 损坏 —— 都记日志留给下一轮。启动不等首轮结果，`ensure` 报告缺失名字而非失败，这正是待办 UI 能带提示继续的原因。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业组 README](../README.zh.md) — 同组企业包及两个 profile 如何组合它们。

-----

<a id="model-experience"></a>
## 模型体验

无直接模型上下文贡献：经由缓存根目录的 skill provider，模型渲染委托给 dsh-tool-skill。

#### KV Cache 影响

安装与失效改变未来会话加载 skill 时的渲染内容；provider 自身不存储任何会话内容，因此没有缓存前缀会改变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事。它们是当前约束，不是任务清单。

- **仅登录后干活** — 无 token 或 401 时各轮静默跳过；未登录的机器什么都不同步。
- **命名空间必填** — 缺 namespace 的所需 skill 带警告跳过；flowable 侧必须把流程定义映射到应用，分发才能到达它。
- **指纹即信任** — 指纹与 `state.json` 一致且目录存在即视为已安装；目录内部的内容损坏不会被检测。
- **没有卸载** — 移出所需清单的 skill 留在缓存根目录并被继续提供，直到手工清空目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`fetchSkillhubManifest` 与 `installSkillZip` 导出供 dsh-backend-task 复用：后者的同步源不同，但 SkillHub 清单与下载协议是同一套。这两个函数的改动必须同时保住两个调用方。不发布运行时不变量伴随导出：扫描、下载与注入行为由本包行为测试直接覆盖，没有会分叉的独立维护观测。此处无未竟工作。

</details>
