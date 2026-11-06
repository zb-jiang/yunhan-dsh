---
description: "可安装 AI 生成 PPT 插件的客户端 UI:模板画廊、模板 chip、预览器、设置卡片与 Python 首用引导,经 ui-slots 挂载到对话界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ppt-client

[English](README.md) | 中文

## 概述

PPT 插件的客户端半边。经 `ui-slots` 挂载对话界面:模板库入口(`conversation.input.left`)、模板画廊与新增模板对话框(`conversation.input.dock`)、模板 chip、预览器与生图设置卡片(`settings.section`)。文案全部走 `t()` 字典(`verify-client-ui-i18n` 门禁)。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与遗留工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

插件 tgz 经 `dsh plugin add` 安装后,浏览器半自动挂载,不存在单独的启用步骤。

### 何时选择它

它不独立被选择:客户端 bundle 与其 slot 挂载随 `@deepseek-ai/dsh-ppt-core` 宿主包一起到达。

### 最小配置

无 `cordis.yml` 字段。日常配置都在挂载的设置卡片完成——生图后端与凭据,以及按需触发的 Python 首用引导。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

画廊从宿主的模板端点列出出厂 style,翻看静态预览对话框,选中 style 后在输入草稿顶部写入一条括起的模板指令。新增模板对话框上传参考文稿,之后重开并保留暂存区,用于把 AI 的工作空间路径粘贴回来登记新 style。选中动作以宿主的 Python 就绪探测为门禁;探测失败时拉起依赖引导,不写指令。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ppt-core](../ppt-core/README.zh.md) — 本 UI 驱动的宿主端点。

-----

<a id="model-experience"></a>
## 模型体验

### Template directive chip prefix

#### What the model sees

选中模板会在输入草稿顶部写入一条括起的指令行,例如 `【模板指令】使用 ppt-master 技能,按模板「产品发布」(product-launch)的设计规格制作全部页面。`;移除 chip 时精确剥离这一行。

#### Token effect

每选中一套模板一行短句;它随普通用户消息进入请求。

#### KV Cache effect

指令随用户轮次到达,已建立的请求前缀保持可复用;只有追加的轮次未命中缓存。

## 已知限制与遗留工作

<a id="known-limitations-and-deferred-work"></a>

以下为当前包约束,不是任务清单。

- **预览对话框逐页翻静态 JPG** — 出厂模板只暴露前八页;没有整册或实时 .pptx 渲染。
- **新增 style 登记需要对话框往返** — AI 提炼完成后,用户须重开对话框粘贴工作空间路径;没有任何自动登记。
- **出厂模板不携带可下载的 example.pptx** — 生成之前,预览图集是唯一的视觉依据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

使用共享预设 `packages/client/tsdown.client.ts` 构建:Node 半产出 `lib/index.js`,浏览器半产出闭包工厂形态的 `lib/client.js` bundle。运行时模块请求保持在 client 基线;slot 契约的 type-only 导入不产生模块请求。

</details>
