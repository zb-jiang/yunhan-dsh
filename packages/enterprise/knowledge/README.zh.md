---
description: "员工侧企业知识库访问：本地 webserver 代理 web-console KB API，并注册模型可见的 kb_search、kb_read、kb_list 三个工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge

[English](README.md) | 中文

## 概述

`dsh-knowledge` 把智能体与浏览器接入企业知识库。它注册三个只读的模型可见工具——`kb_search`（向量、trigram 与 jieba 三路检索经倒数排名融合的混合检索）、`kb_read`（带长度上限的全文读取）、`kb_list`（文件夹与文档浏览）——并把本地 webserver 路由代理到 web-console KB API，供浏览器页面使用。认证跟随调用方：enterprise profile 使用登录员工的 JWT，backend profile（无人值守）使用配置的服务密钥。

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

当员工侧智能体需要基于企业知识库回答问题，或浏览器页面需要经本地 webserver 访问 KB API 时使用本包。挂载一次并给出 web-console 地址即可完成配置；智能体随后通过自己的工具检索与阅读，浏览器页面调用本地代理路由。

### 最小配置

`webConsoleBaseUrl` 必填且无默认值：组合缺失该项在加载时即报错。enterprise profile（有登录 JWT）`serviceKey` 保持空串；backend profile（无登录身份）必须与 web-console 的 `dsh.service-key` 一致。

```yaml
- name: '@deepseek-ai/dsh-knowledge'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
    serviceKey: 'shared-service-key'   # backend profile only
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `webConsoleBaseUrl` | 必填 | web-console 基地址（协议、主机、端口）；volatile——设置面板修改后无需重载即生效 |
| `readMaxChars` | `40000` | `kb_read` 返回全文的最大字符数，超出截断并在结果中注明 |
| `serviceKey` | `''` | 无人值守 backend profile 读取用的 `X-Service-Key` 凭证；空串禁用该通道 |

### 各工具的行为

`kb_search` 接收知识库 id 与短查询（提炼 2–4 个核心关键词；关键词与全文两路只匹配连续子串，长句会漏检），可按文件夹路径限定范围，返回文档级命中与摘要。`kb_read` 返回一个文档的抽取全文，超出 `readMaxChars` 截断并注明，同时携带所属 kbId。`kb_list` 枚举一个库的文件夹与文档——全树或子树——包括仍在解析中的文档。解析中的文档永远不会出现在检索结果里。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指出对应代码；可观察行为见[使用本包](#use-this-package)。

### 两个入口，一个上游

浏览器页面（工作台知识库选择器、工作区上传）只经本地 webserver 访问 web-console：前缀路由 `/api/enterprise/kb` 与 `/api/enterprise/apps` 转发方法、请求体、content-type 与登录员工的 JWT，并把上游状态码与响应体原样回写。上游不可达或配置无效时以 JSON 502 应答，绝不让浏览器解析 HTML 错误页。

### 逐次调用的认证

工具在每次调用时解析认证（[src/index.ts](src/index.ts) 的 `resolveAuth`）：存在登录身份时用员工 JWT（路径保持 `/api/kb/*`，由 web-console 做成员校验），否则用配置的服务密钥（路径重写为只读白名单 `/api/backend/kb/*`）。两者皆无时调用报错，错误消息面向模型呈现。登录服务被有意排除在 inject 之外，因此没有身份插件的 backend profile 也能挂载本包；token 在每次调用时惰性读取。

### 文件夹路径解析为 id

工具入参使用物化路径（`/finance/reimburse`）；本包经 folders 端点把它解析为 web-console 的文件夹 id，路径不存在时立即报错，模型可改用 `kb_list` 浏览恢复。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业插件组](../README.zh.md) — 同组企业包与两个 profile 的组合方式。
- [KB 混合检索设计](../../../docs/plans/2026-10-02-kb-hybrid-search-design.md) — 由 web-console 拥有的向量、trigram、jieba 融合检索。

-----

<a id="model-experience"></a>
## 模型体验

### 知识库工具

#### 模型看到什么

模型收到三个只读工具：`kb_search`（必填 kbId 与 query；可选 folderPath 与 topK，默认 8）、`kb_read`（必填 docId）与 `kb_list`（必填 kbId；可选 folderPath）。结果以文本呈现：检索列出 `- 名称 (docId: …, 路径: …, 相关度: …)` 行并附摘要，读取返回全文及所属 `kbId`，清单枚举 `[目录]` 路径与各文档解析状态。检索描述要求提炼 2–4 个核心关键词，并提示解析中的文档不会命中。

#### Token 影响

工具可见的每次请求承担固定定义成本；结果文本随命中数与全文长度增长——`kb_read` 输出上限为 `readMaxChars` 字符（默认 40000），进入上下文后保留至压缩。

#### KV Cache 影响

注册不变时定义保持前缀稳定；结果为追加式。`webConsoleBaseUrl` 是 volatile 配置但从不改变工具定义——值无效只会让该次调用报错，不影响缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事情，属于当前约束而非任务清单。

- **只读设计** — 工具不创建、不上传、不删除知识；管理动作留在 web-console。
- **每个部署一个上游** — 所有请求都解析到唯一的 `webConsoleBaseUrl`；没有按调用覆盖目标的机制。
- **服务通道是只读白名单** — 无人值守调用重写到 `/api/backend/kb/*`，浏览器代理路由仍要求登录员工 JWT。
- **文件夹路径须精确匹配** — `folderPath` 必须与物化路径一致；拼错时调用报错（可用 `kb_list` 恢复）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

检索排序——RRF 权重、jieba 词典、解析——由 web-console 拥有；本包只转发参数。不发布运行时不变量伴随导出：代理路由与工具参数转发由本包行为测试直接覆盖，没有会分叉的独立维护观测。本包无未决工作。

</details>
