---
description: "The dsh backend-profile bundle: server-side unattended backend task runner over dsh-base (webserver + backend-task plugin; no browser UI)."
kind: "package-bundle"
---

# @deepseek-ai/dsh-enterprise-backend

English | [中文](README.zh.md)

## Summary

`dsh-enterprise-backend` is the backend-profile bundle: a patch list that turns `dsh --profile enterprise-backend` into a server-side, unattended backend-task runner. The patch mounts four plugins — console logging, the HTTP webserver (port 3190 by default), dsh-backend-task with its registration, heartbeat, and skill-sync daemons, and the knowledge plugin for `kb_*` tools — and nothing else: no browser UI and no employee-facing plugins. Every value comes from environment variables, so instances are configured at launch, not in yml.

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

Launch one instance per backend profile. Each instance starts in its own working directory (the task workspace), takes LLM credentials from the normal settings/env plane, and must be reachable from flowable-engine and web-console at `DSH_BACKEND_URL`. The bundle is a single dependency whose `dsh.bundle.patch` pointer carries the whole composition; there is no runtime API to call.

### What the patch mounts

| Row | Package | Role |
|---|---|---|
| `logger-console` | @deepseek-ai/cordis-plugin-logger-console | stdout log exporter for the resident process; levels are declared explicitly because omitting them silently drops warn |
| `webserver` | @deepseek-ai/dsh-host-webserver | HTTP server bound to `0.0.0.0:3190` by default — engine and console call in across hosts |
| `backend-task` | @deepseek-ai/dsh-backend-task | REST task endpoints plus the register/heartbeat and skill-sync daemons |
| `knowledge` | @deepseek-ai/dsh-knowledge | `kb_*` tools over web-console service-key endpoints; each task payload carries the `kbId` |

### Environment variables

| Env var | Default | Feeds |
|---|---|---|
| `DSH_LOG_LEVEL` | `3` | logger-console level |
| `DSH_BACKEND_HOST` | `0.0.0.0` | webserver host |
| `DSH_BACKEND_PORT` | `3190` | webserver port |
| `WEB_CONSOLE_URL` | `http://127.0.0.1:8080` | backend-task and knowledge web-console base URL |
| `DSH_BACKEND_URL` | `http://127.0.0.1:3190` | backend-task selfUrl — must be the address flowable-engine and web-console can reach |
| `DSH_BACKEND_NAME` | `backend-1` | registration name |
| `SKILLHUB_URL` | `http://127.0.0.1:8095` | backend-task SkillHub base URL |
| `SKILLHUB_API_TOKEN` | empty | backend-task SkillHub token |
| `DSH_BACKEND_SYNC_INTERVAL_MS` | `300000` | skill-sync interval |
| `DSH_BACKEND_REGISTER_INTERVAL_MS` | `60000` | heartbeat interval |
| `DSH_SERVICE_KEY` | empty | knowledge service key — must match web-console `dsh.service-key` and flowable-engine `dsh.web-console.service-key` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### A static patch-list carrier

The package ships no runtime API ([src/index.ts](src/index.ts) exports nothing): all behavior lives in the inserted rows' packages. The bundle exists so a profile is one dependency and one patch pointer, and so the four rows stay versioned and reviewed together.

### Environment variables, not yml config

Every value is read with `!!js process.env` when the patch loads ([cordis.patch.yml](cordis.patch.yml)). The defaults assume a single host where engine, console, and this instance share `127.0.0.1`; a cross-host deployment overrides `WEB_CONSOLE_URL` and `DSH_BACKEND_URL`.

### What the bundle deliberately omits

No browser UI, no employee-facing plugins, no identity block: the runner holds no login identity. Knowledge reaches web-console with the service key, and skill sync uses the read-only distribution token, so unattended operation never needs a signed-in employee.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DSH backend task design](../../../docs/plans/2026-09-14-dsh-backend-task-design.md) — the task model and the backend profile this bundle composes.
- [Enterprise group README](../../enterprise/README.md) — the enterprise packages the runner side works with.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the packages the patch list inserts; each row's own package owns its model-facing behavior.

#### KV Cache effect

The bundle adds no prompts, tools, or events of its own; whatever reaches the model comes from an inserted plugin's contract, so this package never touches a conversation prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **No runtime surface** — the package exports nothing; changing bundle behavior means changing an inserted plugin or the patch file.
- **Unattended by construction** — no identity block and no employee-facing plugins; the instance serves backend tasks only.
- **Env read at load** — values are fixed when the patch loads; changing an env var means restarting the instance.
- **Local defaults** — built-in URLs assume engine, console, and SkillHub on `127.0.0.1`; a cross-host deployment must override them or the daemons point at nothing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published because the package is a static patch-list carrier with no mutable state to audit. No open work here.

</details>
