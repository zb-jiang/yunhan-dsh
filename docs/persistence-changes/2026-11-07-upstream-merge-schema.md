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
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "9da84b5b247f572ad790f0b62737183a783487cb934a3237ab8f98731d969767"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "5221bb64e9f9f09863cbf684993f9638d29630b3c91e997eae5c85a749dbc0b6"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "af3f5704ba7ddf71f3815c21740d783b922d46bbc5387bf18132d10b532c483e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "703a649d6600822bdb408686a600bbefd2255592606ed23dfd2b0f08fc5ae2cf"
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
