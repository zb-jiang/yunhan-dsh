---
description: "Enterprise workbench UI: auth gate + task-queue sidebar + task-archive details over the three-column shell."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enterprise

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-enterprise` is the browser half of the enterprise workbench: an auth overlay that gates the whole shell on Supabase sign-in and approval status, a task-queue sidebar (todo and completed groups) mounted into the native sidebar nav, and a task-archive tab in the right sidebar. First click on a todo opens an explicit workspace picker, creates a dedicated session, and prefills the node prompt without overwriting edits; submit routes through the mapping dialog and records the receipt. Knowledge-base pickers, chips, '@' triggers, upload actions, service settings, and archived-session deletion round out the surface.

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

This package is the `./client` bundle of the enterprise web client: the host-side entry is an empty `apply()`, and everything below runs in the browser. It pairs with the enterprise profile's server plugins — the auth overlay talks to dsh-platform-user-api, the task queue reads the flowable proxy, and the knowledge surfaces talk to the knowledge plugin.

### Where each piece mounts

| Seat | Component | Role |
|---|---|---|
| `shell.overlay` | EnterpriseOverlay | auth gate: login page, service-config dialog, blocked states (pending approval, disabled, locked) |
| `shell.overlay` | PocketPairingExpired | pocket pairing-expiry page: probes the proxy gate once disconnected and covers the frame when the pairing is revoked/expired, LAN access is off, or the proxy stopped responding (master switch off / desktop down); the probe carries a short timeout (a TCP failure against a dead listener can hang tens of seconds in real networks), the stopped-responding page keeps polling and unmounts itself once the proxy is back, while the other conclusions are terminal; reachable only through the proxy, so the PC connects directly and never triggers it |
| `sidebar.nav` | TaskQueueSidebar | todo + completed queue in the native sidebar's enterprise branch |
| `sidebar.right.pane.tab` | TaskArchivePanel | the archive tab (two-stage: type declaration plus keyed body) |
| `conversation.input.left` / `conversation.input.dock` | KbPickerButton / KbChipsDock | knowledge-document picker entry and selected-doc chips |
| `sidebar.files.entry.action` | KbUploadAction | per-file-row "upload to knowledge base" |
| `settings.section` | EnterpriseServicesSection | aggregated enterprise service config page |
| session menu / row / overlay | DeleteSession trio | archived-session delete entry and confirm dialog |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Slots compose; the workbench orchestrates

One `EnterpriseWorkbench` is constructed in apply and distributed through each occupant's inject ([src/client/index.ts](src/client/index.ts)). Registrations land in seats declared by other packages, so they go through `ctx.slots.inject` and register only after the declarer mounts; the archive tab registers its type and body in two stages.

### The auth gate is also the identity pump

The Supabase session persists in localStorage with auto refresh. On `TOKEN_REFRESHED` the overlay re-pulls `/me`, which both refreshes the local user snapshot and hands the webserver's identity cache the new token — every daemon polling `platform-user/verified` follows. On `SIGNED_OUT` (this tab or another, via storage events) the frame is covered again.

### Todos never overwrite employee work

Prompt prefill writes through the conversation draft path only when the draft is empty; failures surface as a sidebar notice. The first click on an unbound todo requires an explicit workspace confirmation — cancel produces no session. Bindings persist in localStorage so a refresh returns to the same session, and skill readiness degrades with a notice instead of blocking the session. Clicking a completed task reopens its submitting session first; when that session no longer exists (cleared locally), the main view falls back to a fresh new session and the task archive shows read-only in the right sidebar.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../../enterprise/README.md) — the server-side enterprise packages this UI works with.
- [Deployment architecture](../../../docs/plans/dsh_enterprise_architecture_v5.html) — where the browser, local webserver, and enterprise servers sit in the v5 topology.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is browser-side enterprise workbench UI; it renders state and registers no prompt, tool, or session event.

#### KV Cache effect

Everything here reads stores and renders DOM; prompt prefill and kb chips travel through the conversation input and become ordinary session events when sent, so the UI itself never touches a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Web platform only** — the bundle targets the web client platform; there is no desktop variant.
- **Renders server state** — queues and archive mirror the engine through the local webserver; when the engine is unreachable the sidebar shows the error, nothing more.
- **Ports asserted, not upstream** — task creation and tab opening go through structured ports asserted inside this package; upstream contracts stay untouched, so an upstream change can silently invalidate an assertion.
- **localStorage-bound bindings** — task↔session bindings and completed receipts live in the browser; clearing site data forgets them, while engine history remains.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The per-file-row upload slot `sidebar.files.entry.action` is an enterprise deviation coexisting with upstream's header-action slot; see the repo AGENTS.md merge-preserve notes before touching it. No open work here.

</details>
