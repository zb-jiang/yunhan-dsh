---
description: "Employee-side process start via AI conversation: three model-facing tools that list startable processes, read start forms, and launch instances over web-console REST."
kind: "package-reference"
---

# @deepseek-ai/dsh-process-start

English | [中文](README.zh.md)

## Summary

`dsh-process-start` lets employees launch published processes from AI conversation. It registers three model-facing tools — `dsh_process_list` (processes the signed-in employee may start, with owning applications), `dsh_process_start_form` (a definition's start-variable declarations), and `dsh_process_start` (launch an instance, optionally as a chosen org identity) — and calls the web-console process REST with the employee's Supabase JWT. Process names and BPMN keys are accepted wherever a definition id is expected and resolved automatically; calls land in session events.

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

Use this package when the employee-side agent should start enterprise processes for the user: listing what the user may start, reading each process's start form, collecting the required values, and launching the instance — all inside one conversation. Mounting it with the web-console address is the only setup.

### Minimal configuration

`webConsoleBaseUrl` is required with no default: a composition that omits it fails at load. Authentication reuses the signed-in identity; there is no service-key channel here.

```yaml
- name: '@deepseek-ai/dsh-process-start'
  config:
    webConsoleBaseUrl: 'http://web-console:8080'
```

| Field | Default | Meaning |
|---|---|---|
| `webConsoleBaseUrl` | required | web-console base URL (protocol, host, port); volatile — the settings panel can change it without a reload |

### What each tool does

`dsh_process_list` returns the published workflow definitions the signed-in employee may start, each with its owning application. `dsh_process_start_form` reads one definition's start variables (name, type, required, description) — the model should collect required values from the user before starting. `dsh_process_start` launches the instance and returns its id, start time, and names; `orgUnitId` selects which org identity to start as when the identity block lists several positions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### One resolver for ids, names, and keys

The tools accept a workflow-definition UUID, a process name, or a BPMN key ([src/index.ts](src/index.ts), `resolveWorkflowDefinitionId`): UUIDs pass through; anything else matches the startable list by exact name or key first, then by substring over name, key, and description. A unique hit is used directly; zero or multiple hits fail with the candidate list, so the model can self-correct instead of guessing.

### Per-call authentication and volatile base URL

Every call reads `ctx.currentUser.getToken()` lazily and sends it as a Bearer JWT; with no signed-in identity the call fails with a model-visible error. `webConsoleBaseUrl` is volatile: each call reads the current value, so a settings-panel change takes effect without a reload, and an invalid value fails that call, not the plugin.

### Errors invite recovery

Failure messages are written for the model: an unresolvable definition name returns the startable catalog, and upstream failures carry the HTTP status and web-console's own error text. Tool calls and results go through the normal registry pipeline and land in session events.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [Org-unit routing design](../../../docs/plans/2026-09-19-org-unit-routing-design.md) — how `orgUnitId` identifies the 发起身份 and where the startable view comes from.

-----

<a id="model-experience"></a>
## Model Experience

### Process-start tools

#### What the model sees

The model receives three tools: `dsh_process_list` (no parameters), `dsh_process_start_form` (workflowDefinitionId required), and `dsh_process_start` (workflowDefinitionId required; optional `orgUnitId`, `variables`, `businessKey`, `name`). Results render as Chinese text: the list shows `- 名称 (id: …, 应用: …)` lines, the form lists `- 变量名(类型,必填) 说明` entries, and a start confirms `流程实例已发起(实例 id: …)`. Errors embed the startable catalog so the model can retry with a valid id.

#### Token effect

Fixed definition cost on every request where the tools are visible; result text grows with the startable catalog and with the number of declared start variables — the list endpoint returns every published process the employee may start, which can be sizable in a deployment with many applications.

#### KV Cache effect

Definitions are prefix-stable while registration is unchanged; results are append-only. `webConsoleBaseUrl` is volatile but never alters the tool definitions — an invalid value fails the call, not the cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Starts only, no tracking** — the package launches instances but has no tools for tasks or instance state; todo handling lives in the employee workbench and flowable integration.
- **Ambiguous names fail loudly** — a name or BPMN key matching zero or multiple definitions errors with the candidate list instead of guessing.
- **Type checking stays upstream** — `variables` pass through unchecked; required and type validation happens in web-console at start time.
- **Identities come from the identity block** — the package does not look up org positions itself; the model picks `orgUnitId` from the identity block in context or asks the user.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Start-variable validation and instance persistence are owned by web-console; this package forwards declarations and start requests only. No runtime invariant companion is published: the tools forward declarations and start requests only, with behavior covered directly by the package's behavior tests and no independently maintained observation that can diverge. No open work here.

</details>
