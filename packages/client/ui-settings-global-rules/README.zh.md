---
description: "在设置对话框的「全局规则」页编辑注入本机每个会话的 user-global AGENTS.md。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-global-rules

[English](README.md) | 中文

## 概述

在设置对话框的「全局规则」页编辑注入本机每个会话的 user-global AGENTS.md。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

设置对话框的「全局规则」页编辑 `~/.dsh/AGENTS.md` —— harness 注入到每个会话顶层的 user-global 指令文件。在这里记录环境事实与固定规则 —— 已安装的工具路径、编码约定、回复语言偏好 —— 让它们对每个会话生效，无需在对话中重复声明。

打开页面会把当前文件内容载入编辑器并显示文件路径。文件尚不存在时，页面会说明这一点，保存后创建。加载失败不会让页面不可用：页面会带远端消息报告失败，并提供重新加载按钮重读文件。

Host 声明了注入预算时，页脚显示编辑内容相对预算的字节用量。超出预算不会被阻止：页面提示仍可保存，但注入时部分内容可能被忽略。只有在超过 Host 写入上限时保存才会被拒绝，页面以独立错误提示用户精简文件。其余保存失败在原地报告远端消息。保存成功后刷新显示状态；内容再次变化前保存按钮保持禁用。编辑内容会清除先前的提示。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 侧位于 [api/settings-controller](../../api/settings-controller/README.zh.md)：`readGlobalInstructions()` 返回文件视图 —— 展示路径、存在性、内容，以及 agent-instructions loader entry 声明 `maxBytes` 时的注入预算（字节）；`writeGlobalInstructions(content)` 持久化文件。读取不存在的文件以空内容成功并返回 `exists: false`；文件系统拒绝的读或写以 `globalRules/rejected` 失败；超过 1 MiB 上限的写入、或任何未通过请求校验的载荷，以 `gateway/bad-request` 失败。

客户端包通过 `createGlobalRulesOperations` 把这些 remote 映射为封闭的结果词汇表（`loaded`/`failed`、`written`/`too-large`/`refused`），section 组件只渲染分支、不解析 remote 响应。section 以 id `global-rules`、order 5 注册到 `settings.section` slot，贡献 `settings.globalRules` locale 命名空间，并把两个操作作为注入 face 传入。字节计数对编辑文本使用 `TextEncoder`，用量反映的是保存将写入的内容，而非已加载快照。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Settings framework](../ui-settings/README.zh.md) —— `settings.section` slot 与设置对话框外壳。
- [Settings controller](../../api/settings-controller/README.zh.md) —— 读写 remote 与全局指令文件的语义。
- [Locale](../locale/README.zh.md) —— locale 注册与命名空间。

<a id="model-experience"></a>
## 模型体验

通过 harness 注入本机每个新会话的 user-global AGENTS.md 间接影响模型。

#### KV Cache effect

保存只影响之后的会话；运行中的会话与其提示缓存不变。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 仅 Web：目前没有 Desktop 或其他 surface 挂载本 section。
- 后写胜出：不检测也不合并来自其他 surface 或直接文件编辑器的并发修改。
- 注入预算仅是提示：页面只警告，不保证 harness 对超预算内容的截断方式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
