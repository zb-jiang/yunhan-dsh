---
description: "Phone-access LAN/WAN proxy that publishes the employee desktop webserver behind a paired-device gate and a same-account identity check, with management routes for pairing, devices, and a Cloudflare tunnel."
kind: "package-reference"
---

# @deepseek-ai/dsh-pocket-access

English | [中文](README.zh.md)

## Summary

`dsh-pocket-access` publishes the employee desktop webserver to a phone on your LAN. Enable it and a proxy listens on `0.0.0.0` beside the webserver, admitting only requests that carry a paired-device cookie or a same-account Bearer token. Management routes under `/api/enterprise/pocket` drive pairing codes, device revocation, and an optional Cloudflare tunnel that extends the same proxy to the public internet behind an explicit risk disclaimer. Access events — enable/disable, pairing, revocation, identity rejections, tunnel lifecycle, LAN-disabled hits — are buffered locally and reported in batches to the web-console audit log. The package adds no model-facing behavior.

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

Mount this package in the enterprise bundle beside the local webserver. When enabled it listens on `0.0.0.0:<bindPort>` — default 3081, auto-incremented when the port is occupied — and forwards to the webserver behind two gates: a paired-device cookie issued against a pairing code, and a same-account Bearer check that mirrors the desktop login. A Cloudflare tunnel can additionally publish the proxy to the public internet; starting it requires an explicit risk disclaimer.

### Configuration

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean, volatile | Master switch; toggling starts or stops the proxy at runtime |
| `bindPort` | integer | Proxy listen port; auto-increments to the next free port when occupied |
| `lanEnabled` | boolean, volatile | LAN access switch; disabling rejects LAN sources and immediately closes all active phone tunnels |
| `lanIpOverride` | string, volatile | Manual LAN address override; `''` restores auto-detection |
| `heartbeatEnabled` | boolean | WebSocket heartbeat injection; takes effect after a restart |
| `tunnelEnabled` | boolean, volatile | Tunnel on-wish switch; toggling persists the wish and starts or stops the tunnel — the actual state lives in the tunnel state machine |
| `tunnelMode` | `quick` \| `named`, volatile | Tunnel mode; changes only affect the next start |
| `tunnelHostname` | string, volatile | Named-tunnel public hostname; changes only affect the next start |
| `cloudflaredPath` | string | Explicit `cloudflared` executable path; `''` falls back to a `PATH` lookup (no automatic download — install `cloudflared` yourself). Takes effect after a restart |
| `webConsoleBaseUrl` | string, volatile | Audit reporting target web-console base URL; `''` falls back to the `WEB_CONSOLE_URL` env, then the local default `http://127.0.0.1:8080` |

`POCKET_BIND_PORT` overrides `bindPort` through the enterprise bundle patch. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-pocket-access) is the exhaustive source for every accepted field.

### Management routes

Routes live under `/api/enterprise/pocket` and answer only loopback `Host` headers from loopback sources. Every mutation returns the full snapshot.

| Route | Meaning |
| --- | --- |
| `GET /status` | Full snapshot (ports, handshake availability, LAN address with QR, devices, pairing code with QR, desktop identity, tunnel state) |
| `POST /enabled` | Body `{ "enabled": boolean }` — persists the switch and starts or stops the proxy |
| `POST /lan` | Body `{ "enabled": boolean }` — LAN access switch |
| `POST /lan-override` | Body `{ "ip": string }` — manual LAN address, `''` restores auto-detection |
| `POST /pairing` | Body `{ "action": "create" }` issues a new code; `{ "action": "revoke", "deviceId": string }` revokes a device |
| `POST /tunnel` | Body `{ "action": "start" \| "stop", "disclaimer": boolean }` — `start` requires `disclaimer: true` and returns immediately (the snapshot shows `state=starting`); `stop` tears the tunnel down and deletes the restore marker |
| `POST /tunnel-config` | Body `{ "mode"?: string, "hostname"?: string }` — tunnel mode and named hostname; `''` clears the hostname. Invalid values are rejected with 400 |
| `POST /tunnel-token` | Body `{ "token": string }` — named-tunnel token, persisted at mode 0600; `''` clears the stored token |

Employee signout (`platform-user/signout`) clears all paired devices and immediately closes all active WS tunnels; revoking a single device likewise closes that device's tunnels right away (the close frame carries a reason), so the phone notices the disconnect immediately. Its reconnect is rejected by the pairing gate with a 401 JSON body carrying a machine-readable `code` (`device-revoked` / `device-unpaired`); the phone UI probes the gate once disconnected and renders a full-screen expiry page (reason + re-pairing hint) instead of spinning on "reconnecting" forever. Turning the LAN switch off closes all tunnels the same way, and the probe is then answered 403 by the LAN gate ("LAN access disabled"); turning the master switch off stops the listener entirely, the probe fails at the network level, and the phone renders a "connection lost" expiry page. Once the master switch is back on, that page keeps polling in the background and disappears on its own.

### Audit reporting

The plugin records access events — proxy enable/disable, device paired/revoked, identity rejection, tunnel start/stop, LAN-disabled hit — and reports them in batches of at most 100 to the web-console endpoint `POST /api/pocket/access-events` with the employee JWT. Failed reports are buffered in `pocket-access/audit-backlog.jsonl` (mode 0600) in the user data directory and replayed at startup and after every successful report; the buffer keeps at most 1000 events and drops the oldest beyond that. The status snapshot carries `audit.backlog`, so the UI can surface pending events.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the proxy; the observable behavior is covered in [Use this package](#use-this-package). The design document [Pocket Access design](../../../docs/plans/2026-10-09-pocket-access-design.md) owns the gate model and threat assumptions.

### The proxy pipeline

The HTTP pipeline runs a fixed order — strictest of source/Host classification, management-route denylist, LAN switch, pairing gate, identity gate, header rewrite, desktop-param scrubbing, launch-token injection, forward. WebSocket upgrades pass the same gates; the proxy answers the 101 handshake itself and injects ping frames (two silent cycles tear the tunnel down). Compressible JSON/HTML responses are brotli- or gzip-compressed on the way out.

### Paired devices and pairing codes

Paired devices persist as HMAC-signed cookies backed by a `devices.json` store (mode 0600) in the user data directory; revocation and expiry are enforced on every request. Device cookies are host-scoped, so the same phone pairs once per entry point (LAN and WAN) — on success the pairing reuses an active device with the same UA (refreshing lastSeenAt and re-signing the cookie without consuming the device limit), and only a different or empty UA creates a new record, so both entry points surface as one device row, shown with the entry point of the most recent pairing (WAN/LAN; records from before this capability display "—"). Pairing codes are 8 characters, live 5 minutes; the pairing endpoint redeems a `?code=` GET directly (a scan completes the pairing with no code entry), and rate limiting protects both code attempts and handshake injections.

### Tunnel modes and lifecycle

The tunnel runs a Cloudflare `cloudflared` child process that publishes the proxy to the internet. Two modes:

- **Quick** — no Cloudflare account needed. The public URL is assigned by Cloudflare and changes across restarts; the snapshot carries it in `tunnel.url` (only quick mode ever populates it).
- **Named** — uses your own Cloudflare account and a fixed hostname. Requires a tunnel token (persisted in `tunnel-token.json`, mode 0600; the snapshot only reports `tokenSet`, never the token). The snapshot's `tunnel.url` stays `null`; the UI composes `https://<hostname>` itself.

`cloudflared` is never downloaded by the program: it resolves to the explicit `cloudflaredPath` config when set, otherwise a `PATH` lookup (Windows `cloudflared.exe`, other platforms `cloudflared`). Install it yourself (Windows `winget install --id Cloudflare.cloudflared`, macOS `brew install cloudflared`, or the official installer); when the lookup misses, the start request fails with a 400 whose message carries per-platform install instructions, and the tunnel card shows the same hint in its `error` state. A named hostname is normalized (lowercased, scheme/path/port stripped) and must be a multi-label domain — bare IPs and single-label hostnames are rejected with 400.

Starts are validated synchronously and launched asynchronously: the route returns right away with `state=starting`, and the UI polls the snapshot until `running` or `error`. The server refuses `action: "start"` without `disclaimer: true` — the settings page shows a risk dialog and only sends the flag after explicit confirmation.

Restores across restarts are marker-driven: `tunnel-marker.json` records whether the tunnel was running. Stopping the tunnel through the route deletes the marker; a passive host shutdown keeps it, so the next start re-launches the tunnel automatically without a disclaimer prompt.

Failures (missing `cloudflared` in `PATH`, process exit, readiness timeout) surface as `state=error` with a summarized `detail`; `tunnelEnabled` stays on so the card can retry.

While the tunnel runs, the settings-page pairing QR code switches to the public address (quick uses the assigned URL, named is built from the hostname) — the public origin is reachable from the LAN too (via the Cloudflare edge), so one QR code serves both networks; without a tunnel it falls back to the LAN address.

### Audit reporting and the backlog

The backlog file is the write-through authority: every `record` appends to memory and rewrites the JSONL file before the fire-and-forget upload runs, so a crash never loses a recorded event. Uploads run single-flight in batches of at most 100; a successful report splices the uploaded prefix, a failure schedules a 30 s retry, and reporting is skipped entirely — without queuing retries — while no web-console URL or employee token is available. The snapshot call (`GET /status`) triggers a `maybeFlush` probe, so a signed-in desktop drains its backlog through the UI's regular polling without waiting for the next event.

Which actions record is deliberate: toggling the master switch records only on an actual state change (config-driven auto-starts bypass the toggle route), tunnel start records only for a manual start (a passive restore across restarts is not a human action), tunnel stop records only when a tunnel was actually running or starting, and device revocation carries the reason (`manual` for a single revoke, `signout` for the signout sweep).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the bundle composes them.
- [Pocket Access design](../../../docs/plans/2026-10-09-pocket-access-design.md) — the gate model, milestones, and threat assumptions.
- [Deployment architecture](../../../docs/plans/dsh_enterprise_architecture_v5.html) — where the local webserver sits in the v5 topology.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package proxies browser traffic and manages tunnels; it registers no prompt, tool, or session event.

#### KV Cache effect

The proxy sits between the phone browser and the local webserver and never touches an agent conversation, so no model request or cached prefix changes through it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Quick-tunnel URLs are not stable** — Cloudflare assigns them per run and they change across restarts; a fixed address requires a named tunnel with your own Cloudflare account.
- **`cloudflared` is never downloaded** — the package resolves the explicit `cloudflaredPath` config or a `PATH` lookup and fails the start with a 400 when the executable is missing; installing it is on you.
- **Token and device stores are plain local files** — `tunnel-token.json` and `devices.json` rely on filesystem mode 0600 inside the user data directory; there is no additional at-rest encryption.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Milestones M1, M2, and M3 are delivered: M1 shipped the proxy, the management routes, and the settings-page base (including the pairing-and-devices and desktop-identity cards); M2 shipped the access audit trail — local event buffer with batched reporting to the web-console audit log; M3 shipped the WAN tunnel — cloudflared lifecycle, quick and named modes, the auto-restore marker, the token store, and the disclaimer-gated WAN card. No runtime invariant companion is published: every assertion for the two gates (device-cookie HMAC check, same-account identity comparison) and the listener lifecycle (started and stopped with the enabled switch) derives only from the plugin's own state — the device list, `Config.enabled`, and the proxy server handle — all covered by direct unit tests, so no independent observation source exists that can diverge.

</details>
