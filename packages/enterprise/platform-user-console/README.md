---
description: "Web-Console-backed provider for the platform-user seam: local JWKS JWT verification plus a /api/users/me self-read with the caller's own token."
kind: "package-reference"
---

# @deepseek-ai/dsh-platform-user-console

English | [中文](README.zh.md)

## Summary

`dsh-platform-user-console` is the Web Console provider of the platform-user seam: it registers into `ctx.platformUsers`, verifies the caller's Supabase Auth JWT locally with JWKS, then reads that user's governance record from the Web Console backend (`GET /api/users/me`) using the caller's own bearer token. It pairs with dsh-platform-user, which resolves the provider by auth method, and holds no service key — every read is the user's own identity.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Register this plugin in a profile whose webserver sits behind the enterprise web client. Plugin contract:

- `inject = ['platformUsers']`
- `Config`
  - `supabaseUrl` — Supabase project URL; only its Auth issuer is used for JWT verification
  - `webConsoleBaseUrl` — Web Console backend base URL, default `http://127.0.0.1:8080`
- `apply(ctx, config)` — resolves config, creates the JWKS key store, and registers the provider

dsh-platform-user resolves the registered provider by auth method, so no other package imports this one directly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### The self-read contract

The provider assumes the Web Console `GET /api/users/me` endpoint returns the `ApiResponse` envelope (`{ success, data, error }`) whose `data` is the camelCase governance record (`id`, `authSubject`, `loginName`, `displayName`, `email`, `status`, `platformRoles`, `createdAt`, and the optional approval/disable/lock trail fields). Unknown fields such as `orgUnits` are ignored. No runtime invariant companion is published: the provider is a thin transport adapter that verifies JWTs locally and reads one backend endpoint per request, with no durable relation to check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-platform-user](../platform-user/README.md) — the seam this provider registers into.
- [Deployment architecture](../../../docs/plans/dsh_enterprise_architecture_v5.html) — where the web console backend sits in the v5 topology.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is a read-only governance identity provider; it registers nothing model-facing.

#### KV Cache effect

JWT verification and the `/api/users/me` self-read happen while resolving the request's identity, before any model context is assembled; the provider contributes no content to a prompt or a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Pending users read as `pending_approval`** — the seam value keeps the backend status; consumers decide whether a pending user may proceed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `ApiResponse` envelope and the camelCase governance-record fields read from `GET /api/users/me` are a contract with the web-console backend (`apps/web-console`); renaming a field must update both sides. The JWKS key store is created once in `apply` from the Auth issuer of `config.supabaseUrl` alone. No open work here.

</details>
