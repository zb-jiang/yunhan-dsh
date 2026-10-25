---
description: "Enterprise session knowledge-base context: client-reported session-to-application bindings plus a per-turn model-visible kb block."
kind: "package-reference"
---

# @deepseek-ai/dsh-kb-context

English | [中文](README.zh.md)

## Summary

`dsh-kb-context` gives enterprise task sessions their application's knowledge base without an '@' insert: the client reports which application each session belongs to, and the plugin injects one model-visible `<knowledge_base>` block at step 1 of every turn carrying that application's kb id and name, so the assistant can call `kb_search` / `kb_list` / `kb_read` directly. Sessions without a report — ordinary chats, applications without a kb, cleared bindings — inject nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Register the plugin in the employee-harness profile; the client side is `@deepseek-ai/dsh-ui-enterprise`, which reports bindings over the local webserver. Sessions with a reported application whose kb resolves inject one durable block per turn:

```text
<knowledge_base>
本会话所属应用的知识库：
kbId: <id>
名称：<name>
检索用 kb_search(kbId, query)，浏览清单用 kb_list(kbId)，读取全文用 kb_read(docId)；用户以 '@' 插入的知识库文档即来自此库。
此归属由系统注入并保持最新，仅供企业知识库检索使用。
</knowledge_base>
```

Report channel: `POST /api/enterprise/kb/session-context` (exact route on the local webserver) with the employee JWT and `{ "entries": [{ "sessionId": "...", "applicationId": "..." | null }] }`. The client reports on new bindings, replays persisted bindings after each task-list refresh, and reports `null` on completion.

| Field | Type | Description |
| --- | --- | --- |
| `webConsoleBaseUrl` | volatile string | web-console base URL (protocol + host, no path); used to resolve an application's kb. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### The report map is memory with a replay safety net

The session-to-application map is in-memory; a webserver restart re-learns it from the client's next replay sweep, so no durable store is added.

### Forged reports cannot escalate

kb resolution always re-fetches web-console's by-application endpoint with the signed-in employee's JWT, and non-members get 404 → no block.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-knowledge](../knowledge/README.md) — the kb tools the injected block points at.
- [Enterprise group README](../README.md) — the surrounding enterprise package set.

-----

<a id="model-experience"></a>
## Model Experience

### Session knowledge-base block

#### What the model sees

At step 1 of every turn, a session with a reported application whose kb resolves carries one durable `<knowledge_base>` block naming the application's `kbId`, its display name, and which tool serves which purpose (`kb_search`, `kb_list`, `kb_read`).

#### Token effect

One fixed block per turn — a few dozen tokens — whether or not the model calls the kb tools; sessions without a report inject nothing.

#### KV Cache effect

The block is injected at a fixed position (inside an open step, before `request/header`) with text that is stable for the session's lifetime, so it sits inside the cached prefix across turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **In-memory report map** — the session-to-application map lives in webserver memory; after a restart the block is missing until the client's next replay sweep.
- **One kb per application** — resolution returns the application's single knowledge base; multiple kbs per application have no representation.
- **Silent degradation** — an unreachable web-console or a non-member report resolves to no block with no user-visible error; the session just runs without kb context.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`renderKbContextText` in `src/text.ts` owns the block's exact wording. The report route `/api/enterprise/kb/session-context` is shared with the client reporter in `@deepseek-ai/dsh-ui-enterprise`; renaming it must update both sides. No open work here.

</details>
