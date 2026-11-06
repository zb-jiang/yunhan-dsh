---
description: "Client half of the installable AI slide-generation plugin: gallery, template chip, preview dialog, settings card, and Python guide over ui-slots."
kind: "package-reference"
---

# @deepseek-ai/dsh-ppt-client

English | [中文](README.zh.md)

## Summary

Client-side half of the PPT plugin. It mounts the conversation UI through `ui-slots`: the template gallery entry (`conversation.input.left`), the gallery with its add-template dialog (`conversation.input.dock`), the template chip, the preview dialog, and the image-model settings card (`settings.section`). All copy ships through the `t()` dictionary (`verify-client-ui-i18n`).

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

The browser half mounts automatically once the plugin tgz is installed with `dsh plugin add`; no separate activation step exists.

### When to choose it

It is not chosen independently: the client bundle and its slot mounts arrive together with the `@deepseek-ai/dsh-ppt-core` host package.

### Minimal configuration

No `cordis.yml` fields. Day-to-day configuration happens in the mounted settings card — image-model backend and credentials, plus the Python first-use guide triggered on demand.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The gallery lists built-in styles from the host's template endpoint, pages a static preview dialog, and stages a bracketed template directive at the top of the input draft when a style is picked. The add-template dialog uploads a reference deck, then reopens with a persistent stage for pasting the AI's workspace path back to register the new style. Selection is gated on the host's Python readiness probe; a failed probe opens the dependency guide instead of staging the directive.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ppt-core](../ppt-core/README.md) — the host endpoints this UI drives.

-----

<a id="model-experience"></a>
## Model Experience

### Template directive chip prefix

#### What the model sees

Picking a template stages one bracketed directive line at the top of the input draft, for example `【模板指令】使用 ppt-master 技能,按模板「产品发布」(product-launch)的设计规格制作全部页面。`; removing the chip strips exactly that line again.

#### Token effect

One short line per selected template; it enters the request as part of the ordinary user message.

#### KV Cache effect

The directive rides in the user turn, so the established request prefix stays reusable; only the appended turn is uncached.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, not a task backlog.

- **The preview dialog pages static JPGs** — built-in templates expose their first eight pages; there is no full-deck or live .pptx rendering.
- **New-style registration needs a dialog round-trip** — after the AI finishes extracting, the user must reopen the dialog and paste the workspace path; nothing registers automatically.
- **Built-in templates carry no downloadable example.pptx** — the preview image set is the only visual evidence before generation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Built with the shared `packages/client/tsdown.client.ts` preset: the Node half emits `lib/index.js`, the browser half emits the closure-factory `lib/client.js` bundle. Runtime module requests stay at the client baseline; type-only slot-contract imports create no module request.

</details>
