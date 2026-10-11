---
description: "Server-side unattended DSH backend task runner: REST submit/poll endpoints over the webserver, one non-interactive Agent session per task, registry heartbeat and skill sync daemons against web-console."
kind: "package-reference"
---

# @deepseek-ai/dsh-backend-task

English | [中文](README.zh.md)

## Summary

`dsh-backend-task` is the server-side runner behind DSH backend task nodes on the BPMN canvas. The flowable delegate POSTs each node's interpolated prompt, skill refs, and optional knowledge base to `POST /api/backend/tasks`; the package runs every task in its own non-interactive Agent session, parses the final assistant text as JSON, and answers polls at `GET /api/backend/tasks/{taskId}` with running, ready, or failed. Two daemons register the instance with web-console and keep the aggregated skills installed locally.

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

Use this package on the enterprise-backend profile: a resident server instance that executes DSH backend task nodes without a human in the loop. flowable-engine's `DshBackendTaskDelegate` is the only intended caller — it submits and polls; nothing here needs a browser or a signed-in employee.

### Minimal configuration

All fields come from the enterprise-backend profile's cordis.yml. `selfUrl` is the address the delegate uses to reach this instance and doubles as the registry key; `skillhubToken` is the read-only SkillHub distribution token (empty skips manifest and download, relying on already-installed cache).

```yaml
- name: '@deepseek-ai/dsh-backend-task'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
    selfUrl: 'http://backend-1:3190'
    backendName: 'backend-1'
    skillhubBaseUrl: 'http://skillhub:8095'
    skillhubToken: 'read-token'
```

| Field | Default | Meaning |
|---|---|---|
| `webConsoleBaseUrl` | `http://127.0.0.1:8080` | web-console base URL (registry heartbeat and skill attribution target) |
| `selfUrl` | `http://127.0.0.1:3190` | externally reachable URL of this instance (delegate submit target, registry key) |
| `backendName` | `backend-1` | display name in the registry and designer dropdown |
| `skillhubBaseUrl` | `http://127.0.0.1:8095` | SkillHub backend API base URL |
| `skillhubToken` | `''` | read-only SkillHub token; empty skips manifest and download |
| `syncIntervalMs` | `300000` | skill sync daemon interval |
| `registerIntervalMs` | `60000` | registry heartbeat interval |
| `skillDir` | `$DSH_HOME/backend-task/skills` | skill cache directory override |

### What each endpoint does

`POST /api/backend/tasks` with `{ prompt, skillRefs?, kbId?, kbName? }` returns `202 { taskId }`; `kbId`/`kbName` carry the workflow's application knowledge base (both absent when the application has none or resolution degraded). `GET /api/backend/tasks/{taskId}` returns `{ taskId, status, result?, error? }` — `status` moves running → ready (with the parsed JSON `result`) or failed (with a human-readable `error`).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### One non-interactive session per task

Each task creates a fresh Agent session ([src/index.ts](src/index.ts), `runBackendTask`): an optional KB context block (same format as the employee side), a skill-ref prefix, then the node prompt go out as one user message, and the session runs to quiescence. The last assistant text is scanned from its first `{` to its last `}` and parsed as the result.

### Two daemons keep the instance integrated

A heartbeat registers the instance with web-console every 60 seconds (failures log and retry next round). A skill sync pulls the skillRefs aggregated for this instance's URL, installs new or changed skills from SkillHub into the cache directory incrementally (fingerprint-based), and invalidates the skill registry after any change.

### Failure is a status, not a crash

A turn error, an unusable outcome, or an unexpected exception settles the task as failed with a readable message; the delegate's retry cycle treats that as a normal outcome. Task state is an in-process map by design (accepted constraint): a restart loses running tasks, and the delegate retries them as failures.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [DSH backend task design](../../../docs/plans/2026-09-14-dsh-backend-task-design.md) — the node semantics, delegate contract, and profile architecture.

-----

<a id="model-experience"></a>
## Model Experience

None, as the runner submits the interpolated node prompt as an ordinary user message; the BPMN node configuration owns every model-visible contribution.

#### KV Cache effect

Each task session is independent and disposable; nothing accumulates across tasks, and daemon skill installs only change what future sessions can load.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **In-memory task table** — a restart loses running tasks; the delegate retries them as failures on its retry cycle.
- **One session per task** — no cross-task memory or conversational continuity; every task starts from a fresh session.
- **Textual JSON extraction** — the result is parsed from the final assistant text's first `{` to last `}`; surrounding prose is tolerated, multiple JSON objects are not.
- **Identity is the URL** — `selfUrl` is both the delegate target and the registry key; moving or renaming an instance appears as a new profile entry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The in-memory task table is a design-accepted constraint (delegate retries cover it); persistent task state would be new work in web-console or the engine, not here. No runtime invariant companion is published: endpoint behavior and the in-memory task lifecycle are covered directly by the package's behavior tests, with no independently maintained observation that can diverge. No open work here.

</details>
