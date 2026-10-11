---
description: "Employee-side enterprise knowledge-base access: a local webserver proxy to the web-console KB API plus the model-facing kb_search, kb_read, and kb_list tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge

English | [中文](README.zh.md)

## Summary

`dsh-knowledge` connects the agent and the browser to the enterprise knowledge base. It registers three read-only model-facing tools — `kb_search` (hybrid vector, trigram, and jieba retrieval fused by reciprocal rank), `kb_read` (full text with a length cap), and `kb_list` (folder and document browsing) — and proxies local webserver routes to the web-console KB API for browser surfaces. Authentication follows the caller: a signed-in employee's JWT on the enterprise profile, or the configured service key on the unattended backend profile.

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

Use this package when the employee-side agent should answer from enterprise knowledge bases, or when browser surfaces need the KB API without leaving the local webserver. Mounting it once with the web-console address is the only setup; the agent then searches and reads through its own tools, and browser pages call the local proxy routes.

### Minimal configuration

`webConsoleBaseUrl` is required with no default: a composition that omits it fails at load. `serviceKey` stays empty on the enterprise profile (a login JWT is used) and must match the web-console `dsh.service-key` on the backend profile, where no login identity exists.

```yaml
- name: '@deepseek-ai/dsh-knowledge'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
    serviceKey: 'shared-service-key'   # backend profile only
```

| Field | Default | Meaning |
|---|---|---|
| `webConsoleBaseUrl` | required | web-console base URL (protocol, host, port); volatile — the settings panel can change it without a reload |
| `readMaxChars` | `40000` | Maximum characters `kb_read` returns before truncating and flagging the result |
| `serviceKey` | `''` | `X-Service-Key` credential for unattended backend-profile reads; empty disables that channel |

### What each tool does

`kb_search` takes a knowledge base id and a short query (2–4 distilled keywords; the keyword and full-text routes match contiguous substrings, so long sentences miss), optionally scoped to a folder path, and returns document-level hits with snippets. `kb_read` returns one document's extracted full text, capped at `readMaxChars` and flagged when truncated, together with the owning kbId. `kb_list` enumerates a base's folders and documents — the whole tree or a subtree — including documents that are still parsing. Documents still being parsed never appear in search results.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Two surfaces, one upstream

Browser pages (the workbench KB selector, workspace upload) reach web-console only through the local webserver: the prefix routes `/api/enterprise/kb` and `/api/enterprise/apps` forward method, body, content-type, and the signed-in employee's JWT, and pass the upstream status and body through unchanged. An unreachable or misconfigured upstream answers with a JSON 502, never an HTML error page.

### Per-call authentication

The tools resolve authentication on every call ([src/index.ts](src/index.ts), `resolveAuth`): an employee JWT when a login identity exists (paths stay on `/api/kb/*`, where web-console checks membership), otherwise the configured service key (paths rewritten to the read-only allowlist `/api/backend/kb/*`). With neither credential the call fails with a model-visible error. The login service is deliberately not injected, so the backend profile — which has no identity plugin — still mounts; the token is read lazily per call.

### Folder paths resolve to ids

Tool arguments take a materialized folder path (`/finance/reimburse`); the package resolves it to the web-console folder id through the folders endpoint and fails loudly on an unknown path, so the model can recover by browsing with `kb_list`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [KB hybrid search design](../../../docs/plans/2026-10-02-kb-hybrid-search-design.md) — the vector, trigram, and jieba fusion owned by web-console.

-----

<a id="model-experience"></a>
## Model Experience

### Knowledge tools

#### What the model sees

The model receives three read-only tools: `kb_search` (kbId and query required; optional folderPath and topK, default 8), `kb_read` (docId required), and `kb_list` (kbId required; optional folderPath). Results render as text: search lists `- 名称 (docId: …, 路径: …, 相关度: …)` lines with snippets, read returns the full text plus the owning `kbId`, and list enumerates `[目录]` paths and documents with parse status. The search description prescribes 2–4 distilled keywords and warns that unparsed documents never match.

#### Token effect

Fixed definition cost on every request where the tools are visible; result text grows with hits and with full document text — `kb_read` output is capped at `readMaxChars` characters (default 40000) and stays in context until compaction.

#### KV Cache effect

Definitions are prefix-stable while registration is unchanged; results are append-only. `webConsoleBaseUrl` is volatile but never alters the tool definitions — an invalid value fails the call, not the cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Read-only by design** — the tools never create, upload, or delete knowledge; administration stays in web-console.
- **One upstream per deployment** — every request resolves against the single `webConsoleBaseUrl`; there is no per-call target override.
- **The service channel is a read-only allowlist** — unattended calls are rewritten to `/api/backend/kb/*`, and the browser proxy routes still require a signed-in employee JWT.
- **Exact folder paths** — `folderPath` must match a materialized path; a typo fails the call (recover with `kb_list`).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Search ranking — RRF weights, jieba dictionaries, parsing — is owned by web-console; this package forwards parameters only. No runtime invariant companion is published: proxy routing and tool parameter forwarding are covered directly by the package's behavior tests, with no independently maintained observation that can diverge. No open work here.

</details>
