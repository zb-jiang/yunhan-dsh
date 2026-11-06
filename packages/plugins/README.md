---
description: "Independently distributable installable plugins, each declaring its own dsh.bundle.patch layer."
kind: "package-group"
---

# plugins/ — installable plugins

English | [中文](README.zh.md)

## Summary

This group holds plugins shipped outside every built-in profile. Each package declares `dsh.bundle.patch` in its manifest, so the plugin manager treats it as a profile layer: users install it from the「添加插件」dialog with a local directory or tgz path, and can disable or uninstall it later without touching the base profile. Packages here must keep their runtime `dependencies` resolvable on a customer machine — internal `@deepseek-ai/*` helpers are bundled into `lib/` at build time, not shipped as workspace links.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`ppt-core`](ppt-core/README.md) | AI slide-generation host: template library, RPC endpoints, ppt-master skill, Python detection, image-model config | mounts `/api/ppt` routes |
| [`ppt-client`](ppt-client/README.md) | PPT client UI: gallery, template chip, preview dialog, settings card, Python guide | mounts conversation and settings slots |

<a id="related-documentation"></a>
## Related documentation

- [Plugin manager](../boot/plugin-manager/README.md) — install specs and the profile-layer detection behind `dsh.bundle.patch`.
- [app-boot](../boot/app-boot/README.md) — how bundle layers compose into a profile.

<a id="dev-note"></a>
## Dev Note

None.
