---
description: "Host half of the installable AI slide-generation plugin: template library, /api/ppt RPC endpoints, ppt-master skill registration, Python detection, and image-model settings."
kind: "package-bundle"
---

# @deepseek-ai/dsh-ppt-core

English | [中文](README.zh.md)

## Summary

Generate native, editable .pptx decks from the chat: ask for slides, pick a template, or upload a reference deck to distill a new style. The host registers the bundled ppt-master skill, serves the `/api/ppt` template and settings endpoints the client consumes, and replay-syncs user-added styles into the skill's styles tree, so every template resolves as a plain style_id. Generation requires the Python toolchain that the client's first-use guide installs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the packed plugin tgz with `dsh plugin add`; this host half then serves the template library, readiness checks, and settings that the client UI drives.

### When to choose it

Choose the plugin when slides must come out as a native editable .pptx following a reusable design spec; when a quick image-based deck is enough, the general office skills remain the fallback.

### Minimal configuration

The plugin declares no `cordis.yml` fields. Image-model credentials and backend selection live in the client settings card (persisted under `$DSH_HOME`), and the Python toolchain is installed once through the client's first-use guide.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Templates have two roots: built-in styles ship as package assets, user-added styles live under `$DSH_HOME/ppt-templates/styles/` and are replay-synced into the installed skill's styles tree on every startup, appending their frontmatter to `styles_index.json`. The RPC surface covers template list/delete, add-template upload with a composed extraction prompt, style registration from an AI-produced workspace, Python readiness (`pip show` per interpreter), and image-model settings. The vendored ppt-master skill copy is stamped and re-copied when the plugin version changes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ppt-client](../ppt-client/README.md) — the browser half this host serves.
- [Bundled ppt-master skill](assets/skills/ppt-master/SKILL.md) — the generation workflow the model follows.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt capability section

#### What the model sees

When the plugin mounts, it appends one `## PPT 生成(插件)` section to the system prompt. The section fixes the routing contract: PPT requests load the bundled ppt-master skill, template directives resolve through `styles_index.json`, and generation degrades gracefully when image backends or Python dependencies are missing.

##### Rendered section (abbreviated)

```markdown
## PPT 生成(插件)

- 用户要求制作/生成/美化 PPT、幻灯片、课件时,优先加载并遵循 `${SKILL_DIR}/SKILL.md` 的路由与工作流。
- 用户消息附带「模板指令」时,按其中括号内的样式引用进入模板模式:内置样式经 `styles_index.json` 解析到对应 design_spec.md。
- Python 依赖缺失时告知用户在插件设置里完成环境检测引导,不要尝试替用户安装 Python。
```

#### Token effect

One bounded section, appended once per session; it does not grow with conversation length or template use.

#### KV Cache effect

The section is static text fixed at session start, so it participates in the cached system-prompt prefix and changes only when the plugin version changes.

### Extraction prompt for a new template

#### What the model sees

Uploading a reference deck in the add-template dialog makes the host compose an extraction prompt that the client writes into the draft. The prompt names the target `style_id`, requires a style-contract `design_spec.md` with frontmatter, and asks the model to end with the workspace absolute path for registration.

#### Token effect

A single user message per upload, proportional to the prompt template; later turns replay it as ordinary history.

#### KV Cache effect

It arrives as a normal user turn, so the established request prefix stays reusable and only the new turn's tokens are uncached.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, not a task backlog.

- **Template selection is blocked until the Python toolchain is ready** — the client runs the readiness gate before staging a template directive; the guide names the missing packages but never installs them itself.
- **Built-in previews are static page images** — each template ships its first eight pages as JPGs; the preview dialog pages through them and does not render the full deck or a live example.pptx.
- **New-style registration is a manual two-step** — the AI extracts the style into a workspace, then the user pastes that path back into the dialog; there is no host-side auto-registration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
