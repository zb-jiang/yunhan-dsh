---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-25-upstream-merge-schema

English | [中文](2026-10-25-upstream-merge-schema.zh.md)

## Summary

Acknowledges the schema changes carried in by the upstream dsh-v0.2.1-rc.3 merge: the producer-owned working-directory attribution source kind on the four ordinary-message events, the optional principal on user-kind attribution sources, and the optional reasoning effort on title-LLM requests.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-upstream-merge-schema
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-16-instance-workspace-source-kind"
    after: "14e2ef66f32ec9a75442c48942d37a6d4321f52257f16afb4e11e3cccf3e2ebe"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-16-instance-workspace-source-kind"
    after: "01a854d70c5c8346ed4f180fcbc2829a19e2150ba8cb062ffb85e781687a3b9a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-16-instance-workspace-source-kind"
    after: "a501282aa00c5686d68e1bbb92f9053b4aef5b4c829d07898a19fe342d582cdd"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-16-instance-workspace-source-kind"
    after: "b94578e2236495cb4a319a428e9777a8e94f550b9e51d597adfcd06499bc3de9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All nine changes are additive and reader-tolerant: attribution source kinds are qualified display sections that readers outside the enterprise packages ignore, the user-source principal is optional, and the title-request reasoning effort is optional. Existing logs remain valid and derive history from their content. No event type, Session header, or format version changes.

<a id="verification"></a>
## Verification

tsx scripts/persistence-changes.ts --check passes: the nine additions classify as attribution-only source kinds or optional properties with requiresVersionBump false, and the regenerated catalog reports docs/persistence-catalog.md, docs/persistence-catalog.zh.md, docs/persistence-catalog.i18n.yaml, packages/core/session/src/known-event-types.ts, and docs/persistence-schema.json up to date.

<a id="dev-note"></a>
## Dev Note

None.
