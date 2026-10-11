---
description: "员工侧企业 LLM 访问：以登录员工 JWT 注册 llm-enterprise 提供方路由，后端为 web-console /api/llm（模型目录 + OpenAI 兼容代理）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-access

[English](README.md) | 中文

## 概述

`dsh-llm-access` 让登录员工在企业配额下使用模型。它在 LLM 运行时上注册 `llm-enterprise` 提供方路由，后端为 web-console 的员工模型目录（`GET /api/llm/models`）与 OpenAI 兼容配额代理（`POST /api/llm/v1/chat/completions`），以员工的 Supabase JWT 认证。路由的 profile 由拉取到的目录重建：授权的模型出现、收回的模型消失、登出时路由整体撤出。

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

在 enterprise profile 上使用本包，让员工消耗企业配额模型而非个人 API key。平台管理员把模型授权给员工或其应用后，模型选择器出现 `llm-enterprise` 分组，且只包含那些模型；请求按 web-console 治理的企业配额计费。

### 最小配置

`webConsoleBaseUrl` 必填且无默认值：组合缺失该项在加载时即报错。刷新间隔通常无需调整；默认值已在目录为空时快刷、非空时慢刷。

```yaml
- name: '@deepseek-ai/dsh-llm-access'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `webConsoleBaseUrl` | 必填 | web-console 基地址（协议、主机、端口）；volatile——设置面板可改，下次刷新生效 |
| `catalogRefreshMs` | `600000` | 目录非空时的刷新间隔 |
| `catalogEmptyRefreshMs` | `60000` | 目录为空时的快刷间隔（等待首次授权） |
| `catalogReadRefreshMs` | `30000` | 目录年龄超过该阈值时，选择器读取触发一次后台刷新 |
| `defaultContextWindow` | `262144` | 目录条目未声明 contextWindow 时的兜底上下文容量 |
| `defaultMaxTokens` | `32768` | 目录条目未声明 maxTokens 时的兜底输出上限 |

### 注册什么

一个提供方路由 `llm-enterprise`，由 OpenAI 兼容适配器服务。目录拉取与每次模型请求都携带登录员工的 JWT 发往 web-console；两者都从 DSH 后台进程发起并直连 web-console——不经过本地 webserver 路由。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指出对应代码；可观察行为见[使用本包](#use-this-package)。

### 跟随目录变化的路由

注册镜像目录（[src/index.ts](src/index.ts) 的 `syncRegistration`）：有模型才注册路由，清单清空时撤出为休眠零路由姿态（注册句柄保留，再次授权时原位恢复），拉取结果无变化时不动注册——选择器不会无谓刷新。

### 四个触发源的刷新

目录在 `platform-user/verified` 刷新（事件自带新 token）、按自适应自调度间隔刷新（空目录快刷、非空慢刷）、在 `loader/volatile-update` 刷新（基地址变更）、以及选择器读到陈旧目录时机会性刷新。刷新失败记警告并保留上次目录；登录过期静默等待下一次验证。

### 面向员工的失败文案

通用 OpenAI 协议适配器负责协议本身；外层包装（[src/adapter.ts](src/adapter.ts)）把失败改写为面向员工的消息。未登录调用企业模型时给出明确的「先登录」错误，而不是协议诊断信息。

### 图片输入注入

适配器注入持久附件服务与图片访问桥（[src/index.ts](src/index.ts) 中的 `resolveAttachments` / `resolveImageAccess`），方式与 base 挂载的 llm-pi-ai 插件一致：目录里声明了 `imageInput` 的模型接受附带图片，附件宿主路径经 `fs` 服务映射进当前工具执行世界。缺少这两个注入时，即使模型声明了图片输入，带图请求也会以 pi-ai 的 `UNSUPPORTED_CONTENT` 诊断失败。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业插件组](../README.zh.md) — 同组企业包与两个 profile 的组合方式。
- [企业 LLM 配额设计](../../../docs/plans/2026-09-27-enterprise-llm-quota-design.md) — web-console 拥有的授权、配额与代理契约。

-----

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：适配器把已组装好的请求原样转发给企业配额代理。

#### KV Cache 影响

模型选择变化只重建请求的模型字段，不改变对话前缀；目录刷新从不影响进行中的会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事情，属于当前约束而非任务清单。

- **只提供员工可见模型** — 目录就是 web-console 授权给该登录员工的模型全集；没有本地覆盖或追加。
- **目录滞后于授权** — 新授权的模型在下一次刷新（自适应间隔、选择器读取或登录事件）时出现，并非即时。
- **治理留在上游** — 本包不能授权、收回或改价模型；这些动作都在 web-console。
- **登出即休眠** — 没有登录身份时路由整体撤出；请求不会为稍后的登录排队。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

配额记账、模型授权与 OpenAI 兼容代理契约由 web-console 拥有；这里的兜底 context-window 与 max-tokens 值只补目录缺口。不发布运行时不变量伴随导出：代理路由与目录查找由本包行为测试直接覆盖，没有会分叉的独立维护观测。本包无未决工作。

</details>
