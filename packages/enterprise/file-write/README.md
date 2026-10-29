---
description: "Enterprise workspace file write Remote: workspace-confined text writes with optimistic concurrency over the enterpriseFiles Remote namespace"
kind: "package-reference"
---

# @deepseek-ai/dsh-enterprise-file-write

English | [中文](README.zh.md)

## Summary

`dsh-enterprise-file-write` is the workspace write channel behind the enterprise file editor. The browser-side editor's save action calls `ctx.enterpriseFiles.write` through the local webserver; the service resolves the Session's workspace root, rejects paths outside it, enforces the byte cap, and writes the editor-provided text under the workspace-write sandbox policy with optimistic version checking.

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

Use this package on the enterprise profile: the browser page never touches the disk directly — the editor's save goes through the local webserver's `enterpriseFiles` Remote namespace, and this service performs the actual workspace write. The intended caller is the enterprise file editor in `@deepseek-ai/dsh-ui-enterprise`; employee-side daemons and server-side runners have their own channels.

### Minimal configuration

`maxWriteBytes` caps the accepted write payload. The default covers ordinary document editing; raise it only for workflows that legitimately edit large text artifacts.

```yaml
- name: '@deepseek-ai/dsh-enterprise-file-write'
```

| Field | Default | Meaning |
|---|---|---|
| `maxWriteBytes` | `2097152` | maximum accepted write payload in UTF-8 bytes |

### What a write call does

`write(sessionId, request)` takes `{ path, content, expectedVersion? }` and returns `{ absolutePath, version, operation }` where `operation` is `create` or `update`. Passing `expectedVersion` turns the write into an optimistic replace: it succeeds only when the file still carries that version, and the caller re-reads and retries when the write reports `enterprise-file/stale-version`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Workspace root resolution follows the Session

The write target's workspace root is resolved per call ([src/index.ts](src/index.ts), `resolveWorkspaceRoot`): the live Session workspace header first, then the persisted header for archived sessions, then the sandbox root. Every resolved root is confirmed with `fs.contains` before writing, so a path that escapes the workspace fails with `enterprise-file/outside-workspace` instead of reaching the disk.

### Optimistic concurrency through the fs intent

`expectedVersion` maps to an `FsWriteIntent` `replaceIfVersion` write; the version returned in the result is minted by the fs layer on every successful write. Two editor windows saving the same file cannot silently clobber each other — the second save reports stale instead of overwriting.

### Sandbox policy and error mapping

Writes run under the `workspace-write` sandbox policy. Filesystem failures are mapped to stable Remote error codes: `FS_STALE_VERSION` becomes `enterprise-file/stale-version` and `FS_SANDBOX_DENIED` becomes `enterprise-file/denied`; oversized payloads fail with `enterprise-file/too-large` before touching the fs.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the profiles compose them.
- [Typert Remote services](../../../docs/subsystems/typert.md) — the Remote mechanism this service extends.

-----

<a id="model-experience"></a>
## Model Experience

None, as the service writes editor-provided text into the Session workspace; it registers no prompt, tool, or session event.

#### KV Cache effect

Nothing here enters model requests: the editor-provided content goes to the disk, and the Session only observes it if a later prompt references the file's workspace path.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Text only** — the write path accepts UTF-8 text payloads; binary formats need a different channel.
- **Whole-file replacement** — a save replaces the entire file; there is no patch or range-update mode.
- **No retry guidance on stale** — `enterprise-file/stale-version` tells the caller the version moved; re-read and merge logic belongs to the caller.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The three-level workspace root resolution (live header, persisted header, sandbox root) mirrors how the enterprise file-read side resolves roots; keep the two in step if the resolution order changes. Behavior is covered directly by the package's behavior tests; no open work here.

</details>
