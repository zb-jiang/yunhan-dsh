---
description: "企业工作区文件写入 Remote：基于乐观并发的工作区受限文本写入，挂载在 enterpriseFiles Remote 命名空间下"
kind: "package-reference"
---

# @deepseek-ai/dsh-enterprise-file-write

[English](README.md) | 中文

## 概述

`dsh-enterprise-file-write` 是企业文件编辑器背后的工作区写入通道。浏览器端编辑器的保存动作经本地 webserver 调用 `ctx.enterpriseFiles.write`；本服务解析 Session 的工作区根目录，拒绝越界路径，执行字节上限检查，最终在 workspace-write 沙箱策略下以乐观版本检查写入编辑器提供的文本。

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

在 enterprise profile 上使用本包：浏览器页面不直接触碰磁盘——编辑器保存经本地 webserver 的 `enterpriseFiles` Remote 命名空间转发，由本服务完成实际的工作区写入。目标调用方是 `@deepseek-ai/dsh-ui-enterprise` 中的企业文件编辑器；员工端 daemon 与服务器端运行器各有自己的通道。

### 最小配置

`maxWriteBytes` 限制单次写入的载荷上限。默认值覆盖常规文档编辑；仅当流程确实需要编辑大型文本工件时才调大。

```yaml
- name: '@deepseek-ai/dsh-enterprise-file-write'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxWriteBytes` | `2097152` | 单次写入允许的最大 UTF-8 字节数 |

### 一次写入调用的行为

`write(sessionId, request)` 接收 `{ path, content, expectedVersion? }`，返回 `{ absolutePath, version, operation }`，`operation` 为 `create` 或 `update`。传入 `expectedVersion` 时写入变为乐观替换：仅当文件仍携带该版本时成功；写入报告 `enterprise-file/stale-version` 时由调用方重读并重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节解释设计决策并指出对应代码；可观察行为见[使用本包](#use-this-package)。

### 工作区根目录跟随 Session 解析

写入目标的工作区根目录按调用解析（[src/index.ts](src/index.ts) 的 `resolveWorkspaceRoot`）：先取活跃 Session 工作区 header，再取归档 Session 的持久化 header，最后落到沙箱根。每个解析出的根目录写前都用 `fs.contains` 确认，逃逸工作区的路径以 `enterprise-file/outside-workspace` 失败，不会落到磁盘。

### 经 fs intent 实现乐观并发

`expectedVersion` 映射为 `FsWriteIntent` 的 `replaceIfVersion` 写入；结果中返回的 version 由 fs 层在每次成功写入时铸造。两个编辑器窗口保存同一文件不会静默互相覆盖——后保存的一方报告 stale 而不是覆盖。

### 沙箱策略与错误映射

写入在 `workspace-write` 沙箱策略下执行。文件系统失败映射为稳定的 Remote 错误码：`FS_STALE_VERSION` 变为 `enterprise-file/stale-version`，`FS_SANDBOX_DENIED` 变为 `enterprise-file/denied`；超限载荷在触碰 fs 之前即以 `enterprise-file/too-large` 失败。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [企业插件组](../README.zh.md) — 同组企业包与各 profile 的组合方式。
- [Typert Remote 服务](../../../docs/subsystems/typert.zh.md) — 本服务扩展的 Remote 机制。

-----

<a id="model-experience"></a>
## 模型体验

无直接模型上下文贡献：本服务把编辑器提供的文本写入 Session 工作区；不注册任何 prompt、工具或 Session 事件。

#### KV Cache 影响

本包不进入模型请求：编辑器提供的内容写到磁盘，只有后续 prompt 引用该文件的工作区路径时 Session 才会观测到它。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包不做的事情，属于当前约束而非任务清单。

- **仅限文本** — 写入路径接受 UTF-8 文本载荷；二进制格式需要别的通道。
- **整文件替换** — 一次保存替换整个文件；没有补丁或区间更新模式。
- **stale 不带重试指导** — `enterprise-file/stale-version` 只告知调用方版本已变动；重读与合并逻辑属于调用方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

三级工作区根目录解析（活跃 header、持久化 header、沙箱根）与企业文件读取侧的解析方式一致；若解析顺序变化，两侧需同步。行为由本包行为测试直接覆盖；本包无未决工作。

</details>
