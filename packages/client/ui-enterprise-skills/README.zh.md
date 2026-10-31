---
description: "企业员工端技能库治理面板：Web 侧栏 Skills 页面，列出流程要求、本地（上传或手工放入）与市场安装的技能，并经 skill-sync 完成安装、导入与卸载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enterprise-skills

[English](README.md) | 中文

## 概述

使用 Web 侧栏的**技能**入口管理员工机器上的企业技能。页面按来源分组 —— 流程要求、本地技能（上传与手工放入）、市场安装 —— 并经本地 webserver 的治理端点安装市场技能、导入 zip 包、卸载非流程要求技能；治理操作无需登录，流程要求技能靠服务端账本保护。搜索过滤三组内容；每个操作以可关闭的横幅作答；卸载要求确认；市场未开放时显示自己的空态。

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

enterprise app bundle 挂载本包，入口随 enterprise profile 出现，无需额外配置。在侧栏选择**技能** —— 入口紧随**插件**之下。页面打开时及点击**刷新**时经本地 webserver 的 `GET /api/enterprise/skills/catalog` 读取目录；读取失败显示错误与**重试**。

### 三组分栏

| 分组 | 来源 | 操作 |
|---|---|---|
| 流程要求 | `required` | 无 —— 员工待办所需的技能；端点以 403 拒绝卸载 |
| 本地上传 | `upload` | 卸载 |
| 市场 | SkillHub namespace | 未安装时可安装；已安装时可卸载 |

每张卡片显示技能名、来源标签、简介（或无简介占位），市场技能还显示版本。搜索框按名称过滤流程要求与本地上传两组，按 namespace、名称与简介过滤市场组；已安装的市场行排在可安装行之后。管理员未配置任何市场 namespace 时，三组照常渲染，市场组显示目录未开放空态。

**安装**发送 `POST /install`；同指纹重装幂等应答、不下载。以不同版本覆盖流程要求技能时以 409 拒绝。**卸载**打开点名的确认对话框，随后发送 `POST /uninstall`；流程要求卡片不显示该按钮，端点对此类技能一律拒绝。**导入**打开一个对话框，其拖放区支持点击或拖拽选择 `.zip`，随后把原始字节发送到 `POST /import`；端点要求含合法 frontmatter name 的 `SKILL.md`，同名已装以 409 拒绝，上传超 30 MB、解压超 64 MB 以 413 拒绝，自动剥掉单层顶层目录前缀，并应答导入的技能名。

每个成功或失败的操作都显示携带结果或端点原因的横幅，附关闭按钮；操作运行期间所有操作按钮禁用。每次成功写入后页面重新加载目录。

### 安全模型

每个面板请求只把 `localStorage` 中的员工 JWT（`dsh.enterprise.token`）带到本地 webserver；端点经 platform-user seam 校验，缺失或无效一律 401。SkillHub 下载使用宿主配置的只读分发 token，浏览器 token 不会越过本 DSH 实例。技能缓存的唯一写者是 skill-sync —— 本包不持有任何自身状态。

<a id="understand-the-implementation"></a>
## 理解实现

skill-sync 拥有全部数据与全部写操作；本包渲染其目录并分发其端点。

<details>
<summary>实现内部机制 — 点击展开</summary>

### 注册

`apply` 通过 `ctx.slots.inject()` 注册 `enterpriseSkills` 字典（zh/en）、侧栏入口（`sidebar.panellist`，id `enterprise-skills`，`order: 5`）与同一 id 的 `main` 面板，三者都跟随 slot 延迟声明、本地化变化与销毁。浏览器插件声明 `inject = ['slots', 'locale']`。

### 页面

`SkillsPanelPage` 持有目录、搜索词、通知横幅、忙碌标记与两个对话框状态。它把目录的本地条目与市场 namespace 合并成每组统一的卡片。安装、卸载与导入置忙碌标记，成功后重新加载目录；失败把端点消息放入横幅。`skills-api.ts` 本地重声明 wire 类型：feature 插件不得运行时 import 其他 feature 插件的值。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [skill-sync](../../enterprise/skill-sync/README.zh.md) — 宿主半区：治理端点、写锁与 `state.json` 的 `source` 字段。
- [企业子系统](../../../docs/subsystems/enterprise.zh.md) — enterprise profile 如何组合本面板驱动的各服务。
- [ui-sidebar](../ui-sidebar/README.zh.md) 与 [ui-layout](../ui-layout/README.zh.md) — 入口注册进的面板列表与页面占用的主 slot。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧治理界面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定面板的范围；它们是当前包的约束。

- **一次一个操作** — 安装、卸载或导入运行期间，忙碌标记禁用全部操作按钮；没有队列。
- **没有安装进度** — 安装与导入都是单次请求；卡片列表只在端点应答后变化，SkillHub 下载缓慢时不显示中间状态。
- **错误即端点原话** — 横幅显示端点返回的状态行与响应体；页面不做进一步归因，token 过期后的 401 就以端点消息呈现，直至员工重新登录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
