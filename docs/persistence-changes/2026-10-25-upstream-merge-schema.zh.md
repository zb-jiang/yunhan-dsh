---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-25-upstream-merge-schema

[English](2026-10-25-upstream-merge-schema.md) | 中文

## 概述

登记 upstream dsh-v0.2.1-rc.3 合并带入的 schema 变更：四个普通消息事件上新增生产方归属的 working-directory 归属 source 类别、user 类归属 source 上新增可选 principal、标题 LLM 请求上新增可选 reasoning effort。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

九项变更全部是增量且对读者宽容：归属 source 类别是受限的展示分组区段，企业包之外的读者直接忽略；user source 的 principal 可选；标题请求的 reasoning effort 可选。既有日志保持有效并从内容推导历史。事件类型、Session 头与格式版本均不变。

<a id="verification"></a>
## 验证

tsx scripts/persistence-changes.ts --check 通过：九项新增分类为归属型 source 类别或可选属性，requiresVersionBump 为 false；重新生成的 catalog 报告 docs/persistence-catalog.md、docs/persistence-catalog.zh.md、docs/persistence-catalog.i18n.yaml、packages/core/session/src/known-event-types.ts、docs/persistence-schema.json 均为最新。

<a id="dev-note"></a>
## 开发备注

无。
