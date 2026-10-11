---
description: "HTTP proxy for /dsh/tasks and /dsh/history from the DSH webserver to the flowable-engine."
kind: "package-reference"
---

# @deepseek-ai/dsh-flowable-task-proxy

English | [中文](README.zh.md)

## Summary

`dsh-flowable-task-proxy` forwards the employee task API from the local DSH webserver to the flowable-engine. The prefix routes `/dsh/tasks` and `/dsh/history` relay pathname, query, body, and the signed-in employee's JWT to the engine verbatim and pass the upstream response back unchanged. The deployment topology requires browser surfaces to reach server-side services only through the local webserver; this package is that bridge for the task endpoints.

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

Use this package on the enterprise profile whenever browser surfaces need the engine's task API: the employee task workbench fetches `/dsh/tasks/*` relative to the webserver origin, and without this proxy those requests fall through to the SPA fallback and return HTML. Engine-side task completion endpoints use the same paths and ride the same proxy.

### Minimal configuration

`engineBaseUrl` is required with no default: a composition that omits it fails at load.

```yaml
- name: '@deepseek-ai/dsh-flowable-task-proxy'
  config:
    engineBaseUrl: 'http://flowable-engine:8090'
```

| Field | Default | Meaning |
|---|---|---|
| `engineBaseUrl` | required | flowable-engine base URL (protocol, host, port); volatile — the settings panel can change it without a reload |

### What is forwarded

| DSH route (prefix) | Upstream |
|---|---|
| `/dsh/tasks` | `{engineBaseUrl}/dsh/tasks/...` |
| `/dsh/history` | `{engineBaseUrl}/dsh/history/...` |

Pathname and query pass through verbatim; only `authorization` and `content-type` request headers cross the boundary; non-GET bodies are buffered and forwarded whole.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Verbatim forwarding

The proxy is deliberately thin ([src/index.ts](src/index.ts)): it rewrites only the origin, whitelists two request headers, buffers the request body for non-GET methods, and writes the upstream status and body back unchanged (the upstream content-type passes through, defaulting to JSON). No caching, no retry, no reshaping.

### Failures are JSON, never HTML

Two failure kinds answer with a JSON 502 instead of an HTML error page: an unreachable upstream, and an invalid `engineBaseUrl`. The base URL is volatile — every forward reads the current value, so a settings-panel change takes effect without a reload, and a bad value degrades that request only.

### Why the proxy exists

The v5 topology has every browser surface call the local webserver, never a server-side service directly. The engine serves the task API under its own `/dsh` namespace; this package mirrors those paths on the webserver so relative fetches from the workbench land on the engine.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [Enterprise architecture v5](../../../docs/plans/dsh_enterprise_architecture_v5.html) — the deployment topology that motivates the proxy-only rule.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is pure HTTP forwarding for task endpoints; it registers nothing model-facing.

#### KV Cache effect

Requests served here never touch model context; nothing this package does can invalidate a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Forward-only** — no caching, retry, or request rewriting; a failed forward is a JSON 502 and the caller retries.
- **Header allowlist** — only `authorization` and `content-type` cross the boundary; other request headers are dropped.
- **Small-body assumption** — non-GET bodies are buffered whole before forwarding; task submissions are small JSON, and large uploads are not the target use.
- **Two prefixes only** — `/dsh/tasks` and `/dsh/history` are proxied; other engine namespaces have no route here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Task state, claiming, and completion semantics are owned by flowable-engine; this package carries bytes only. No runtime invariant companion is published: the proxy is stateless byte-forwarding between two prefixes, with behavior covered directly by the package's proxy tests. No open work here.

</details>
