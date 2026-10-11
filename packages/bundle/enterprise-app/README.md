---
description: "Enterprise platform-user authentication bundle over dsh-web-app: the read-only platform-user seam, the employee task workbench proxy, and the enterprise client surface, for corporate deployments of the dsh web profile."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-enterprise-app`

English | [中文](README.zh.md)

## Summary

The enterprise profile bundle as a patch layer over [`dsh-web-app`](../web-app/README.md), shipped in the `enterprise` profile (`dsh --profile enterprise`). The package is a static patch-list carrier with no runtime API of its own: it inserts the platform-user seam and its Web-Console-backed provider, the browser-facing `/auth` routes, the flowable-engine task proxy, enterprise skill sync, knowledge-base tools, process-start tools, and the enterprise client-UI row, and it pins the directory-picker interaction to the in-app browse surface.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Launch the employee surface with `dsh --profile enterprise`; the composition is [`dsh-base`](../base/README.md) + `dsh-web-app` + this bundle, and this patch applies after web-app's. Deployment endpoints come from environment variables read at load time: `SUPABASE_URL`/`SUPABASE_ANON_KEY` for the auth configuration, `WEB_CONSOLE_URL` for the governance service, `FLOWABLE_ENGINE_URL` for the process engine, plus the `SKILLHUB_*`, `DSH_LOG_LEVEL`, `KB_READ_MAX_CHARS`, and `SKILL_SYNC_INTERVAL_MS` knobs.

| Inserted row | Role |
|---|---|
| `logger-console` | stdout log exporter so the headless webserver process shows `ctx.logger` |
| `platform-user` | the read-only `ctx.platformUsers` service |
| `platform-user-console` | JWKS JWT verification and the `/api/users/me` self-read through web-console |
| `platform-user-api` | `/api/enterprise/auth` routes (`/auth/me`, `/auth/config`) for the browser surface |
| `user-identity-context` | maintains `ctx.currentUser` and injects the per-turn identity block |
| `flowable-task-proxy` | `/dsh/tasks` and `/dsh/history` proxy to flowable-engine |
| `skill-sync` | a periodic daemon that preinstalls required SkillHub skills |
| `knowledge` | the `/api/enterprise/kb` proxy plus the `kb_search`/`kb_read`/`kb_list` tools |
| `process-start` | the `dsh_process_list`/`dsh_process_start_form`/`dsh_process_start` tools |
| `pocket-access` | the phone-access LAN proxy behind the pairing and same-account gates |
| `directory-picker-browse` + `ui-directory-picker-browse` | the in-app directory browser pinned in place of the boot-resolved picker, so Pocket Access phones pick workspace directories inside the page instead of raising the chooser on the host screen |
| `directory-picker` (disabled) | the web-app `-auto` row, which cannot tell a phone from the local display at boot; the browse pair above replaces it |
| `ui-enterprise` | the enterprise client-UI branch (layout, task workbench) |

A deployment changes endpoints through the environment or a profile-level patch. A patch replaces a row's whole `config`, so an overriding patch must restate every key it owns.

<a id="model-experience"></a>
## Model Experience

### Employee identity context

#### What the model sees

When the platform-user seam resolves an authenticated user, `user-identity-context` publishes one identity block per turn's first step: display identity with the web-console organizational attributes (unit, roles). The block is display context; tasks and approvals stay engine-owned.

#### Token effect

One stable-size identity block per session plus the web-app surface sections.

#### KV Cache effect

The block sits in the turn-specific prefix, so a different signed-in employee changes that prefix; within one employee's session it is stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **External services must be reachable** — web-console and flowable-engine URLs are deployment configuration; the surface starts without them but the workbench features degrade until they answer.
- **Patch order is fixed** — this bundle applies after `dsh-web-app`; a hand-built tree that omits web-app loses the rows this patch does not restate.
- **Configuration changes require restart** — the patch rows are startup-only; environment changes take effect on the next process.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No runtime invariant companion is published because the package is a static patch-list carrier with no mutable state to audit.
