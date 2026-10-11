---
description: "HTTP endpoint that permanently deletes one archived session (JSONL artifact directory, pending registration, projection-cache record, plus workspace registry bookkeeping)."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-delete

English | [中文](README.zh.md)

## Summary

`dsh-session-delete` adds one route to the local webserver: `POST /api/enterprise/sessions/delete` permanently removes an archived session. Archive membership is the safety gate, since an archived session has no live writes. The endpoint drops the in-process pending registration, deletes the JSONL artifact directory and projection-cache record, detaches the id from every workspace, unarchives it, and emits `api-session/removed` so connected clients drop the list row immediately. A write handle still holding the id is refused with 409 before the disk is touched; a missing artifact skips directory removal, so retries converge. No configuration; registers nothing model-facing.

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

Mount this package on any profile that runs the local webserver with JSONL session persistence and the workspace registry; the delete touchpoint then lives at `POST /api/enterprise/sessions/delete`. The plugin declares no configuration of its own — it discovers the persistence root from the mounted persistence backend, so there is nothing to point at the storage location. Callers are administrative UI (the enterprise workbench's archived-session list); the route is not part of any agent conversation flow.

### What the endpoint does

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/enterprise/sessions/delete` | Body `{ "sessionId": "<id>" }`; drops the archived session's in-process pending registration, deletes its JSONL artifact directory and projection-cache record, detaches the id from every workspace, unarchives it, emits `api-session/removed` so connected clients drop the list row immediately, and answers `{ deleted: "<id>" }` |

Failures are JSON errors with one status per cause:

| Status | Meaning |
|---|---|
| 400 | body missing, malformed, over 64KB, or `sessionId` is not a non-empty string |
| 405 | method is not POST |
| 409 | the session is not archived; or a write handle still holds the id (`code: "session-in-use"`) — restart the app and retry |
| 500 | the persistence backend does not expose a JSONL root, or the resolved directory escapes the root |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Archive membership is the deletion gate

Deletion requires the id to sit in the registry's archived set ([src/index.ts](src/index.ts)). The archive gate blocks every `agent/pre-step` wake and an unforced archive refuses active sessions, so "archived" is exactly the condition under which no live write can still touch the artifact. Anything else answers 409.

### Pending registration first, then artifact, then bookkeeping

The delete sequence first drops the process's created-but-unmaterialized registration — a write handle still holding the id refuses with 409 there, before the disk is touched, because a leftover handle's later writes could rebuild the deleted artifact (the ghost-session failure mode). It then removes the JSONL directory, drops the session's projection-cache record, detaches the id from every workspace's accounted list, and unarchives it from the registry-global set. A created-but-unmaterialized session has no artifact on disk: its only existence is the JSONL backend's in-process pending registration and the projection-cache checkpoint written at session creation, so skipping either cleanup leaves the id listed forever. A snapshot absent from persistence (artifact already deleted externally) or a missing directory skips the removal and clears the bookkeeping directly, so a failed or interrupted deletion always converges on retry. A containment check keeps the removed directory inside the persistence root before `rm` runs.

### A cold delete announces itself through `api-session/removed`

The client session-list store applies incremental removals only through the `api-session/removed` Remote event; everything else arrives via its ordered baseline. The Host emits that event when a live session is disposed, but a deleted cold session has no live lifecycle — nothing else would ever signal its disappearance. The endpoint therefore emits the event itself, after every cleanup step has succeeded, so connected clients drop the row immediately instead of serving a dead entry (clicking it would answer `session/not-found`) until the next restart rebuilds the baseline. The refusal paths (409, 500) never emit: the disk state still backs the row.

### The root is probed, not configured

The plugin copies no storage configuration: it reads the root from the mounted persistence backend's own config and rejects a non-JSONL backend with a 500 instead of guessing a directory layout.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [Deployment architecture](../../../docs/plans/dsh_enterprise_architecture_v5.html) — where the local webserver sits in the v5 topology.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is archived-session artifact deletion; it registers nothing model-facing.

#### KV Cache effect

Deletion happens after sessions have already ended; the endpoint touches artifact files and registry bookkeeping, never a live model context, so no cached conversation prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Archived sessions only** — the route refuses anything the registry has not archived (409); deleting a live or merely closed session is out of scope by design.
- **Write-handle liveness blocks deletion** — a live agent left over from an earlier conversation holds the write handle until the process exits; deletion then answers 409 (`code: "session-in-use"`) and needs an app restart to release the handle. Disposing the agent in-process would need a dispose-by-id seam in the agent registry; deferred.
- **JSONL backend only** — a non-JSONL persistence backend answers 500 instead of guessing a directory layout.
- **Retry-driven convergence** — a crash between the artifact delete and the bookkeeping writes leaves the id listed until a retry; the next call skips the directory removal (missing directory or absent snapshot) and converges.
- **No undelete** — removal is permanent; there is no trash, soft-delete, or restore path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The delete order mirrors the registry's own archive flow in reverse; if unarchive semantics change there, this sequence changes with them. No runtime invariant companion is published: the ordered delete sequence is covered directly by the package's behavior tests, with no independently maintained observation that can diverge. No open work here.

</details>
