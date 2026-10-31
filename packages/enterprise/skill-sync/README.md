---
description: "Enterprise skill distribution: periodic required-skill scan against flowable-engine, SkillHub download into a dedicated cache root, and injection into ctx.skills."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-sync

English | [中文](README.zh.md)

## Summary

`dsh-skill-sync` keeps an employee's enterprise skills installed: a daemon periodically asks flowable-engine which skills the signed-in employee's todos require, downloads missing or stale SkillHub packages into a cache root, and registers a filesystem provider so `ctx.skills` serves them. Market installs and zip imports land in the employee drawer `$DSH_HOME/skills` instead, where a panel directory scan surfaces hand-copied folders. A login event or the `ensure` endpoint can trigger a round answering names still missing, so the UI continues degraded instead of blocking. The same prefix serves the panel's catalog, install, import, and uninstall. Failures log and retry; nothing blocks startup.

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

Mount this package on the enterprise profile next to the identity block: the daemon signs every request with the signed-in employee's JWT, and the cache root it publishes lives under this instance's home directory. The `ensure` endpoint is the todo-opening touchpoint — the web UI posts a task's `dshMeta.skillRefs` before creating the session and reads `missing` to decide whether to show the degraded-continue notice.

### Minimal configuration

The five volatile fields are required in cordis.yml, but an empty string is a legal "not yet configured" state: the login page is the first-config entry, and rounds skip with a warning until values arrive through a volatile update.

```yaml
- name: '@deepseek-ai/dsh-skill-sync'
  config:
    flowableBaseUrl: 'http://flowable-engine:8090'
    skillhubBaseUrl: 'https://skillhub.example.com'
    skillhubToken: 'read-only-token'
    intervalMs: 300000
```

| Field | Default | Meaning |
|---|---|---|
| `flowableBaseUrl` | required | flowable-engine base URL (protocol + host + port); volatile — the settings panel can change it without a reload |
| `skillhubBaseUrl` | required | SkillHub backend API base URL; volatile |
| `skillhubToken` | required | SkillHub read-only distribution token; an empty string skips manifest and download rounds; volatile |
| `marketNamespace` | required | single market namespace browsed by the skills panel; an empty value falls back to the `SKILL_MKTPLAC_NAMESPACE` environment variable, and both being empty closes the catalog (`catalogOpen: false`); volatile |
| `intervalMs` | required | daemon scan interval in milliseconds; volatile — a change reschedules the timer |
| `skillDir` | `$DSH_HOME/skill-sync/skills` | cache root override (the governance vault; the daemon is its only writer) |
| `userSkillDir` | `$DSH_HOME/skills` | employee drawer: install/import target directory and the panel's directory-scan governance scope |

### Two directories, one agent view

| Directory | Writer | Contents |
|---|---|---|
| `skillDir` | the daemon alone | process-required skills synced from flowable-engine todos |
| `userSkillDir` | the employee (panel writes or hand-copy) | market installs, zip imports, and hand-copied folders |

Both directories reach the agent: the vault through this plugin's filesystem provider, the drawer through the default filesystem provider. The panel governs both — the vault read-only (a `required` record cannot be uninstalled), the drawer read-write.

### What each endpoint does

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/enterprise/skills/ensure` | Body `{ names: [...] }` of skill bare names; if any are absent from the cache root, runs one immediate sync round, then answers `{ missing: [...] }` with the names still unavailable |
| GET | `/api/enterprise/skills/catalog` | Anonymous-readable; answers the catalog snapshot `{ authenticated, catalogOpen, namespaces, local }`: the market namespace group (a failed manifest fetch carries `error` with empty `skills`; SkillHub answers 400 for an unknown namespace — treated as "does not exist" alongside a defensive 404 check — pointing at `SKILL_MKTPLAC_NAMESPACE`), merged with the local installed list: `required` entries from the `state.json` ledger while their vault directories exist (signed-in only), plus a drawer directory scan where a folder without a ledger record counts as `manual`. Without a Bearer token `authenticated` is `false` and `local` omits `required` entries (the panel hides the process-required group); a carried token is still verified, so an invalid credential answers 401 rather than degrading to anonymous. No configured namespace answers `catalogOpen: false` |
| POST | `/api/enterprise/skills/install` | Anonymous (no employee JWT): body `{ namespace, slug }`; installs from the namespace's published manifest into the employee drawer — authentication is carried by the server-configured `skillhubToken`, not the employee session; a same-fingerprint reinstall answers `{ alreadyInstalled: true }` without downloading; a process-required skill with a different fingerprint, or a same-name hand-copied drawer folder, is refused with 409 (uninstall first) |
| POST | `/api/enterprise/skills/uninstall` | Anonymous (the drawer is a loopback-local, employee-owned directory): body `{ slug }`; removes the drawer directory and its state record; a `required`-source skill is refused with 403, and a name with neither a drawer directory nor a state record answers 404 |
| POST | `/api/enterprise/skills/import` | Anonymous (no employee JWT): body is raw zip bytes (`application/zip`), a loopback-local operation landing in the employee drawer; requires a `SKILL.md` with a legal frontmatter `name`, refuses 409 when the name collides with a process-required skill or an existing drawer folder, rejects uploads over 30 MB and 64 MB uncompressed with 413, strips a single top-level directory prefix, and answers `{ name }` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### A daemon that only works when someone is signed in

Each round reads the employee's token ([src/index.ts](src/index.ts)): no token skips the round, an expired token (401) skips it too and recovers on the next round after re-authentication, and a login event (`platform-user/verified`) triggers an immediate round so users do not wait for the interval. Concurrent triggers — daemon, login, endpoint — merge into one round.

### Fingerprint diff, atomic install

`state.json` maps each installed skill to its namespace and fingerprint. A round fetches the namespace manifest once, compares fingerprints, and reinstalls only missing or stale skills: zip download, containment check on every entry (absolute paths and `..` segments reject the whole install), unpack into a temp directory, atomic rename into place, then an invalidate of the skill registry cache so the next render sees the new content.

### One writer behind a write lock

The governance endpoints the skills panel calls (`catalog`, `install`, `uninstall`, `import`) share the daemon's serialization: every write queues on one in-process write lock, so a sync round, an install, an uninstall, and an import never interleave. `state.json` records each installed skill's source — `required`, `upload`, or `skillhub` — while a hand-copied drawer folder carries no record and surfaces as `manual`: `catalog` keeps a `required` entry only while its vault directory exists and scans the drawer for the rest, so a hand-copied folder appears next to installed ones and a record whose directory is gone does not appear. A `required` source blocks uninstall and overwrite, and a same-name drawer collision makes install and import answer 409. Writes target the drawer only — the vault stays the daemon's alone — and governance endpoints require no employee JWT; `required` protection comes from the ledger, not the session.

### Degrade, never block

Every failure — unreachable engine, failed manifest, bad zip — is logged and left to the next tick. Startup does not wait for the first round, and `ensure` reports missing names instead of failing, which is what lets the todo UI continue with a notice.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the cache-root skill provider, which delegates model rendering to dsh-tool-skill.

#### KV Cache effect

Installs and invalidations change what a future session renders when it loads skills; the provider itself stores no conversation content, so no cached prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Signed-in rounds only** — without a token, or after a 401, rounds skip silently; a signed-out machine syncs nothing.
- **Namespaces are mandatory** — a required skill without a namespace is skipped with a warning; the flowable side must map workflow definitions to applications for distribution to reach it.
- **Fingerprint trust** — a skill counts as installed when the fingerprint matches `state.json` and the directory exists; corruption inside the directory is not detected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`fetchSkillhubManifest` and `installSkillZip` are exported for dsh-backend-task, whose sync source differs but whose SkillHub manifest and download protocol is the same. Changes to those two functions must keep both callers working. No runtime invariant companion is published: scan, download, and injection behavior is covered directly by the package's behavior tests, with no independently maintained observation that can diverge. No open work here.

</details>
