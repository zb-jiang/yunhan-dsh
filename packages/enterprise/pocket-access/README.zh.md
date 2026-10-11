---
description: "手机访问的局域网/公网代理：在一对一配对设备闸门与同账号身份校验之后发布员工桌面 webserver，并提供配对、设备与 Cloudflare 隧道的管理路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pocket-access

[English](README.md) | 中文

## 概述

`dsh-pocket-access` 把员工桌面 webserver 发布给局域网里的手机。启用后，一个代理在 webserver 旁边监听 `0.0.0.0`，只放行携带配对设备 cookie 或同账号 Bearer 令牌的请求。`/api/enterprise/pocket` 下的管理路由负责配对码、设备吊销，以及一个可选的 Cloudflare 隧道——它能把同一个代理延伸到公网，且启动前必须经过明确的风险确认。访问事件 —— 启用/停用、配对、吊销、身份拒绝、隧道生命周期、局域网禁用命中 —— 先在本地缓冲，再批量上报到 web-console 审计日志。本包不添加任何模型可见行为。

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

把本包挂载在 enterprise bundle 中、本地 webserver 旁边。启用后它监听 `0.0.0.0:<bindPort>` —— 默认 3081，端口被占用时自动递增 —— 并在两道闸门之后向 webserver 转发：凭配对码签发的配对设备 cookie，以及镜像桌面登录的同账号 Bearer 校验。Cloudflare 隧道可以额外把代理发布到公网；启动它需要明确的风险确认。

### 配置

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `enabled` | boolean, volatile | 总开关；切换即在运行时启动或停止代理 |
| `bindPort` | integer | 代理监听端口；被占用时自动递增到下一个空闲端口 |
| `lanEnabled` | boolean, volatile | 局域网访问开关；关闭后拒绝局域网来源，并立即断开所有活跃的手机隧道 |
| `lanIpOverride` | string, volatile | 手动指定局域网地址；`''` 恢复自动探测 |
| `heartbeatEnabled` | boolean | WebSocket 心跳注入；重启后生效 |
| `tunnelEnabled` | boolean, volatile | 隧道意愿开关；切换会持久化意愿并启动或停止隧道 —— 实际状态由隧道状态机决定 |
| `tunnelMode` | `quick` \| `named`, volatile | 隧道模式；变更只影响下一次启动 |
| `tunnelHostname` | string, volatile | named 隧道的公网主机名；变更只影响下一次启动 |
| `cloudflaredPath` | string | 显式 `cloudflared` 可执行文件路径；`''` 回退到 `PATH` 查找（程序不会自动下载 —— 请自行安装 `cloudflared`）。重启后生效 |
| `webConsoleBaseUrl` | string, volatile | 审计上报目标 web-console 基地址；`''` 回退到 `WEB_CONSOLE_URL` 环境变量，再回退到本机默认 `http://127.0.0.1:8080` |

`POCKET_BIND_PORT` 通过 enterprise bundle patch 覆盖 `bindPort`。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-pocket-access)是全部接受字段的穷举来源。

### 管理路由

路由位于 `/api/enterprise/pocket` 之下，只应答来自环回来源且 `Host` 为环回的请求。每个变更操作都返回完整快照。

| 路由 | 含义 |
| --- | --- |
| `GET /status` | 完整快照（端口、握手可用性、带二维码的局域网地址、设备、带二维码的配对码、桌面身份、隧道状态） |
| `POST /enabled` | 请求体 `{ "enabled": boolean }` —— 持久化开关并启动或停止代理 |
| `POST /lan` | 请求体 `{ "enabled": boolean }` —— 局域网访问开关 |
| `POST /lan-override` | 请求体 `{ "ip": string }` —— 手动局域网地址，`''` 恢复自动探测 |
| `POST /pairing` | 请求体 `{ "action": "create" }` 签发新配对码；`{ "action": "revoke", "deviceId": string }` 吊销一台设备 |
| `POST /tunnel` | 请求体 `{ "action": "start" \| "stop", "disclaimer": boolean }` —— `start` 要求 `disclaimer: true` 并立即返回（快照显示 `state=starting`）；`stop` 拆除隧道并删除恢复标记 |
| `POST /tunnel-config` | 请求体 `{ "mode"?: string, "hostname"?: string }` —— 隧道模式与 named 主机名；`''` 清空主机名。非法值以 400 拒绝 |
| `POST /tunnel-token` | 请求体 `{ "token": string }` —— named 隧道令牌，以 0600 权限持久化；`''` 清空已存令牌 |

员工登出（`platform-user/signout`）清空全部配对设备并立即断开所有活跃 WS 隧道；吊销单台设备同样立即断开该设备的隧道（关闭帧携带原因），手机立刻能感知断线。它的重连被配对闸门以 401 JSON 应答拒绝，响应体携带机器可读的 `code`（`device-revoked` / `device-unpaired`）；手机 UI 断线后会探测一次闸门，并渲染全屏过期页（原因 + 重新配对提示），而不是永远停在"重连中"转圈。关闭局域网开关会以同样方式断开所有隧道，随后的探测会被局域网闸门以 403 应答（"局域网访问已关闭"）；关闭总开关则整个监听器停止，探测在网络层失败，手机渲染"连接已断开"过期页。总开关重新打开后，该页面会在后台持续轮询并自行消失。

### 审计上报

本插件记录访问事件 —— 代理启用/停用、设备配对/吊销、身份拒绝、隧道启动/停止、局域网禁用命中 —— 并携带员工 JWT 以每批至多 100 条上报到 web-console 端点 `POST /api/pocket/access-events`。上报失败的事件缓冲在用户数据目录的 `pocket-access/audit-backlog.jsonl`（权限 0600），在启动时与每次上报成功后重放；缓冲至多保留 1000 条，超出后丢弃最旧。状态快照携带 `audit.backlog`，UI 可以据此展示待上报事件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释代理背后的设计决策；可观察行为见[使用本包](#use-this-package)。闸门模型与威胁假设由设计文档 [Pocket Access 设计](../../../docs/plans/2026-10-09-pocket-access-design.md)持有。

### 代理管线

HTTP 管线按固定顺序执行 —— 来源/Host 分类取最严者、管理路由 denylist、局域网开关、配对闸门、身份闸门、头改写、桌面参数擦除、launch-token 注入、转发。WebSocket 升级经过同样的闸门；代理自己应答 101 握手并注入 ping 帧（两个静默周期即拆除隧道）。可压缩的 JSON/HTML 应答在出方向做 brotli 或 gzip 压缩。

### 配对设备与配对码

配对设备以 HMAC 签名的 cookie 持久化，背后是用户数据目录里的 `devices.json` 存储（权限 0600）；每次请求都执行吊销与过期校验。设备 cookie 按主机作用域划分，所以同一部手机在每个入口（局域网/公网）各配对一次 —— 配对成功时会复用同 UA 的活跃设备（刷新 lastSeenAt 并重新签名 cookie，不消耗设备上限），只有 UA 不同或为空才创建新记录，因此两个入口呈现为一行设备，显示最近一次配对的入口（公网/局域网；此能力之前的记录显示"—"）。配对码 8 个字符、存活 5 分钟；配对端点直接凭 `?code=` GET 完成兑换（扫码即完成配对，无需输入码），并对配对码尝试与握手注入双重限流。

### 隧道模式与生命周期

隧道运行一个 Cloudflare `cloudflared` 子进程，把代理发布到互联网。两种模式：

- **Quick** —— 不需要 Cloudflare 账号。公网 URL 由 Cloudflare 分配且跨重启变化；快照在 `tunnel.url` 中携带（只有 quick 模式会填充它）。
- **Named** —— 使用你自己的 Cloudflare 账号与固定主机名。需要隧道令牌（持久化在 `tunnel-token.json`，权限 0600；快照只报告 `tokenSet`，从不报告令牌本身）。快照的 `tunnel.url` 恒为 `null`；UI 自行拼出 `https://<hostname>`。

程序从不下载 `cloudflared`：设置了显式 `cloudflaredPath` 配置就用它，否则做 `PATH` 查找（Windows 是 `cloudflared.exe`，其他平台是 `cloudflared`）。请自行安装（Windows `winget install --id Cloudflare.cloudflared`，macOS `brew install cloudflared`，或官方安装器）；查找落空时启动请求以 400 失败，错误信息携带各平台的安装指引，隧道卡片在 `error` 状态下显示同样提示。named 主机名会被规范化（转小写，剥掉 scheme/路径/端口），且必须是多级域名 —— 裸 IP 与单级主机名以 400 拒绝。

启动同步校验、异步拉起：路由立即返回 `state=starting`，UI 轮询快照直到 `running` 或 `error`。服务器拒绝没有 `disclaimer: true` 的 `action: "start"` —— 设置页先弹风险对话框，用户明确确认后才发送该标志。

跨重启的恢复由标记驱动：`tunnel-marker.json` 记录隧道是否在运行。经路由停止隧道会删除标记；宿主被动关闭则保留标记，因此下次启动会自动重新拉起隧道，无需再次风险确认。

失败（`PATH` 中找不到 `cloudflared`、进程退出、就绪超时）表现为 `state=error` 加一段摘要 `detail`；`tunnelEnabled` 保持开启以便卡片重试。

隧道运行期间，设置页的配对二维码切换为公网地址（quick 用分配的 URL，named 由主机名拼出）—— 公网源经 Cloudflare 边缘从局域网也能到达，所以一张二维码同时服务两个网络；没有隧道时回退为局域网地址。

### 审计上报与积压缓冲

积压文件是 write-through 的权威：每次 `record` 先写内存再全量重写 JSONL 文件，然后才发起 fire-and-forget 上传，崩溃不会丢失已记录的事件。上传单飞执行、每批至多 100 条；上报成功后剪掉已上传前缀，失败则安排 30 秒重试；在拿不到 web-console 地址或员工令牌时完全跳过上报——不排队重试。快照调用（`GET /status`）会触发一次 `maybeFlush` 探测，已登录的桌面借 UI 的常规轮询清空积压，无需等待下一个事件。

哪些动作记审计是刻意设计的：切换总开关只在状态实际变化时记录（随配置自启绕过切换路由）；隧道启动只在手动启动时记录（跨重启的被动恢复不是人的动作）；隧道停止只在隧道确实处于 running 或 starting 时记录；设备吊销携带原因（单台吊销为 `manual`，登出清扫为 `signout`）。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业组 README](../README.zh.md) — 同组企业包及 enterprise bundle 如何组合它们。
- [Pocket Access 设计](../../../docs/plans/2026-10-09-pocket-access-design.md) — 闸门模型、里程碑与威胁假设。
- [部署架构](../../../docs/plans/dsh_enterprise_architecture_v5.html) — 本地 webserver 在 v5 拓扑中的位置。

-----

<a id="model-experience"></a>
## 模型体验

无模型上下文贡献：本包代理浏览器流量并管理隧道；不注册任何提示词、工具或会话事件。

#### KV Cache 影响

代理位于手机浏览器与本地 webserver 之间，从不触碰 agent 会话，因此没有模型请求或缓存前缀经由它发生变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事。它们是当前约束，不是任务清单。

- **quick 隧道 URL 不稳定** —— 由 Cloudflare 每次运行分配、跨重启变化；固定地址需要 named 隧道与自己的 Cloudflare 账号。
- **从不下载 `cloudflared`** —— 本包解析显式 `cloudflaredPath` 配置或 `PATH` 查找，可执行文件缺失时启动以 400 失败；安装是使用者自己的事。
- **令牌与设备存储是普通本地文件** —— `tunnel-token.json` 与 `devices.json` 依赖用户数据目录内 0600 的文件系统权限；没有额外的静态加密。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

里程碑 M1、M2 与 M3 已交付：M1 交付了代理、管理路由与设置页基础（含配对与设备卡片、桌面身份卡片）；M2 交付了访问审计踪迹 —— 本地事件缓冲与到 web-console 审计日志的批量上报；M3 交付了公网隧道 —— cloudflared 生命周期、quick 与 named 模式、自动恢复标记、令牌存储，以及风险确认保护的公网卡片。不发布运行时不变量伴随导出：双闸门（设备 cookie HMAC 校验、同账号身份比对）与监听器生命周期（随 enabled 开关启停）的全部断言只从插件自持状态（设备清单、Config.enabled、代理 server 句柄）推导，均有直接单测覆盖，不存在可与之分叉的独立观测源。

</details>
