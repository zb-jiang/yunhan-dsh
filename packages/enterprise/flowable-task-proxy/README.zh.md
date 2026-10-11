---
description: "把 /dsh/tasks 与 /dsh/history 从 DSH webserver HTTP 代理到 flowable-engine。"
kind: "package-reference"
---

# @deepseek-ai/dsh-flowable-task-proxy

[English](README.md) | 中文

## 概述

`dsh-flowable-task-proxy` 把员工任务 API 从本地 DSH webserver 转发到 flowable-engine。前缀路由 `/dsh/tasks` 与 `/dsh/history` 原样中转路径、查询、请求体与登录员工的 JWT 到引擎，并把上游响应原样回写。部署拓扑要求浏览器面只经本地 webserver 访问服务器端服务；本包就是任务端点的那座桥。

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

浏览器面需要引擎任务 API 时在 enterprise profile 上使用本包：员工任务工作台以 webserver origin 为基准 fetch `/dsh/tasks/*`，没有这个代理时这些请求会落到 SPA fallback 返回 HTML。引擎侧的任务完成端点使用同样的路径，走同一个代理。

### 最小配置

`engineBaseUrl` 必填且无默认值：组合缺失该项在加载时即报错。

```yaml
- name: '@deepseek-ai/dsh-flowable-task-proxy'
  config:
    engineBaseUrl: 'http://flowable-engine:8090'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `engineBaseUrl` | 必填 | flowable-engine 基地址（协议、主机、端口）；volatile——设置面板修改后无需重载即生效 |

### 转发什么

| DSH 路由（前缀） | 上游 |
|---|---|
| `/dsh/tasks` | `{engineBaseUrl}/dsh/tasks/...` |
| `/dsh/history` | `{engineBaseUrl}/dsh/history/...` |

路径与查询原样透传；只有 `authorization` 与 `content-type` 两个请求头跨过边界；非 GET 请求体整体缓冲后转发。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指出对应代码；可观察行为见[使用本包](#use-this-package)。

### 原样转发

代理刻意做得很薄（[src/index.ts](src/index.ts)）：只改写 origin，白名单两个请求头，非 GET 方法缓冲请求体，然后把上游状态码与响应体原样写回（上游 content-type 透传，缺省按 JSON）。不缓存、不重试、不改形。

### 失败是 JSON，绝不是 HTML

两类失败都以 JSON 502 应答而非 HTML 错误页：上游不可达，以及 `engineBaseUrl` 无效。基地址是 volatile 配置——每次转发读取当前值，设置面板修改后无需重载即生效，坏值只让该次请求降级。

### 代理为什么存在

v5 拓扑要求每个浏览器面都调用本地 webserver，绝不直连服务器端服务。引擎在自己的 `/dsh` 命名空间下提供任务 API；本包把这些路径镜像到 webserver 上，让工作台的相对 fetch 落到引擎。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业插件组](../README.zh.md) — 同组企业包与两个 profile 的组合方式。
- [企业架构 v5](../../../docs/plans/dsh_enterprise_architecture_v5.html) — 催生「只经代理」规则的部署拓扑。

-----

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：本包是任务端点的纯 HTTP 转发；不注册任何模型可见内容。

#### KV Cache 影响

这里服务的请求从不接触模型上下文；本包的任何行为都不会使缓存前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事情，属于当前约束而非任务清单。

- **只转发** — 不缓存、不重试、不改写请求；转发失败返回 JSON 502，由调用方重试。
- **请求头白名单** — 只有 `authorization` 与 `content-type` 跨过边界；其余请求头被丢弃。
- **小请求体假设** — 非 GET 请求体整体缓冲后转发；任务提交是小体 JSON，大文件上传不是目标场景。
- **只有两个前缀** — 仅代理 `/dsh/tasks` 与 `/dsh/history`；引擎的其他命名空间在这里没有路由。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

任务状态、认领与完成语义由 flowable-engine 拥有；本包只搬运字节。不发布运行时不变量伴随导出：本代理只是两个前缀间的无状态字节转发，行为由本包代理测试直接覆盖。本包无未决工作。

</details>
