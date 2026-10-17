---
description: "流程实例云工作空间的模型面工具：列出、读取、写入、上传、下载、删除实例共享文件空间中的文件，并提供员工端本地代理、会话绑定上报与每回合 instance_workspace 提示块注入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-instance-workspace

[English](README.md) | 中文

## 概述

`dsh-instance-workspace` 让 agent 获得流程实例云工作空间的文件访问能力——每个流程实例一个共享文件空间，由 web-console 存储。它注册六个模型面工具（`workspace_list`、`workspace_read`、`workspace_write`、`workspace_upload`、`workspace_download`、`workspace_delete`），并导出确定性 `<instance_workspace>` 块的渲染函数 `renderInstanceWorkspaceContextText`。认证跟随调用方：enterprise profile 经本地 webserver 代理附登录员工 JWT，无人值守的 backend profile 凭服务密钥直连 web-console。本包同时拥有员工面代理路由、会话绑定上报端点、本地落盘端点（pull）与每回合 `<instance_workspace>` pre-step 注入。工具挂载按部署配置（`toolMount: 'global'` 与 `'boundSessions'`），详见字段表。

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

当 backend task 会话需要从所属流程实例的共享文件空间读取输入、或向其写入输出，或员工端待办会话需要经 AI 对话访问同一空间时使用本包。配置一次 web-console 地址即可完成挂载；agent 随后通过自己的工具操作实例空间，写/上传文件通过 `taskId` 参数归属到来源节点。

### 最小配置

`webConsoleBaseUrl` 必填且无默认值：缺少它的组合在加载时失败。enterprise profile 下登录身份优先、`serviceKey` 保持空串；backend profile（无登录身份）`serviceKey` 必须与 web-console 的 `dsh.service-key` 一致，两者皆无的调用直接报错。

```yaml
- name: '@deepseek-ai/dsh-instance-workspace'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
    serviceKey: 'shared-service-key'   # backend profile only; empty on the enterprise profile
    toolMount: 'global'                # backend profile; the enterprise employee face mounts 'boundSessions'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `webConsoleBaseUrl` | 必填 | web-console 基地址（协议+主机+端口）；volatile：设置面板可改，即时生效 |
| `readMaxBytes` | `262144` | `workspace_read` 返回内容的字节上限，超出截断并注明 |
| `uploadMaxBytes` | `67108864` | `workspace_upload` 接受的本地文件大小上限（与 web-console 上传上限对齐） |
| `serviceKey` | `''` | 无人值守 backend profile 的 `X-Service-Key` 凭证；enterprise profile 保持空串（登录 JWT 优先） |
| `localRoot` | 进程 cwd | `workspace_download`/`workspace_upload` 的回退本地落盘根；已绑定会话的工作目录优先 |
| `toolMount` | 必填 | `global`——六个工具注册进根注册表、所有会话可见（backend profile）；`boundSessions`——不全局注册，会话上报实例绑定后才向其 agent scoped 注册表注入（enterprise 员工端） |

### 各工具的行为

`workspace_list` 枚举一个实例的文件清单（含大小与磁盘缺失标记）。`workspace_read` 返回文本文件内容，上限 `readMaxBytes` 并在截断时注明——需要全文时用 `workspace_download` 取，而不是调大上限。`workspace_write` 用内联内容创建或覆盖文本文件；`workspace_upload` 以 multipart 发送本地文件。两者都接受可选 `taskId`，web-console 将其记录为文件来源节点。`workspace_download` 把文件写入本地工作目录下的同名相对路径，本地同名文件已存在时拒绝覆盖；`workspace_delete` 删除单个文件。相对路径必须以斜杠分隔，不得包含 `.`/`..` 段、前导斜杠、反斜杠或盘符。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### 两个认证通道

工具定义按员工面路径（`/api/workspace/instances/*`）书写一次，两个通道复用。有登录身份（enterprise profile）时 `resolveAuth` 把调用指向本地 webserver 代理（环回端口上的 `/api/enterprise/workspace/instances/*`），由共享的 `@deepseek-ai/dsh-web-console-proxy` 转发器附 JWT 并重写到 web-console `/api/workspace/instances/*` 做成员校验。无登录身份时同一路径重写到 `/api/backend/instances/*` 白名单并附 `X-Service-Key` 头，与 knowledge 插件同构。两者皆无时调用报错；上游不可达时以可读错误使调用失败，上游信封的错误消息原样透出。

### 员工面路由与每回合注入

前缀路由 `/api/enterprise/workspace` 经共享转发器把浏览器请求送到 web-console `/api/workspace/*`——未登录 401，基地址无效或上游不可达时 JSON 502。`POST /api/enterprise/workspace/session-context`（exact 路由，先于前缀路由匹配）记录 会话→实例 绑定：未登录 401，畸形体 400，成功 204 且幂等。`POST /api/enterprise/workspace/pull`（exact）解决「浏览器无法写本地磁盘」：Node 侧经本地代理（员工 JWT）取回一个实例空间文件并写入会话工作目录内——`target: 'cwd'` 写同名相对路径（目标已存在且未设 `overwrite` 时 409 `{ existed: true }`），`target: 'cache'` 写会话 cwd 下 `.dsh/instance-workspace-cache/<instanceId>/<relPath>`（始终覆盖）。响应：未登录 401；畸形体、不安全的 `relPath`（穿越、绝对路径、反斜杠）或会话 cwd 解析不到 400；超 `uploadMaxBytes` 413；成功 200 `{ localPath }`（绝对路径）。`boundSessions` 模式下，会话上报绑定后即向其 agent 的 scoped 注册表注入六个工具——agent 已存在时在上报时刻注入，晚于上报创建的由 `agent/created` 事件兜底——WeakSet 保证重复注入幂等。pre-step 监听只向已绑定会话的第 1 个 step 追加 `<instance_workspace>` 块（消息 source kind `instance-workspace`）。伪造上报无法越权：未绑定会话只是拿不到提示——`boundSessions` 下还不会注入 workspace_* 工具——每次工具调用仍由 web-console 鉴权。

### 本地落盘根：会话目录优先

`workspace_download` 与 `workspace_upload` 解析本地路径时优先使用已绑定会话的工作目录（员工端待办会话），无绑定时回退配置的 `localRoot`（默认进程 cwd）——一个 backend-profile 进程运行多个实例，每个任务会话把进程 cwd 当作自己的工作区。

### 渲染函数共享

`renderInstanceWorkspaceContextText`（[src/text.ts](src/text.ts)）以纯函数渲染固定的 `<instance_workspace>` 块——实例 id、任务 id 与工具速查表——backend-task 的提示注入与员工端 pre-step 产出逐字节一致的段落。singleLine 守卫防止恶意 id 伪造额外的块内行。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业插件组](../README.zh.md) — 同组企业包与两个 profile 的组合方式。
- [实例云工作空间设计](../../../docs/plans/2026-10-14-instance-workspace-design.md) — 存储模型、两套 API 面与本包实现的注入点。

-----

<a id="model-experience"></a>
## 模型体验

### 实例空间工具

#### 模型看到什么

模型收到六个工具：`global` 挂载下始终在工具目录里；`boundSessions` 下只有上报过实例绑定的会话才有（未绑定对话一个都没有）。`workspace_list` 渲染紧凑的 `- relPath (大小, [磁盘缺失])` 清单或「暂无文件」提示；`workspace_read` 渲染内容并附截断标记与改用 `workspace_download` 的提示；write/upload/delete 渲染受影响路径，提供过 `taskId` 时附来源节点记录。已绑定会话还通过 `renderInstanceWorkspaceContextText` 注入 `<instance_workspace>` 块——backend-task 提示标注当前任务 id，员工端 pre-step 显示 `taskId: (无)`——连同实例 id 与六工具速查表。

#### Token 影响

工具可见的每个请求有固定的定义成本，外加每条提示约 15 行的 `<instance_workspace>` 块。`workspace_read` 输出上限 `readMaxBytes` 字节（默认 256 KB），留在上下文中直到压缩。

#### KV Cache 影响

注册不变时定义保持前缀稳定；结果为追加式。`webConsoleBaseUrl` 是 volatile 但从不改变工具定义——非法值使调用失败，不影响缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本包不做的事。它们是当前约束，不是任务清单。

- **下载不覆盖** — `workspace_download` 遇本地同名文件拒绝，不提供覆盖开关。
- **上传上限只在本地** — `uploadMaxBytes` 守住本地读取；web-console 自身的上限在上游继续生效。
- **一次部署一个上游** — 每个请求解析到唯一的 `webConsoleBaseUrl`；没有按调用的目标覆盖。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

工作空间的存储、DTO 与两套 API 面由 web-console 负责；本包只转发参数。未发布运行时 invariant：工具参数转发、路径重写与本地文件处理由本包行为测试直接覆盖，不存在可能漂移的独立维护观察面。无未决工作。

</details>
