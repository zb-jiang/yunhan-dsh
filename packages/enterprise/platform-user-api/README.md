---
description: "HTTP API routes for platform-user authentication (/auth/me, /auth/config)."
kind: "package-reference"
---

# @deepseek-ai/dsh-platform-user-api

English | [中文](README.zh.md)

## Summary

`dsh-platform-user-api` exposes the employee-side authentication touchpoints over the local webserver: `GET /api/enterprise/auth/me` verifies an auth-center JWT and announces `platform-user/verified`, `POST /signout` announces `platform-user/signout`, `GET /config` hands the browser the auth-center parameters branched by `provider`, and `POST /connectivity-check` probes server URLs from Node where browsers cannot. For non-supabase providers it additionally brokers the OIDC authorization-code + PKCE flow: `GET /oidc/authorize` redirects the browser to the provider's authorization endpoint, and `POST /oidc/token` / `POST /oidc/refresh` exchange codes and refresh tokens from Node so the client secret never enters the browser. The plugin holds no state; identity-cache consumers subscribe to the events.

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

Use this package on the enterprise profile as the login integration point: the browser login flow verifies itself against `/me`, the settings panel reads `/config` and probes targets via `/connectivity-check`, and the signout touchpoint tells the local cache to drop the identity. Governance writes (register, approve, disable, lock, restore, roles, audit) live in the web-console backend, not here.

### Minimal configuration

The first seven fields are required with no default: a composition that omits one fails at load. The enterprise-app patch fills them from `SSO_*` environment variables, so deployments usually configure the auth center through env vars only. `provider` picks the auth center: `supabase` keeps the direct-to-Supabase browser login, `casdoor` / `customer-oidc` switch to a generic OIDC provider. `oidcRelayUrl` is optional (defaults to the empty string) and only affects the callback relay for Pocket Access phone logins.

```yaml
- name: '@deepseek-ai/dsh-platform-user-api'
  config:
    provider: 'supabase' # supabase / casdoor / customer-oidc
    supabaseUrl: 'https://your-project.supabase.co'
    supabaseAnonKey: 'your-anon-key'
    issuer: ''
    jwksUrl: ''
    clientId: 'employee-web'
    scopes: ''
    oidcRelayUrl: '' # relay base URL for Pocket Access phone logins (web-console); empty = disabled
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Auth center type: `supabase / casdoor / customer-oidc`; volatile |
| `supabaseUrl` | required | Supabase project URL; empty is the legal "not yet configured" initial state (first-run guidance); volatile |
| `supabaseAnonKey` | required | Supabase anon key for browser-side Supabase Auth; volatile |
| `issuer` | required | Auth-center issuer URL; empty derives from `supabaseUrl` (`<url>/auth/v1`) under supabase; non-supabase providers require it non-empty; volatile |
| `jwksUrl` | required | JWKS endpoint; empty derives `<issuer>/.well-known/jwks.json`; volatile |
| `clientId` | required | RP client id registered at the auth center; non-supabase providers require it non-empty; volatile |
| `scopes` | required | OIDC authorization-code scopes; empty falls back to `openid profile`; volatile |
| `oidcRelayUrl` | `''` | Relay base URL for Pocket Access phone logins (web-console); non-loopback access with it non-empty points redirect_uri at its relay callback, empty disables and falls back to the root-path callback; volatile |

### What each endpoint does

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/enterprise/auth/me` | Verifies the `Authorization: Bearer` JWT, returns the user record, emits `platform-user/verified` with the raw token |
| POST | `/api/enterprise/auth/signout` | Emits `platform-user/signout`, answers 204 |
| GET | `/api/enterprise/auth/config` | Returns `{ mode: 'supabase', url, anonKey }` (top-level fields kept for the current login UI) or `{ mode: 'oidc', issuer, clientId, scopes, relayUrl }`, branched by `provider`, read fresh per request; a non-supabase provider with an empty `clientId` answers 400 |
| POST | `/api/enterprise/auth/connectivity-check` | Probes a URL from Node (any HTTP status counts as reachable), 5s timeout |
| GET | `/api/enterprise/auth/oidc/callback` | Authorization-code callback landing point (an API path the webserver auth wall does not intercept): the iframe login reads the URL for the code, the full-page flow bounces back to the root path via an inline script; missing `code`/`state` answer 400 |
| POST | `/api/enterprise/auth/oidc/relay-register` | OIDC mode only: forwards `{ state, returnOrigin }` to the web-console relay register endpoint (the browser never talks to web-console directly, no CORS surface); missing `oidcRelayUrl` or fields answer 400, upstream failures answer 502 |
| GET | `/api/enterprise/auth/oidc/authorize` | OIDC mode only: resolves the provider's authorization endpoint via discovery and 302s the browser there with `code_challenge` + `state`; non-OIDC mode or missing query fields answer 400 |
| POST | `/api/enterprise/auth/oidc/token` | OIDC mode only: exchanges `code` + `codeVerifier` for `{ token, refreshToken, expiresIn }` (token is the id_token used as Bearer); discovery or upstream failures answer 502 |
| POST | `/api/enterprise/auth/oidc/refresh` | OIDC mode only: exchanges a refresh token for a fresh `{ token, refreshToken, expiresIn }` pair; non-OIDC mode answers 400 |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Events, not state

The plugin keeps no identity state ([src/index.ts](src/index.ts)): a verified `/me` call emits `platform-user/verified` carrying the raw access token — consumers such as the identity cache and skill sync then act as the signed-in employee against server APIs — and the signout touchpoint emits `platform-user/signout`. Until a client calls `/me`, subscribers do not learn of a login.

### Why connectivity-check runs in Node

The engine, web-console, and SkillHub endpoints do not enable CORS, so a browser-side probe would misreport correctly configured servers as unreachable. The endpoint therefore fetches from Node, where any HTTP status means "the host answered"; only http/https URLs are accepted.

### Why the anon key is not marked secret

A secret-typed config field is permanently masked once read over the wire, so the settings panel could never display it again. The anon key is public by design; the panel masks it in its own UI, and the webserver binds to localhost only.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [SSO auth center design](../../../docs/plans/2026-10-11-sso-auth-center-design.md) — the auth-center design these endpoints serve.

-----

<a id="model-experience"></a>
## Model Experience

None, as these are auth endpoints and configuration projection; they register nothing model-facing.

#### KV Cache effect

Sign-in and sign-out change which identity subsequent requests carry, not the model context; nothing here touches a cached conversation prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Events fire only on API calls** — `platform-user/verified` emits when a client fetches `/me`; there is no push channel from Supabase, and a component that never calls the endpoints never sees the login.
- **Read-only projection** — the endpoints expose no governance write path; register, approve, disable, lock, and roles stay in web-console.
- **Probe is a plain GET** — connectivity-check counts any HTTP status, including error pages, as reachable; it answers "is the host there", not "is the service healthy".
- **Unauthenticated config surface** — `/config` hands out the auth-center coordinates without authentication; safe because the webserver binds to localhost, and wrong if that ever changes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Identity verification itself (JWT validation, user lookup, status checks) is owned by dsh-platform-user; this package is route plumbing plus the two event touchpoints. No runtime invariant companion is published: the routes are thin plumbing over platform-user verification, with behavior covered directly by the package's endpoint tests. No open work here.

</details>
