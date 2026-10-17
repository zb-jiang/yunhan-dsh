---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-instance-workspace-source-kind

[English](2026-10-16-instance-workspace-source-kind.md) | 中文

## 概述

新增合格的 instance-workspace 消息来源，供 instance-workspace 插件向员工端待办会话注入的每回合 `<instance_workspace>` 块使用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

既有日志不含此类来源且仍然有效。该来源是普通 user 与 developer 消息上的合格归属：instance-workspace 插件注入的 ContextFormed 展示节，企业客户端仅将其用于展示分组。未部署企业包的部署保留消息并从其内容推导历史。事件类型、Session 头与格式版本均无变化。

<a id="verification"></a>
## 验证

tsx scripts/persistence-changes.ts --check 通过：四处来源新增归类为 attribution-only 且 requiresVersionBump 为 false。tsx scripts/gen-persistence-catalog.ts --check 报告 docs/persistence-catalog.md、docs/persistence-catalog.zh.md、docs/persistence-catalog.i18n.yaml、packages/core/session/src/known-event-types.ts 与 docs/persistence-schema.json 均为最新。

<a id="dev-note"></a>
## 开发备注

无。
