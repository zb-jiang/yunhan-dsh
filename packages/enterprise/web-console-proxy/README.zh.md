---
description: "共享的 webserver 前缀转发器：浏览器面只经本地 DSH webserver 访问 web-console，自动附带当前登录员工 JWT，错误一律 JSON 应答。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-console-proxy

[English](README.md) | 中文

## 概述

`dsh-web-console-proxy` 是企业插件本地 webserver 前缀代理背后的共享 HTTP 转发器。企业插件注册一条 `{ kind: 'prefix' }` 路由（如 `/api/enterprise/kb`）并把 handler 委托给 `proxyRequest`：改写前缀为 web-console 路径、附带当前登录员工的 JWT、上游响应原样回写。所有失败模式都以 JSON 应答——未登录 401、基地址无效或上游不可达 502——浏览器侧永远不解析 HTML 错误页。`knowledge` 与 `instance-workspace` 共同消费本模块；模块自身不拥有任何路由与状态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当插件需要经本地 webserver 把 web-console REST 暴露给浏览器面时使用本包。基地址与登录 token 都以取值函数传入——每次请求实时读取，volatile 配置与新会话无需重载即生效。

### 最小配置

```ts ignore-check
import { proxyRequest } from '@deepseek-ai/dsh-web-console-proxy'

ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/api/enterprise/kb',
  handler: (req, res) => proxyRequest(
    { baseUrl: () => config.webConsoleBaseUrl.get(), token: () => ctx.get('currentUser')?.getToken() },
    '/api/enterprise/kb',
    '/api/kb',
    req,
    res,
  ),
}), 'knowledge: /api/enterprise/kb prefix route')
```

| 成员 | 含义 |
|---|---|
| `proxyRequest(options, localPrefix, upstreamPrefix, req, res)` | 把一条浏览器请求转发到 web-console 并原样回写上游响应 |
| `options.baseUrl` | web-console 基地址（协议、主机、端口），每次请求读取 |
| `options.token` | 当前登录员工的 JWT；未登录为 `undefined`（应答 401） |
| `options.unauthorizedMessage` | 可选的 401 领域文案；缺省为通用文案 |
| `validateBaseUrl(value)` | 值不是可解析 URL 时返回错误消息；有效返回 `undefined` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 转发契约

`localPrefix` 之后的后缀连同传入 query 一起拼到 `upstreamPrefix`。`content-type` 存在即透传；GET/HEAD 之外的请求体整体缓冲后重发，覆盖企业面用到的 JSON 与 multipart 体。上游状态码与响应体原样透传，缓冲副本重算 `content-length`。

### 错误应答一律 JSON

三种失败模式在任何上游调用之前或传输失败时以 JSON 应答：未登录 401（带未登录文案）、`baseUrl` 不可解析 502、web-console 不可达 502（带 fetch 错误文本）。浏览器侧错误处理因此收敛为一种形态，与 knowledge、instance-workspace 包的工具侧错误契约同构。

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：本模块是共享 HTTP 转发器；不注册任何模型可见内容。

#### KV Cache 影响

这里转发的请求从不接触模型上下文；本模块的任何行为都不会使缓存前缀失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了模块不做的事。它们是当前约束，不是任务清单。

- **单次调用单上游**——一条请求映射到一个 web-console 基地址；无重试、无扇出、无流式透传（请求体整体缓冲）。
- **仅 JWT**——转发器附带 Bearer token；企业 API 的服务密钥面由工具直连调用，不经本模块。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

模块是 `node:http` 类型之上的纯函数，不依赖 Cordis、webserver 或身份服务；路由注册与选项接线由消费方负责。未发布运行时 invariant 配套模块：转发、前缀改写与错误应答由本包行为测试直接覆盖，不存在可能分叉的独立维护观察面。当前无未决工作。

</details>
