---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-16-instance-workspace-source-kind

English | [中文](2026-10-16-instance-workspace-source-kind.zh.md)

## Summary

Adds the qualified instance-workspace message source for the per-turn `<instance_workspace>` block that the instance-workspace plugin injects into employee-side todo sessions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-16-instance-workspace-source-kind
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-04-enterprise-attribution-kinds"
    after: "41dd97a5775067d4a52bcbeb80787c4a3033842c3339e034a304129eef478b0c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-04-enterprise-attribution-kinds"
    after: "bf2b198c22b7e9e07377b960f4697c1a8bef990485501ee19e2e92527092877e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-04-enterprise-attribution-kinds"
    after: "696ff4e342116db71f8241a9f6f9e47ef57b1bb6b5c09ac925faf647584453bb"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-04-enterprise-attribution-kinds"
    after: "b1035c796bb2095940195dabe4920f8249dafcac4004d6afc7173dba31cd0e09"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such sources and remain valid. The source is qualified attribution on ordinary user and developer messages: a ContextFormed display section injected by the instance-workspace plugin, read only for display grouping by the enterprise client. Deployments without the enterprise packages preserve the messages and derive history from their content. No event type, Session header, or format version changes.

<a id="verification"></a>
## Verification

tsx scripts/persistence-changes.ts --check passes: the four source additions classify as attribution-only with requiresVersionBump false. tsx scripts/gen-persistence-catalog.ts --check reports docs/persistence-catalog.md, docs/persistence-catalog.zh.md, docs/persistence-catalog.i18n.yaml, packages/core/session/src/known-event-types.ts, and docs/persistence-schema.json up to date.

<a id="dev-note"></a>
## Dev Note

None.
