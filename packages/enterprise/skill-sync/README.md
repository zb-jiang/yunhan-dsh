---
description: "Enterprise skill distribution: periodic required-skill scan against flowable-engine, SkillHub download into a dedicated cache root, and injection into ctx.skills."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-sync

English | [中文](README.zh.md)

## Summary

`dsh-skill-sync` keeps an employee's enterprise skills installed: a daemon periodically asks flowable-engine which skills the signed-in employee's todos require, fetches each SkillHub namespace manifest, downloads missing or stale packages into a dedicated cache root, and registers a filesystem provider so `ctx.skills` serves them. A login event or the `POST /api/enterprise/skills/ensure` endpoint can also trigger a round; the endpoint answers with the names still missing so the UI can continue degraded instead of blocking. Every failure logs and retries on the next tick; nothing blocks startup.

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

The four volatile fields are required in cordis.yml, but an empty string is a legal "not yet configured" state: the login page is the first-config entry, and rounds skip with a warning until values arrive through a volatile update.

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
| `intervalMs` | required | daemon scan interval in milliseconds; volatile — a change reschedules the timer |
| `skillDir` | `$DSH_HOME/skill-sync/skills` | cache root override |

### What each endpoint does

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/enterprise/skills/ensure` | Body `{ names: [...] }` of skill bare names; if any are absent from the cache root, runs one immediate sync round, then answers `{ missing: [...] }` with the names still unavailable |

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
- **No uninstall** — skills that leave the required list stay in the cache root and keep being served until the directory is cleared by hand.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`fetchSkillhubManifest` and `installSkillZip` are exported for dsh-backend-task, whose sync source differs but whose SkillHub manifest and download protocol is the same. Changes to those two functions must keep both callers working. No runtime invariant companion is published: scan, download, and injection behavior is covered directly by the package's behavior tests, with no independently maintained observation that can diverge. No open work here.

</details>
