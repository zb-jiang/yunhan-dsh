---
description: "Model-facing tools over the per-flow-instance cloud workspace: list, read, write, upload, download, and delete files in an instance's shared file space, plus the employee-side local proxy, session binding report, and the per-turn instance_workspace prompt block."
kind: "package-reference"
---

# @deepseek-ai/dsh-instance-workspace

English | [中文](README.zh.md)

## Summary

`dsh-instance-workspace` gives the agent file access to a flow instance's cloud workspace — one shared file space per process instance, stored by web-console. It registers six model-facing tools (`workspace_list`, `workspace_read`, `workspace_write`, `workspace_upload`, `workspace_download`, `workspace_delete`) and exports `renderInstanceWorkspaceContextText`, the deterministic `<instance_workspace>` prompt block. Authentication follows the caller: employee JWT via the local webserver proxy (enterprise profile) or the service key (unattended backend profile). It also owns the employee-side proxy route, the session-binding report endpoint, the pull-to-disk endpoint, and the per-turn `<instance_workspace>` pre-step injection. Tool mounting is per deployment (`toolMount: 'global'` vs `'boundSessions'`); see the field table below.

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

Use this package when a backend-task session should read inputs from, or write outputs into, the owning flow instance's shared file space, or when an employee-side todo session should reach the same space through its AI conversation. Mount it once with the web-console address; the agent then operates the instance space through its own tools, and writes/uploads are attributed to the node via the `taskId` argument.

### Minimal configuration

`webConsoleBaseUrl` is required with no default: a composition that omits it fails at load. On the enterprise profile a login identity takes precedence and `serviceKey` stays empty; on the backend profile — which has no login identity — `serviceKey` must match the web-console `dsh.service-key`, and a call with neither credential fails loudly.

```yaml
- name: '@deepseek-ai/dsh-instance-workspace'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
    serviceKey: 'shared-service-key'   # backend profile only; empty on the enterprise profile
    toolMount: 'global'                # backend profile; the enterprise employee face mounts 'boundSessions'
```

| Field | Default | Meaning |
|---|---|---|
| `webConsoleBaseUrl` | required | web-console base URL (protocol, host, port); volatile — the settings panel can change it without a reload |
| `readMaxBytes` | `262144` | Maximum bytes `workspace_read` returns before truncating and flagging the result |
| `uploadMaxBytes` | `67108864` | Maximum local file size `workspace_upload` accepts (aligned with the web-console upload cap) |
| `serviceKey` | `''` | `X-Service-Key` credential for the unattended backend profile; empty on the enterprise profile, where the login JWT wins |
| `localRoot` | process cwd | Fallback local root for `workspace_download`/`workspace_upload`; a bound session's working directory takes precedence |
| `toolMount` | required | `global` — the six tools register on the root registry, visible to every session (backend profile); `boundSessions` — no global registration, the six tools are injected into a session's agent-scoped registry only after that session reports its instance binding (enterprise employee face) |

### What each tool does

`workspace_list` enumerates one instance's files with size and disk-missing flags. `workspace_read` returns a text file's content, capped at `readMaxBytes` and flagged when truncated — fetch the full file with `workspace_download` instead of widening the cap. `workspace_write` creates or overwrites a text file from inline content; `workspace_upload` sends a local file as multipart. Both accept an optional `taskId` that web-console records as the file's source node. `workspace_download` writes the file into the local working directory under the same relative path and refuses to overwrite an existing local file; `workspace_delete` removes one file. Relative paths must be slash-separated without `.`/`..` segments, leading slashes, backslashes, or drive letters.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Two auth channels

Tool definitions are written against the employee-face paths (`/api/workspace/instances/*`) once, and both channels reuse them. With a login identity (enterprise profile) `resolveAuth` points the call at the local webserver proxy (`/api/enterprise/workspace/instances/*` on the loopback port), where the shared `@deepseek-ai/dsh-web-console-proxy` forwarder attaches the JWT and rewrites to web-console `/api/workspace/instances/*` for membership checking. Without a login the same paths are rewritten to the `/api/backend/instances/*` allowlist with the `X-Service-Key` header, the same shape as the knowledge plugin. With neither credential the call fails loudly; an unreachable upstream fails the call with a readable error, and the upstream envelope's error message passes through unchanged.

### Employee-face routes and per-turn injection

The prefix route `/api/enterprise/workspace` forwards browser requests to web-console `/api/workspace/*` through the shared forwarder — 401 unsigned-in, JSON 502 on an invalid base URL or an unreachable upstream. `POST /api/enterprise/workspace/session-context` (an exact route, matched before the prefix) records the session-to-instance binding: 401 unsigned-in, 400 on a malformed body, 204 and idempotent on success. `POST /api/enterprise/workspace/pull` (exact) solves "the browser cannot write the local disk": the Node side fetches one instance-space file through the local proxy (employee JWT) and writes it inside the session's working directory — `target: 'cwd'` to the same-named relative path (an existing target answers 409 `{ existed: true }` unless `overwrite` is set), `target: 'cache'` to `.dsh/instance-workspace-cache/<instanceId>/<relPath>` under the session cwd (always overwrites). Responses: 401 unsigned-in; 400 on a malformed body, an unsafe `relPath` (traversal, absolute, backslash), or a session cwd that cannot be resolved; 413 past `uploadMaxBytes`; 200 `{ localPath }` with the absolute path. Under `boundSessions` the six tools are injected into an agent's scoped registry once its session reports the binding — at report time when the agent already exists, otherwise on `agent/created` — with a `WeakSet` keeping repeat injections idempotent. The pre-step listener appends the `<instance_workspace>` block (message source kind `instance-workspace`) to step 1 of bound sessions only. A forged report cannot escalate: an unbound session merely misses the hint — and under `boundSessions` it also carries no workspace tools — while every tool call is still authorized by web-console.

### Local root: session directory first

`workspace_download` and `workspace_upload` resolve local paths against the bound session's working directory when one exists (the employee-side todo session), falling back to the configured `localRoot` (default: the process cwd) — one backend-profile process runs many instances, and each task session treats the process cwd as its working area.

### Render function is shared

`renderInstanceWorkspaceContextText` ([src/text.ts](src/text.ts)) renders the fixed `<instance_workspace>` block — instance id, task id, and the tool cheat-sheet — as a pure function so the backend-task prompt injection and the employee-side pre-step produce byte-identical sections. Single-line guards keep a malicious id from forging extra block lines.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [Instance workspace design](../../../docs/plans/2026-10-14-instance-workspace-design.md) — the storage model, the two API faces, and the injection points this package implements.

-----

<a id="model-experience"></a>
## Model Experience

### Instance workspace tools

#### What the model sees

The model receives six tools: on `global` mounts they are always in the catalog; on `boundSessions` only sessions that reported their instance binding carry them (unbound conversations see none). `workspace_list` renders a compact `- relPath (size, [磁盘缺失])` list or a "暂无文件" note; `workspace_read` renders the content with a truncation marker and a pointer to `workspace_download`; write/upload/delete render the affected path plus the recorded source node when a `taskId` was supplied. Bound sessions additionally carry the `<instance_workspace>` block injected through `renderInstanceWorkspaceContextText` — the backend-task prompt names the current task id, the employee-side pre-step shows `taskId: (无)` — together with the instance id and the six-tool cheat-sheet.

#### Token effect

Fixed definition cost on every request where the tools are visible, plus the per-prompt `<instance_workspace>` block (about 15 lines). `workspace_read` output is capped at `readMaxBytes` bytes (default 256 KB) and stays in context until compaction.

#### KV Cache effect

Definitions are prefix-stable while registration is unchanged; results are append-only. `webConsoleBaseUrl` is volatile but never alters the tool definitions — an invalid value fails the call, not the cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **No overwrite on download** — `workspace_download` refuses an existing local file instead of offering an overwrite flag.
- **Upload cap is local only** — `uploadMaxBytes` guards the local read; web-console's own limit applies upstream.
- **One upstream per deployment** — every request resolves against the single `webConsoleBaseUrl`; there is no per-call target override.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Workspace storage, DTOs, and the two API faces are owned by web-console; this package forwards parameters only. No runtime invariant companion is published: tool parameter forwarding, path rewriting, and local-file handling are covered directly by the package's behavior tests, with no independently maintained observation that can diverge. No open work here.

</details>
