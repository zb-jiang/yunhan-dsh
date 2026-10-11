---
description: "Platform-user governance seam (ctx.platformUsers) for enterprise account approval, roles, and status management."
kind: "package-reference"
---

# @deepseek-ai/dsh-platform-user

English | [中文](README.zh.md)

## Summary

`dsh-platform-user` is the platform-user governance Service Definition (`ctx.platformUsers`): the Harness-side record layered over an external identity backend such as Supabase Auth. It covers pending-approval registration, platform-role assignment, lookup by auth subject, and administrative disable/lock/restore. Providers mount through `registerProvider`; the seam validates role names, duplicate roles, and status transitions before the provider is called.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Consume `ctx.platformUsers` from a provider package (which mounts the backend adapter) or from a consumer that reads and manages governance records. Service API:

- `registerProvider(provider)` — mounts the one active provider. Duplicate providers fail loud with `PlatformUserError` code `DUPLICATE_PROVIDER`.
- `registerPendingUser(request)` — creates a pending governance record after the external auth backend has created the subject.
- `getById(id)` / `getByAuthSubject(authSubject)` — read one record.
- `list({ statuses?, role? })` — lists matching records.
- `approve(id, { approvedBy, platformRoles })` — approves only a `pending_approval` user and writes its initial role set.
- `setRoles(id, { changedBy, platformRoles })` — replaces the full platform-role set of an existing user.
- `disable(id, { disabledBy, reason? })` / `lock(id, { lockedBy, reason? })` — administrative state changes.
- `restore(id, { restoredBy })` — returns a `disabled` or `locked` user to `active`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Validation before the provider

The seam validates role names, rejects duplicate roles, and rejects invalid status transitions before the provider is called, so a malformed request never reaches the backend adapter.

### No runtime invariant companion

No runtime invariant companion is published: the seam owns one active provider slot and a single read entry point, with no independent event stream or durable relation outside the provider-backed record itself, and the pre-provider validation lives in the same module the behavior tests cover directly.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-platform-user-console](../platform-user-console/README.md) — the Web Console provider that mounts into this seam.
- [Internal pass SSO design](../../../docs/plans/2026-09-29-internal-pass-sso-design.md) — the Supabase-based identity model this seam serves.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is a governance record seam; it registers nothing model-facing.

#### KV Cache effect

Governance calls happen in webserver request handling, outside prompt assembly; the records this seam returns never enter a prompt or a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **No auth session seam yet** — this package governs Harness-side user records only; login, token refresh, password reset, and SSO handshakes stay in the external identity backend and future consumer packages.
- **No built-in audit stream yet** — the seam returns updated records directly; a later consumer or companion package should publish durable governance audit events.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `platform-user/verified` and `platform-user/signout` event names are a three-package contract: declared here in `src/index.ts`, emitted by `dsh-platform-user-api`, and consumed by `dsh-user-identity-context`, so renaming one requires all three sides to change together. `PlatformUserError` codes and the status-transition validation live in the same `src/index.ts` and run before any provider call, so a provider never sees a malformed record. No open work here.

</details>
