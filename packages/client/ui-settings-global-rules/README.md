---
description: "Edit the user-global AGENTS.md injected into every session on this machine, from the Settings dialog's Global rules page."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-global-rules

English | [中文](README.zh.md)

## Summary

Edit the user-global AGENTS.md injected into every session on this machine, from the Settings dialog's Global rules page.

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

The Settings dialog's Global rules page edits `~/.dsh/AGENTS.md`, the user-global instruction file the harness injects near the top of every session. Record environment facts and standing rules there — installed tool paths, coding conventions, reply-language preferences — so they apply to every conversation without being repeated in chat.

Opening the page loads the current file content into an editor and shows the file path. When the file does not exist yet, the page says so and saving creates it. A failed load keeps the page usable: it reports the failure with the remote message and offers a Reload button that re-reads the file.

The footer shows the editor's byte usage against the injection budget when the Host declares one. Exceeding the budget is not blocked: the page warns that saving is allowed but the harness may drop part of the file when injecting. Saving is rejected only above the Host's write ceiling, which the page reports as a distinct error telling the user to trim the file. Other save failures report the remote message in place. A successful save refreshes the displayed state; the Save button stays disabled until the content changes again. Editing the content clears any previous notice.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host side lives in [api/settings-controller](../../api/settings-controller/README.md): `readGlobalInstructions()` returns the file view — display path, existence, content, and the injection budget in bytes when an agent-instructions loader entry declares `maxBytes` — and `writeGlobalInstructions(content)` persists the file. A read of a missing file succeeds as empty content with `exists: false`; a read or write the filesystem rejects fails with `globalRules/rejected`; a write above the 1 MiB ceiling, or any payload failing request validation, fails with `gateway/bad-request`.

The client package maps those remotes through `createGlobalRulesOperations` into a closed outcome vocabulary (`loaded`/`failed`, `written`/`too-large`/`refused`) so the section component renders branches instead of inspecting remote responses. The section registers on the `settings.section` slot with id `global-rules` and order 5, contributes its `settings.globalRules` locale namespace, and receives the two operations as injected faces. Byte counting uses `TextEncoder` against the edited text, so the usage figure tracks what saving will write, not the loaded snapshot.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Settings framework](../ui-settings/README.md) — The `settings.section` slot and Settings dialog shell.
- [Settings controller](../../api/settings-controller/README.md) — The read/write remotes and the global-instructions file semantics.
- [Locale](../locale/README.md) — Locale registration and namespaces.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the user-global AGENTS.md that the harness injects into every new session on this machine.

#### KV Cache effect

Saving affects later sessions only; the running session and its prompt cache remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Web only: no Desktop or other surfaces mount this section today.
- Last write wins: concurrent edits from another surface or a direct file editor are not detected or merged.
- The injection budget is advisory: the page warns but cannot guarantee how the harness truncates over-budget content.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
