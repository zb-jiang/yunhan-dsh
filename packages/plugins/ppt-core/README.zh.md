---
description: "可安装 AI 生成 PPT 插件的宿主侧:模板库、/api/ppt RPC 端点、ppt-master skill 注册、Python 检测与生图配置。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-ppt-core

[English](README.md) | 中文

## 概述

在对话里生成原生可编辑的 .pptx 幻灯片:直接要求做 PPT、挑选模板、或上传参考文稿提炼新 style。宿主侧注册内置的 ppt-master skill,提供客户端消费的 `/api/ppt` 模板与设置端点,并把用户新增 style 回放同步进 skill 的 styles 树,使所有模板都以纯 style_id 解析。生成依赖客户端首用引导安装的 Python 工具链。

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

用 `dsh plugin add` 安装打包好的插件 tgz;本宿主侧随即提供模板库、就绪检测与设置等由客户端 UI 驱动的服务。

### 何时选择它

当幻灯片必须是遵循可复用设计规格的原生可编辑 .pptx 时选择本插件;若一张图片式快deck就够用,通用 office skill 仍是备选。

### 最小配置

插件不声明任何 `cordis.yml` 字段。生图凭据与后端选择存放在客户端设置卡片(持久化在 `$DSH_HOME` 下),Python 工具链经客户端首用引导一次性安装。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

模板有两棵根:出厂 style 以包 assets 发布,用户新增 style 存放在 `$DSH_HOME/ppt-templates/styles/`,每次启动回放同步进已安装 skill 的 styles 树,并把 frontmatter 追加进 `styles_index.json`。RPC 面覆盖模板清单/删除、新增模板上传与提炼指令生成、从 AI 产出的工作空间登记 style、Python 就绪检测(逐解释器 `pip show`)、生图模型设置。内置的 ppt-master skill 副本带版本戳,插件版本变化时重拷。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ppt-client](../ppt-client/README.zh.md) — 本宿主服务的浏览器侧半边。
- [内置 ppt-master skill](assets/skills/ppt-master/SKILL.md) — 模型遵循的生成工作流。

-----

<a id="model-experience"></a>
## 模型体验

### System prompt capability section

#### What the model sees

插件挂载时向 system prompt 追加一个 `## PPT 生成(插件)` 段。该段固化路由契约:PPT 请求加载内置 ppt-master skill,模板指令经 `styles_index.json` 解析,生图后端或 Python 依赖缺失时按规则优雅降级。

##### 渲染节选

```markdown
## PPT 生成(插件)

- 用户要求制作/生成/美化 PPT、幻灯片、课件时,优先加载并遵循 `${SKILL_DIR}/SKILL.md` 的路由与工作流。
- 用户消息附带「模板指令」时,按其中括号内的样式引用进入模板模式:内置样式经 `styles_index.json` 解析到对应 design_spec.md。
- Python 依赖缺失时告知用户在插件设置里完成环境检测引导,不要尝试替用户安装 Python。
```

#### Token effect

一个有界段,每会话追加一次;不随对话长度或模板使用增长。

#### KV Cache effect

该段是会话开始时固定的静态文本,参与 system prompt 前缀缓存;仅插件版本变化时改变。

### Extraction prompt for a new template

#### What the model sees

在新增模板对话框上传参考文稿后,宿主组装提炼指令并由客户端写入草稿。指令指明目标 `style_id`,要求产出带 frontmatter、符合 style 契约的 `design_spec.md`,并要求模型结束时输出工作空间绝对路径供登记。

#### Token effect

每次上传一条用户消息,长度与提示模板成比例;后续轮次按普通历史重放。

#### KV Cache effect

它以普通用户轮次到达,已建立的请求前缀保持可复用,只有新轮次的 token 未命中缓存。

## 已知限制与遗留工作

<a id="known-limitations-and-deferred-work"></a>

以下为当前包约束,不是任务清单。

- **Python 工具链就绪前模板选择被阻断** — 客户端在写入模板指令前执行就绪门禁;引导只列出缺失的包,不代为安装。
- **内置预览是静态页图** — 每套模板内置前八页 JPG;预览对话框逐页翻看,不渲染完整文稿,也没有实时的 example.pptx。
- **新增 style 登记是手工两步** — AI 先把 style 提炼到工作空间,用户再把该路径粘贴回对话框;没有宿主侧自动登记。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
