---
description: "Enterprise LLM access on the employee side: registers the llm-enterprise provider route backed by web-console /api/llm (model catalog + OpenAI-compatible proxy) with the signed-in employee's JWT."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-access

English | [中文](README.zh.md)

## Summary

`dsh-llm-access` gives the signed-in employee model access under enterprise quotas. It registers the `llm-enterprise` provider route on the LLM runtime, backed by web-console's employee model catalog (`GET /api/llm/models`) and OpenAI-compatible quota proxy (`POST /api/llm/v1/chat/completions`), authenticated with the employee's Supabase JWT. The route's profiles rebuild from the fetched catalog: granted models appear, revoked ones vanish, and the route withdraws while signed out.

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

Use this package on the enterprise profile so employees consume enterprise-quota models instead of personal API keys. After a platform admin grants models to the employee or their application, the model selector shows the `llm-enterprise` group with exactly those models; requests bill against the enterprise quota governed by web-console.

### Minimal configuration

`webConsoleBaseUrl` is required with no default: a composition that omits it fails at load. The refresh intervals rarely need tuning; the defaults already run fast while the catalog is empty and slow once populated.

```yaml
- name: '@deepseek-ai/dsh-llm-access'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
```

| Field | Default | Meaning |
|---|---|---|
| `webConsoleBaseUrl` | required | web-console base URL (protocol, host, port); volatile — the settings panel can change it, effective on next refresh |
| `catalogRefreshMs` | `600000` | catalog refresh interval while the catalog is non-empty |
| `catalogEmptyRefreshMs` | `60000` | fast refresh interval while the catalog is empty (waiting for first grants) |
| `catalogReadRefreshMs` | `30000` | catalog age beyond which a selector read triggers one background refresh |
| `defaultContextWindow` | `262144` | fallback context capacity when a catalog entry declares none |
| `defaultMaxTokens` | `32768` | fallback output cap when a catalog entry declares none |

### What it registers

One provider route, `llm-enterprise`, served by an OpenAI-compatible adapter. The catalog pull and every model request go to web-console with the signed-in employee's JWT; both originate in the DSH backend process and reach web-console directly — no local webserver route is involved.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### A route that follows the catalog

The registration mirrors the catalog ([src/index.ts](src/index.ts), `syncRegistration`): the route registers only when models exist, withdraws to a dormant zero-route posture when the list empties (the handle is kept and restored in place on the next grant), and is left untouched when a fetch returns nothing new — so the selector does not reload for nothing.

### Refresh on four triggers

The catalog refreshes on `platform-user/verified` (the event carries the fresh token), on an adaptive self-rescheduling interval (fast while empty, slow once populated), on `loader/volatile-update` (base-URL change), and opportunistically when the selector reads a stale list. A failed refresh logs a warning and keeps the last catalog; an expired login waits silently for the next verification.

### Employee-facing failure copy

A generic OpenAI-protocol adapter does the protocol work; an outer wrapper ([src/adapter.ts](src/adapter.ts)) rewrites failures into employee-facing messages. Calling an enterprise model without a signed-in identity fails with an explicit login-first error instead of a protocol diagnostic.

### Image input injection

The adapter injects the durable attachment service and the image-access bridge (`resolveAttachments` / `resolveImageAccess` in [src/index.ts](src/index.ts)) the same way the base-mounted llm-pi-ai plugin does: a catalog model declared with `imageInput` accepts attached pictures, and the attachment host path is mapped into the current tool execution world through the `fs` service. Without these injections a picture-bearing request fails with the pi-ai `UNSUPPORTED_CONTENT` diagnostic even when the model declares image input.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [Enterprise LLM quota design](../../../docs/plans/2026-09-27-enterprise-llm-quota-design.md) — grants, quotas, and the proxy contract owned by web-console.

-----

<a id="model-experience"></a>
## Model Experience

None, as the adapter forwards already-assembled requests to the enterprise quota proxy unchanged.

#### KV Cache effect

Model selection changes rebuild the request's model field but not the conversation prefix; catalog refreshes never touch in-flight sessions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Employee-visible models only** — the catalog is exactly what web-console grants the signed-in employee; there is no local override or addition.
- **Catalog trails grants** — a newly granted model appears at the next refresh (adaptive interval, selector read, or login event), not instantly.
- **Governance stays upstream** — the package cannot grant, revoke, or reprice models; those actions live in web-console.
- **Dormant while signed out** — with no login identity the route withdraws entirely; requests are not queued for a later login.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Quota accounting, model grants, and the OpenAI-compatible proxy contract are owned by web-console; the fallback context-window and max-tokens values here only fill catalog gaps. No runtime invariant companion is published: proxy routing and catalog lookup are covered directly by the package's behavior tests, with no independently maintained observation that can diverge. No open work here.

</details>
