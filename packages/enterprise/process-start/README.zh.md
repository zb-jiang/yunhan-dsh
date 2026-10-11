---
description: "员工侧对话发起流程：三个模型可见工具分别列出可发起流程、读取启动参数、经 web-console REST 发起实例。"
kind: "package-reference"
---

# @deepseek-ai/dsh-process-start

[English](README.md) | 中文

## 概述

`dsh-process-start` 让员工在 AI 对话中发起已发布的流程。它注册三个模型可见工具——`dsh_process_list`（当前登录员工可发起的流程及其所属应用）、`dsh_process_start_form`（一个流程定义的启动参数声明）、`dsh_process_start`（发起实例，可选指定发起身份）——并以员工的 Supabase JWT 调用 web-console 流程 REST。凡需要流程定义 id 的地方都可直接传流程名或 BPMN key，自动解析；工具调用落 session 事件。

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

当员工侧智能体需要替用户发起企业流程时使用本包：列出用户可发起的流程、读取各流程的启动参数、向用户收集必填值、发起实例——全部在一次对话内完成。配置只需给出 web-console 地址。

### 最小配置

`webConsoleBaseUrl` 必填且无默认值：组合缺失该项在加载时即报错。认证复用登录身份；本包没有服务密钥通道。

```yaml
- name: '@deepseek-ai/dsh-process-start'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `webConsoleBaseUrl` | 必填 | web-console 基地址（协议、主机、端口）；volatile——设置面板修改后无需重载即生效 |

### 各工具的行为

`dsh_process_list` 返回当前登录员工可发起的已发布流程定义，附带所属应用。`dsh_process_start_form` 读取一个定义的启动变量（名称、类型、必填、说明）——模型应先向用户收集必填值再发起。`dsh_process_start` 发起实例并返回实例 id、开始时间与名称；身份块列出多个身份时由 `orgUnitId` 选择以哪个身份发起。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指出对应代码；可观察行为见[使用本包](#use-this-package)。

### id、名称、key 共用一个解析器

工具接受流程定义 UUID、流程名或 BPMN key（[src/index.ts](src/index.ts) 的 `resolveWorkflowDefinitionId`）：UUID 直接透传；其余先按名称或 key 精确匹配可发起清单，再按名称、key、说明做子串匹配。唯一命中直接使用；零个或多个命中报错并附候选清单，模型可自行纠正而不必猜测。

### 逐次调用的认证与 volatile 基地址

每次调用惰性读取 `ctx.currentUser.getToken()` 并以 Bearer JWT 发送；未登录时调用报错，错误消息面向模型呈现。`webConsoleBaseUrl` 是 volatile 配置：每次调用读取当前值，设置面板修改后无需重载即生效，值无效只让该次调用失败，不影响插件。

### 报错即恢复提示

错误消息为模型而写：解析不了的流程名会附上可发起清单，上游失败携带 HTTP 状态码与 web-console 自己的错误文本。工具调用与结果走普通注册表管线，落 session 事件。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业插件组](../README.zh.md) — 同组企业包与两个 profile 的组合方式。
- [组织单位路由设计](../../../docs/plans/2026-09-19-org-unit-routing-design.md) — `orgUnitId` 如何标识发起身份，以及可发起视图的来源。

-----

<a id="model-experience"></a>
## 模型体验

### 流程发起工具

#### 模型看到什么

模型收到三个工具：`dsh_process_list`（无参数）、`dsh_process_start_form`（必填 workflowDefinitionId）与 `dsh_process_start`（必填 workflowDefinitionId；可选 `orgUnitId`、`variables`、`businessKey`、`name`）。结果以中文文本呈现：清单列出 `- 名称 (id: …, 应用: …)` 行，启动参数列出 `- 变量名(类型,必填) 说明` 条目，发起成功确认 `流程实例已发起(实例 id: …)`。报错附可发起清单，模型可用有效 id 重试。

#### Token 影响

工具可见的每次请求承担固定定义成本；结果文本随可发起目录与启动参数声明数量增长——清单端点返回该员工可发起的全部已发布流程，在应用较多的部署里可能相当可观。

#### KV Cache 影响

注册不变时定义保持前缀稳定；结果为追加式。`webConsoleBaseUrl` 是 volatile 配置但从不改变工具定义——值无效只会让该次调用报错，不影响缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事情，属于当前约束而非任务清单。

- **只发起，不追踪** — 本包发起实例但没有待办或实例状态工具；待办办理在员工工作台与流程集成里。
- **名称歧义立即报错** — 流程名或 BPMN key 匹配到零个或多个定义时报错并附候选清单，不做猜测。
- **类型校验留在上游** — `variables` 原样透传；必填与类型校验由 web-console 在启动时执行。
- **身份来自身份块** — 本包不自查组织身份；模型从上下文身份块中选择 `orgUnitId`，或向用户询问。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

启动变量校验与实例持久化由 web-console 拥有；本包只转发声明与启动请求。不发布运行时不变量伴随导出：工具只转发声明与启动请求，行为由本包行为测试直接覆盖，没有会分叉的独立维护观测。本包无未决工作。

</details>
