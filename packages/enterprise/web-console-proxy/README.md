---
description: "Shared webserver prefix forwarder: browser surfaces reach web-console only through the local DSH webserver, with the signed-in employee's JWT attached and JSON error responses."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-console-proxy

English | [中文](README.zh.md)

## Summary

`dsh-web-console-proxy` is the shared HTTP forwarder behind the enterprise plugins' local-webserver prefix proxies. Enterprise plugins register a `{ kind: 'prefix' }` route (for example `/api/enterprise/kb`) and delegate the handler to `proxyRequest`, which rewrites the prefix to the web-console path, attaches the signed-in employee's JWT, and copies the upstream response back verbatim. Every failure mode answers JSON — 401 when unsigned-in, 502 for an invalid base URL or an unreachable upstream — so the browser never parses an HTML error page. `knowledge` and `instance-workspace` consume this module; it owns no routes or state of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when a plugin must expose web-console REST to the browser surface through the local webserver. Pass the base URL and the login token as getter functions — both are read per request, so volatile settings and fresh sessions take effect without a reload.

### Minimal configuration

```ts ignore-check
import { proxyRequest } from '@deepseek-ai/dsh-web-console-proxy'

ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/api/enterprise/kb',
  handler: (req, res) => proxyRequest(
    { baseUrl: () => config.webConsoleBaseUrl.get(), token: () => ctx.get('currentUser')?.getToken() },
    '/api/enterprise/kb',
    '/api/kb',
    req,
    res,
  ),
}), 'knowledge: /api/enterprise/kb prefix route')
```

| Member | Meaning |
|---|---|
| `proxyRequest(options, localPrefix, upstreamPrefix, req, res)` | Forward one browser request to web-console and copy the upstream response back |
| `options.baseUrl` | web-console base URL (protocol, host, port), read per request |
| `options.token` | The signed-in employee's JWT, or `undefined` when logged out (answers 401) |
| `options.unauthorizedMessage` | Optional domain copy for the 401 body; defaults to a generic message |
| `validateBaseUrl(value)` | Returns an error message when the value is not a parseable URL; `undefined` when valid |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Forwarder contract

The suffix after `localPrefix` is re-attached to `upstreamPrefix` together with the incoming query string. `content-type` is forwarded when present; bodies of methods other than GET/HEAD are buffered whole and re-sent, which covers the JSON and multipart bodies the enterprise surfaces use. The upstream status code and body pass through unchanged, with `content-length` recomputed for the buffered copy.

### Error responses are JSON

Three failure modes answer JSON before any upstream call or on transport failure: 401 with the unauthorized message, 502 when `baseUrl` does not parse, and 502 with the fetch error text when web-console is unreachable. This keeps browser error handling on one shape and mirrors the tool-side error contract in the knowledge and instance-workspace packages.

<a id="model-experience"></a>
## Model Experience

None, as this module is a shared HTTP forwarder; it registers nothing model-facing.

#### KV Cache effect

Requests forwarded here never touch model context; nothing this module does can invalidate a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the module does not attempt. They are current constraints, not a task backlog.

- **Single upstream per call** — one request maps to one web-console base URL; there is no retry, fan-out, or streaming pass-through (bodies are buffered whole).
- **JWT only** — the forwarder attaches a Bearer token; the service-key face of the enterprise APIs is called directly by the tools, not through this module.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The module is a pure function over `node:http` types with no Cordis, webserver, or identity dependency; consumers keep route registration and option wiring. No runtime invariant companion is published: forwarding, prefix rewriting, and error responses are covered directly by the package's behavior tests, with no independently maintained observation that can diverge. No open work here.

</details>
