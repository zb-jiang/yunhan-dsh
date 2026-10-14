---
description: "企业会话身份上下文：ctx.currentUser 存储加上每回合注入的模型可见身份块。"
kind: "package-reference"
---

# @deepseek-ai/dsh-user-identity-context

[English](README.md) | 中文

## 概述

`dsh-user-identity-context` 保存企业会话对"当前登录人是谁"的回答：`ctx.currentUser` 持有最近一次验证通过的平台用户，并在每回合 step 1 追加一条模型可见的 `<user_identity>` 块，内含姓名、邮箱、userId 以及调用企业系统用的 Bearer 令牌。platform-user-api 负责验证并发射事件；本插件观察事件写入并清空存储。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

需要登录员工身份的插件从 `ctx.currentUser` 读取即可；存储由验证流程自动维护。数据流：

| 触点 | 行为 |
| ---- | ---- |
| `GET /api/enterprise/auth/me`（platform-user-api） | 验证成功后发射 `platform-user/verified` |
| `POST /api/enterprise/auth/signout`（platform-user-api） | 发射 `platform-user/signout` |
| `platform-user/verified` 事件（本插件订阅） | `ctx.currentUser.observe(user)` |
| `platform-user/signout` 事件（本插件订阅） | `ctx.currentUser.clear()` |
| 员工端 `logout`（ui-enterprise） | 退出登录时调用 signout 端点 |

存储为空（尚未登录或已退出）时不向模型请求注入任何内容；已登录但令牌尚未就绪时，省略令牌段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指向代码；可观察行为见[使用本包](#use-this-package)。

### 事件解耦各包

事件在 `@deepseek-ai/dsh-platform-user` 包中声明；`platform-user-api` 发射、本插件消费，两个包互不依赖。状态保存在内存中，进程重启后由客户端下一次 `/me` 重建。

### 令牌纪律写入块内

身份字段（姓名/邮箱/userId/组织岗位）仅供展示；认证令牌让助手以登录员工身份调用企业内部系统（由 Supabase SSO 签发、Bearer 认证——这是通用集成机制），绝不能展示、在回复中转述或写入文件。块本身携带这条指令。

### 不变量检查格式与归属

`./invariant` 伴随包校验注入块的精确格式与来源归属（与 time-context 同一机制），由测试与诊断装配显式挂载。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-platform-user](../platform-user/README.zh.md) — 存储背后的事件与治理记录。
- [dsh-platform-user-api](../platform-user-api/README.zh.md) — 发射这些事件的认证端点。

-----

<a id="model-experience"></a>
## 模型体验

### 当前用户身份块

#### 模型看到什么

每回合 step 1，一条插件归属（`form: 'snapshot'`）的 user message 携带验证通过的身份——姓名、邮箱、userId，以及以登录员工身份调用企业系统用的 Bearer 令牌。

##### 注入块

```markdown
<user_identity>
当前登录人：张三（zhangsan@corp.com）
userId: 9f3e8…
认证令牌（调用企业内部系统时放入 Authorization: Bearer 请求头）：
eyJhbGciOi…
此身份由系统注入并保持最新，仅供称呼与表单填写展示。认证令牌仅在调用企业系统时作为 Authorization: Bearer 请求头使用，不要在回复中展示、转述或写入文件。
</user_identity>
```

#### Token 影响

每回合一条固定形状的块，因此上下文每回合增长一条身份块；存储为空时不注入任何内容，已登录但尚无令牌时省略令牌段。

#### KV Cache 影响

块以追加方式落在新回合的 step 1；早前回合的块留在已记录历史里，缓存前缀保持稳定，只有最新一条块位于尾部。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不尝试做的事情。它们是当前约束，不是任务清单。

- **过期令牌窗口** — 令牌在会话中途过期时，上一次验证的身份保持不变，直到下一个触点；窗口期内助手用过期令牌调用企业系统会收到 401，下一回合的块携带刷新后的令牌。
- **令牌新鲜度跟随客户端** — 员工客户端刷新令牌后，下一次验证通过的 `/me` 把新令牌写入 `ctx.currentUser`，身份块随之更新。
- **Layer 2 保持通用** — 把调用层凭证传递给工具与 MCP 走块的认证令牌段这条通用通道；专用工具（如 process-start）保留各自的服务端令牌附加路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`src/text.ts` 的 `renderIdentityText` 拥有块的逐字措辞，`./invariant` 伴随模块按它校验每条重放块——两个文件必须一起改。`src/positions.ts` 与 web-console 的 `OrgPositionDto` 字段对齐；字段改名必须两侧同步。此处无未竟工作。

</details>
