---
description: "Employee-side enterprise skill governance panel: a Web sidebar Skills page that lists process-required, local (uploaded or hand-copied), and market skills, and installs, imports, and uninstalls them through skill-sync."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enterprise-skills

English | [中文](README.zh.md)

## Summary

Use the **Skills** entry in the Web sidebar to manage enterprise skills on the employee's machine. The page groups skills by their source — process-required, local (uploaded and hand-copied), and market — and installs market skills, imports zip packages, and uninstalls non-required skills through the local webserver's governance endpoints, which need no sign-in; process-required skills stay protected by the server-side ledger. Search filters all three groups; each action answers with a dismissible banner; uninstalling asks for confirmation; a closed market shows its own empty state.

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

The enterprise app bundle mounts this package, so the entry appears on the enterprise profile without extra configuration. Select **Skills** in the sidebar — the entry sits right below **Plugins**. The page reads the catalog through `GET /api/enterprise/skills/catalog` on the local webserver when opened and through the **Refresh** button; a failed read shows the error with **Retry**.

### The three groups

| Group | Source | Actions |
|---|---|---|
| Process-required | `required` | None — the skills the employee's todos require; the endpoint refuses uninstalling with 403 |
| Locally uploaded | `upload` | Uninstall |
| Market | SkillHub namespaces | Install when not installed; uninstall when installed |

Each card shows the skill name, a source tag, a summary (or the no-summary placeholder), and, for market skills, the version. The search box filters the required and uploaded groups by name and the market group by namespace, name, and summary; installed market rows sort after installable ones. When the administrator has configured no market namespaces, all three groups still render and the market group shows the catalog-closed empty state.

**Install** sends `POST /install`; a same-fingerprint reinstall answers idempotently without downloading. Installing a different version over a process-required skill is refused with 409. **Uninstall** opens a confirmation dialog naming the skill and then sends `POST /uninstall`; the button does not appear on process-required cards, and the endpoint refuses them regardless. **Import** opens a dialog whose drop zone accepts a `.zip` by click or drag and then sends the raw bytes to `POST /import`; the endpoint requires a `SKILL.md` with a legal frontmatter name, refuses a duplicate installed name with 409, rejects uploads over 30 MB and 64 MB uncompressed with 413, strips a single top-level directory prefix, and answers the imported name.

Every successful or failed action shows a banner carrying the outcome or the endpoint's reason, with a dismiss button; while an action runs, every action button disables. The page reloads the catalog after every successful write.

### Security model

Every panel request carries the employee JWT from `localStorage` (`dsh.enterprise.token`) to the local webserver only; the endpoints verify it against the platform-user seam and answer 401 without it. SkillHub downloads use the host's configured read-only distribution token, so the browser token never travels beyond this DSH instance. The skill cache has exactly one writer — skill-sync — and this package holds no state of its own.

<a id="understand-the-implementation"></a>
## Understand the implementation

skill-sync owns every datum and every write; this package renders its catalog and dispatches its endpoints.

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

`apply` registers the `enterpriseSkills` dictionary (zh/en), the sidebar entry (`sidebar.panellist`, id `enterprise-skills`, `order: 5`), and the `main` panel under the same id through `ctx.slots.inject()`, so all three follow late slot declaration, locale changes, and teardown. The browser plugin declares `inject = ['slots', 'locale']`.

### The page

`SkillsPanelPage` holds the catalog, the search query, the notice banner, the busy flag, and the two dialog states. It merges the catalog's local entries and market namespaces into uniform cards per group. Install, uninstall, and import set the busy flag and reload the catalog on success; failures surface the endpoint's message in the banner. `skills-api.ts` re-declares the wire types locally: feature plugins must not runtime-import other feature plugins' values.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [skill-sync](../../enterprise/skill-sync/README.md) — the host half: the governance endpoints, the write lock, and source provenance in `state.json`.
- [Enterprise subsystem](../../../docs/subsystems/enterprise.md) — how the enterprise profile composes the services this panel drives.
- [ui-sidebar](../ui-sidebar/README.md) and [ui-layout](../ui-layout/README.md) — the panel list the entry registers into and the main slot the page occupies.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side governance surface that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the reach of the panel; they are current package constraints.

- **One action at a time** — the busy flag disables every action button while an install, uninstall, or import runs; there is no queue.
- **No install progress** — install and import are single requests; the card list changes only after the endpoint answers, and a slow SkillHub download shows no intermediate state.
- **Errors are the endpoint's words** — the banner shows the status line and body the endpoint returns; the page attributes nothing further, so a 401 after token expiry reads as the endpoint's message until the employee signs in again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
