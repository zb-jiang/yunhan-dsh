---
description: "企业平台应用层：认证与治理路由、会话身份与知识库上下文、面向 Flowable 的任务集成，以及企业配额代理适配器。"
kind: "package-group"
---

# Enterprise

[English](README.md) | 中文

## 概述

企业组承载员工侧平台层：认证端点对照治理记录验证登录员工，`ctx.currentUser` 与每回合身份块把该身份带进会话，面向 Flowable 的包把 DSH 接到流程引擎——任务转发、backend task 执行器与流程启动工具。配套包预装待办任务引用的 skill、注入知识库块、让模型调用经由企业配额代理、并删除归档会话。每个包的 README 拥有各自的契约。

## 目录

- [包](#packages)
- [延伸阅读](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|------|------|
| [`backend-task/`](backend-task/README.zh.md) | 在服务器端运行 DSH backend task：提交插值后的节点 prompt 到 backend profile 并轮询 JSON 结果 |
| [`flowable-task-proxy/`](flowable-task-proxy/README.zh.md) | Flowable 任务端点的纯 HTTP 转发 |
| [`kb-context/`](kb-context/README.zh.md) | 注入每回合 `<knowledge_base>` 模型可见块，内容由 web-console 知识库上报提供 |
| [`knowledge/`](knowledge/README.zh.md) | 企业会话中模型调用的知识库检索工具 |
| [`llm-access/`](llm-access/README.zh.md) | LLM 适配器，把已组装的请求原样转发到企业配额代理 |
| [`platform-user/`](platform-user/README.zh.md) | 平台用户治理记录接缝（注册、审批、角色、禁用、锁定、恢复） |
| [`platform-user-api/`](platform-user-api/README.zh.md) | 员工端的 HTTP 认证端点与配置投影 |
| [`platform-user-console/`](platform-user-console/README.zh.md) | harness 服务器的只读治理身份提供者：JWT 验证加平台用户记录自读 |
| [`pocket-access/`](pocket-access/README.zh.md) | 带配对与同账号闸门的手机访问 LAN 代理 |
| [`process-start/`](process-start/README.zh.md) | 流程启动工具，以服务端附加令牌的方式发起流程实例 |
| [`session-delete/`](session-delete/README.zh.md) | 归档会话产物删除 |
| [`skill-sync/`](skill-sync/README.zh.md) | 守护进程，把员工待办任务引用的 skill 预装进本地缓存 |
| [`user-identity-context/`](user-identity-context/README.zh.md) | 会话身份上下文：`ctx.currentUser` 加每回合注入的模型可见身份块 |

-----

<a id="related-documentation"></a>
## 延伸阅读

- [企业架构 v5](../../docs/plans/dsh_enterprise_architecture_v5.html) — 部署架构与产品决策。
- [SSO 认证中心方案设计](../../docs/plans/2026-10-11-sso-auth-center-design.md) — 身份类包背后的认证流程。
