---
description: "Enterprise platform application layer: auth and governance routes, session-identity and knowledge-base context, Flowable-facing task integrations, and the enterprise quota proxy adapter."
kind: "package-group"
---

# Enterprise

English | [中文](README.zh.md)

## Summary

The enterprise group hosts the employee-facing platform layer: auth endpoints verify the signed-in employee against governance records, `ctx.currentUser` and the per-turn identity block carry that identity into the session, and Flowable-facing packages connect DSH to the process engine — task forwarding, backend-task runners, and the process-start tool. Companion packages pre-install pending-task skills, inject knowledge-base blocks, route model calls through the enterprise quota proxy, and delete archived sessions. Each package README owns its per-package contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---------|------|
| [`backend-task/`](backend-task/README.md) | Runs DSH backend tasks server-side: submits the interpolated node prompt to a backend profile and polls for the JSON result |
| [`flowable-task-proxy/`](flowable-task-proxy/README.md) | Pure HTTP forwarding for Flowable task endpoints |
| [`kb-context/`](kb-context/README.md) | Injects a per-turn `<knowledge_base>` model-visible block fed by web-console knowledge-base reports |
| [`knowledge/`](knowledge/README.md) | Knowledge-base lookup tool the model calls during enterprise sessions |
| [`llm-access/`](llm-access/README.md) | LLM adapter forwarding already-assembled requests through the enterprise quota proxy |
| [`platform-user/`](platform-user/README.md) | Governance-record seam for platform users (register, approve, roles, disable, lock, restore) |
| [`platform-user-api/`](platform-user-api/README.md) | HTTP auth endpoints and configuration projection for the employee client |
| [`platform-user-console/`](platform-user-console/README.md) | Read-only governance identity provider for harness servers: JWT verification plus self-read of platform-user records |
| [`pocket-access/`](pocket-access/README.md) | Phone-access LAN proxy with pairing and same-account gates |
| [`process-start/`](process-start/README.md) | Process-start tool launching workflow instances with server-side token attachment |
| [`session-delete/`](session-delete/README.md) | Archived-session artifact deletion |
| [`skill-sync/`](skill-sync/README.md) | Daemon pre-installing skills referenced by the employee's pending tasks into the local cache |
| [`user-identity-context/`](user-identity-context/README.md) | Session-identity context: `ctx.currentUser` plus a per-turn model-visible identity block |

-----

<a id="related-documentation"></a>
## Related documentation

- [Enterprise architecture v5](../../docs/plans/dsh_enterprise_architecture_v5.html) — deployment architecture and product decisions.
- [Internal pass SSO design](../../docs/plans/2026-09-29-internal-pass-sso-design.md) — the auth flow behind the identity packages.
