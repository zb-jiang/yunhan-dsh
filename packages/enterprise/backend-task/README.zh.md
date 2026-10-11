---
description: "服务器端无人值守 DSH backend task 运行器：经 webserver 提供 REST 提交/轮询端点，每个任务一个非交互 Agent 会话，另有注册心跳与 skill 同步 daemon 对接 web-console。"
kind: "package-reference"
---

# @deepseek-ai/dsh-backend-task

[English](README.md) | 中文

## 概述

`dsh-backend-task` 是 BPMN 画布上 DSH backend task 节点的服务器端运行器。flowable delegate 把每个节点插值后的 prompt、skill 引用与可选知识库 POST 到 `POST /api/backend/tasks`；本包为每个任务运行一个独立的非交互 Agent 会话，把最终 assistant 文本解析为 JSON，并在 `GET /api/backend/tasks/{taskId}` 上以 running、ready 或 failed 应答轮询。两个 daemon 负责向 web-console 注册本实例并把聚合的 skill 安装到本地。

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

在 enterprise-backend profile 上使用本包：一个常驻服务器实例，无人参与地执行 DSH backend task 节点。flowable-engine 的 `DshBackendTaskDelegate` 是唯一的目标调用方——它提交并轮询；这里不需要浏览器也不需要登录员工。

### 最小配置

全部字段来自 enterprise-backend profile 的 cordis.yml。`selfUrl` 是 delegate 访问本实例的地址，同时充当注册表键；`skillhubToken` 是 SkillHub 只读分发 token（空串跳过清单与下载，仅靠已装缓存）。

```yaml
- name: '@deepseek-ai/dsh-backend-task'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
    selfUrl: 'http://backend-1:3190'
    backendName: 'backend-1'
    skillhubBaseUrl: 'http://skillhub:8095'
    skillhubToken: 'read-token'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `webConsoleBaseUrl` | `http://127.0.0.1:8080` | web-console 基地址（注册心跳与 skill 归属拉取目标） |
| `selfUrl` | `http://127.0.0.1:3190` | 本实例对外可达 URL（delegate 提交目标、注册表键） |
| `backendName` | `backend-1` | 注册表与设计器下拉中的展示名 |
| `skillhubBaseUrl` | `http://127.0.0.1:8095` | SkillHub 后端 API 基地址 |
| `skillhubToken` | `''` | SkillHub 只读 token；空串跳过清单与下载 |
| `syncIntervalMs` | `300000` | skill 同步 daemon 间隔 |
| `registerIntervalMs` | `60000` | 注册心跳间隔 |
| `skillDir` | `$DSH_HOME/backend-task/skills` | skill 缓存目录覆盖 |

### 各端点的行为

`POST /api/backend/tasks` 携带 `{ prompt, skillRefs?, kbId?, kbName? }` 返回 `202 { taskId }`；`kbId`/`kbName` 携带流程所属应用的知识库（应用没有知识库或解析降级时两字段都不出现）。`GET /api/backend/tasks/{taskId}` 返回 `{ taskId, status, result?, error? }`——`status` 从 running 进入 ready（携带解析后的 JSON `result`）或 failed（携带可读 `error`）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指出对应代码；可观察行为见[使用本包](#use-this-package)。

### 每个任务一个非交互会话

每个任务创建全新 Agent 会话（[src/index.ts](src/index.ts) 的 `runBackendTask`）：可选的 KB 上下文块（与员工端同一格式）、skill 引用前缀、然后节点 prompt，作为一条用户消息发出，会话跑到静默。最后一条 assistant 文本从首个 `{` 扫描到末个 `}` 并解析为结果。

### 两个 daemon 维持实例集成

心跳每 60 秒向 web-console 注册本实例（失败记日志，下一轮重试）。skill 同步拉取归属本实例 URL 的 skill 引用聚合，按指纹增量地从 SkillHub 安装新增或变更的 skill 到缓存目录，有任何变更后失效 skill 注册表。

### 失败是一种状态，不是崩溃

turn 错误、不可用的输出或意外异常都会把任务结算为 failed 并附可读消息；delegate 的重试周期把它当正常结果处理。任务状态按设计是进程内存 map（已接受的约束）：重启丢失运行中任务，delegate 按失败重试。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业插件组](../README.zh.md) — 同组企业包与两个 profile 的组合方式。
- [DSH backend task 设计](../../../docs/plans/2026-09-14-dsh-backend-task-design.md) — 节点语义、delegate 契约与 profile 架构。

-----

<a id="model-experience"></a>
## 模型体验

无直接模型上下文贡献：运行器把插值后的节点 prompt 作为普通用户消息提交；所有模型可见的贡献由 BPMN 节点配置拥有。

#### KV Cache 影响

每个任务会话相互独立且用后即弃；任务之间不累积任何内容，daemon 安装 skill 只改变未来会话能装载什么。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事情，属于当前约束而非任务清单。

- **内存任务表** — 重启丢失运行中任务；delegate 在其重试周期内按失败重试。
- **每任务一个会话** — 没有跨任务记忆或会话连续性；每个任务都从全新会话开始。
- **文本式 JSON 提取** — 结果从最终 assistant 文本的首个 `{` 到末个 `}` 解析；容许前后散文，不容许多个 JSON 对象。
- **身份即 URL** — `selfUrl` 既是 delegate 目标也是注册表键；迁移或改名实例会表现为新的 profile 条目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

内存任务表是设计接受的约束（delegate 重试兜底）；持久化任务状态属于 web-console 或引擎的新工作，不在本包。不发布运行时不变量伴随导出：端点行为与内存任务生命周期由本包行为测试直接覆盖，没有会分叉的独立维护观测。本包无未决工作。

</details>
