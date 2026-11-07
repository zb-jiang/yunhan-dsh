---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-upstream-merge-schema

[English](2026-11-07-upstream-merge-schema.md) | 中文

## 概述

确认上游 dsh-v0.2.2-rc.1 合并后的 schema 对齐：四条普通消息事件上的企业 instance-workspace 归因来源类型，重放到与本次合并交错的 上游链路上（action-card 状态归因、skill-catalog incomplete 标志、liveshare share-viewer principal）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

全部变更均为增量且读方可容忍：instance-workspace 来源类型是限定归因展示段，企业包之外的读方直接忽略；与之组合的上游新增均为可选属性或增量归因。既有日志保持有效并从自身内容推导历史。无事件类型、Session 头或格式版本变化。

<a id="verification"></a>
## 验证

tsx scripts/persistence-changes.ts --check 通过：四个 root 的迁移归类为仅归因来源类型或可选属性，requiresVersionBump 为 false；重新生成的 catalog 报告 docs/persistence-catalog.md、docs/persistence-catalog.zh.md、docs/persistence-catalog.i18n.yaml、packages/core/session/src/known-event-types.ts 与 docs/persistence-schema.json 均为最新。

<a id="dev-note"></a>
## 开发备注

无。
