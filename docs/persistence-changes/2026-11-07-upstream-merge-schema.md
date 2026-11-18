---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-upstream-merge-schema

English | [中文](2026-11-07-upstream-merge-schema.zh.md)

## Summary

Acknowledges the schema alignment after the upstream dsh-v0.2.2-rc.1 merge: the enterprise instance-workspace attribution source kind on the four ordinary-message events, replayed over the upstream chain that the merge interleaves with it (action-card status attribution, the skill-catalog incomplete flag, and the liveshare share-viewer principal).

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-upstream-merge-schema
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "3751df8d766c18929a7063d47fb082df688ba4f515508bd7cbabb761fb5c6f1e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "8cac2692de155bde4da82554a6652e9825291d69006b2722b5f824bd17f0463e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "34bf7064180a314210e0f8cbcefa191313843c519828d9a7e7a0c6db8b7b9d4c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "ae9a18c21e88c444cd9d9c9ff234da8e31bf0cabaaa5916eac5d3b9df5ffc548"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All changes are additive and reader-tolerable: the instance-workspace source kind is a qualified attribution display section that readers outside the enterprise packages ignore, and the upstream additions it now composes with are optional properties or additive attribution. Existing logs remain valid and derive history from their content. No event type, Session header, or format version changes.

<a id="verification"></a>
## Verification

tsx scripts/persistence-changes.ts --check passes: the four root transitions classify as attribution-only source kinds or optional properties with requiresVersionBump false, and the regenerated catalog reports docs/persistence-catalog.md, docs/persistence-catalog.zh.md, docs/persistence-catalog.i18n.yaml, packages/core/session/src/known-event-types.ts, and docs/persistence-schema.json up to date.

<a id="dev-note"></a>
## Dev Note

None.
