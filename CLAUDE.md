AGENTS.md

# 调用工具编辑文件的时候不要多个编辑放在同一批并行编辑，出现过很多次后一个编辑基于旧快照写入，把前一个编辑的结果覆盖的情况

# 改完DSH相关代码之后，因为沙箱权限问题，不要自己运行pnpm run typecheck和pnpm run build验证，而是通过node命令代替。如果还是失败，告诉我需要手动运行的命令，我手工运行完告诉你结果

# DSH 企业级应用平台 — 架构与产品思路（每次会话的必备上下文）

本文件沉淀企业定制层的架构与产品决策，避免用户每次会话重复解释。DSH 通用仓库规则见 AGENTS.md；企业定制边界：不改 DSH 核心机制与默认 profile 行为，企业代码落在 `packages/enterprise/`、`packages/client/ui-enterprise/`、`packages/bundle/enterprise-app/`、`packages/bundle/enterprise-backend/`、`apps/flowable-engine`、`apps/web-console`。

## 部署架构（v5：认证直连 Supabase，无中介）

- 员工 PC（可关机）：DSH Electron 应用包 = 浏览器页面 + DSH 后台服务（enterprise profile，本地 webserver `127.0.0.1:3080`）。浏览器访问服务器端服务一律经本地 DSH webserver 代理转发，不直连。
- 企业服务器（常驻不可关机）：
  - flowable-engine（`apps/flowable-engine`，Spring Boot 3 + Flowable 7，:8090）：流程引擎。ACT_* 表建在 Supabase PG 的 `flowable` schema（引擎自动建表）。自定义端点 `/dsh/tasks/*`（待办）、`/dsh/history/*`（历史）；认领/完成/部署/启实例用 Flowable 官方 REST `/process-api/*`。
  - web-console（`apps/web-console`，Spring Boot :8080 + React 前端打成一个 jar）：管理面。治理元数据在 public schema（platform_users / applications / app_roles / app_memberships / workflow_definitions / audit_events，JDBC 直连，不碰 ACT_*）；流程设计（bpmn-js + dsh 属性面板）/校验/发布；实例启动/终止。调 flowable 走 REST + JWT 透传。
  - DSH backend profile（`packages/bundle/enterprise-backend`，`dsh --profile enterprise-backend`）：服务器常驻 AI 自动节点服务，处理 DSH backend task 提交的任务并生成 JSON 输出。工作空间 + LLM 配置独立，可多实例并存（各自不同 URL）；启动即向 web-console 注册（heartbeat 维持存活），周期同步名下 backend task 引用的 skill。
- Supabase：认证中心（JWT 签发）。
- 本地PG数据库：建表 SQL 手工执行，见 `docs/plans/2026-08-19-supabase-setup-guide.md`（无 migration 文件）。

## 认证模型

- 三方（员工 DSH、web-console 后端、flowable-engine）各自用 Supabase JWKS 本地验签 JWT（仅校验 iss+exp，不校验 aud）；无共享密钥、无 service_role key。
- 流程身份 = Supabase Auth user.id（JWT `sub`），assignee/candidateUsers 直接存 user.id。
- 治理写操作只在 web-console 后端；员工端对 platform_users 只读（RLS 自读）。

## Human task 待办产品语义

- user task 的办理人：候选角色的所有成员（经 SoD 过滤）。single/countersign 下所有成员同时各有一个待办；sequential（串签）按顺序逐人收到。
- 处理策略：用 Flowable 原生多实例。候选成员列表作为多实例 collection，每个实例 assignee=单个成员 user.id（直接指派，不再用候选/认领机制）。single=并行多实例+完成条件 `${nrOfCompletedInstances >= 1}`（任一人提交即通过，其余待办引擎自动删除）；countersign（会签）=并行多实例、无完成条件；sequential（串签）=串行多实例（sequential=true，逐个办理）。
- 会签计票（`dsh:votingRule`，design `docs/plans/2026-09-15-voting-rule-design.md` §9）：按表决结果收工而非完成数量（"5 人中 3 人同意"类需求），user task / DSH backend task / 普通 ServiceTask 三种任务节点通用。user task 的票来自员工提交映射（引擎提交端点计数，start listener 预置 0）；backend task 的票来自 delegate 输出映射、普通 ServiceTask 的票来自 delegate 代码 setVariable 写表决变量（两种自动节点由 `DshVotingEndListener` 在实例 end 时计数，首次计票惰性建 0）。`DshBpmnParseHandler` 部署时按通过/否决票数自动生成完成条件（达到阈值提前收，剩余待办/实例自动删除，手写条件被发布校验拒绝）；网关读计数变量路由（发布校验按 `dsh_candidates_`/`dsh_passCount_`/`dsh_rejectCount_` 前缀豁免声明检查）。表决变量归属：user/backend task 必须是本节点输出映射 target 之一，普通 ServiceTask 必须是已声明上下文变量。
- 办理流程：员工端 DSH 点击待办 → 打开 AI 对话窗口，节点 userPrompt（上下文变量 `{{}}` 插值后）作为任务指令出现 → 用户与 AI 对话（AI 可用节点 skillRefs 引用的 skill）→ 用户确认 AI 回复满足要求 → 点击「提交待办」→ 弹出映射确认对话框 → 员工将 JSON 字段与流程上下文变量做最终映射（可新增/修改/删除）→ 点击「确认」→ 员工端根据最终映射构造 variables Map 提交到引擎 → 待办完成，流程继续。
- 提交契约（已确认）：员工端执行 JSON → 流程变量的映射，引擎端 `/dsh/tasks/{id}/complete` 接收已映射好的 variables Map，按声明类型转换后写入流程上下文。
- 员工端 DSH 有 daemon 定期扫描自己名下待办涉及的 skill 并本地预装。
- 节点属性面板：user task 保留 候选角色（candidateRoleId）、user prompt、skill 引用（skillRefs）、超时时长+升级目标角色/用户（timeoutPolicy）、SoD 责权分离 checkbox（sodRules）、输出映射（outputMappings，见 Process Context 机制节）；处理策略不再单独配置，由多实例类型表达（见上）。
- user prompt 编辑器：变量选择器从上下文声明清单展开字段树（object 按字段清单嵌套展开），插入 `{{变量.字段}}` 占位符；文案骨架「你当前的角色为…，请基于<输入变量1>，<输入变量2>… 应用 skill… 做… 工作，最终生成的结果符合下面的 JSON 格式…」。
- BPMN `dsh:` 扩展命名空间 `http://dsh.ai/bpmn`；引擎侧解析在 `apps/flowable-engine/.../listener/DshBpmnExtensionParser.java`，web-console 前端 `bpmn/dsh-moddle.ts` 与之对齐。

## Process Context 机制

设计文档：`docs/plans/2026-09-01-process-context-design.md`（调研、决策记录、实现落点）。

- 三层骨架：流程级上下文声明 + 节点级输出映射 + 字段级点路径引用。
- 上下文声明（process 级 `dsh:contextVariables`）：名称/类型（string/integer/float/boolean/date/datetime/object+字段清单/array+元素类型 itemType）/说明/初始值；object 以 Map、array 以 List 存储，`${var.field}` `${list[0]}` JUEL 原生可用；date（yyyy-MM-dd）/datetime（ISO-8601）以严格格式字符串存储（入口校验格式），统一格式下字符串字典序即时间序，网关可直接比较。变量的值来源三类：start-param（严格声明制：启动传入必须先声明，未声明报错）/ initial（初始值）/ 节点产出（校验器从输出映射推导）。作用域仅流程级。
- userTask 输入边界：prompt 引用即输入——所有已声明变量对 prompt 编辑器可见，模板实际引用即节点输入，发布校验静态提取引用做存在性检查。
- 输出映射（`dsh:outputMappings`）：userTask 的默认映射模板，用于在 userPrompt 中生成 JSON 骨架，并作为员工端提交对话框的初始映射；员工端可在提交前修改或清空。实际映射执行在员工端完成，引擎端只接收最终的 variables Map。DSH backend task 也配 outputMappings，映射由引擎端 delegate 执行（result JSON → 变量，无人工修改环节）。其余所有节点都在 delegate 代码、脚本或 DMN 输出列里直接 setVariable 写流程变量。
- DSH 自动节点（DshServiceTaskDelegate）不做任何特殊机制，与定制 delegate 同等对待：通用 DSH 调用逻辑（请求构造、HTTP 调用、超时重试）抽成可复用基类/组件，每个自动节点一个定制 delegate，在自己的代码里 setVariable 写结果变量。
- serviceTask 输入：Java 代码用 getVariable 直接读上下文（Flowable 原生），不做专门机制。
- 各组件怎么挂到变量机制：配输出映射的是 userTask（员工端执行）与 DSH backend task（引擎端执行）；其他会写结果的节点（含 DSH 自动节点、定制的 Service / Send / Script / Business Rule Task）在代码/脚本里直接 setVariable 写流程变量；网关/连线条件、Conditional 事件只读变量、不配任何东西，发布校验自动解析表达式检查；不碰变量的组件（Manual Task、并行网关、End Event 等）与机制无关；Call Activity 用 Flowable 原生传递，子流程有自己的独立变量声明。
- 引用语法分层：prompt 模板 `{{var.field}}`（任务创建时插值快照，object 序列化为 JSON 文本）；网关条件/delegate 表达式 `${var.field}`（Flowable 原生 JUEL）；映射表点路径（source 相对输出根，target 上下文变量路径，设计器下拉点选）。

## DSH backend task 与 backend profile

设计文档：`docs/plans/2026-09-14-dsh-backend-task-design.md`；设计决策记录：`.agents/notes/implemented/feature/2026-09-14-dsh-backend-task-and-profile.md`。

- 定位：DSH backend task 是 BPMN 画布上的独立自动节点（ServiceTask + `dsh:backendTask` 扩展 + userPrompt/skillRefs/outputMappings 与 user task 同构）= 在服务器端自动运行、不需要人工交互的 user task；无候选角色/超时升级/SoD（没有人工环节）。支持单实例与多实例（2026-09-15 与 user task/普通 ServiceTask 统一，见 §13）：多实例为计数形式 `loopCardinality` + `dsh:backendProfile` 列表，第 i 个实例绑第 i 个 profile URL，列表行数自动同步实例数。
- 画布（web-console 前端）：palette 独立条目，一次写入 `delegateExpression=${dshBackendTaskDelegate}` + `async=true` + `failedJobRetryTimeCycle=R3/PT1M` + `dsh:backendTask`；属性面板单实例为 profile 下拉、多实例变为 profile 列表编辑，prompt/skillRefs/outputMappings/会签计票编辑器复用 user task 组件。
- backend profile：常驻实例，HTTP API 对接（`POST /api/backend/tasks` 建任务 → `GET /api/backend/tasks/{taskId}` 轮询，不用 CLI 提交）；每个任务跑一次非交互 agent 会话产 JSON。URL 直接存节点上，多实例并存，选哪个实例是流程设计决策。
- 注册表（web-console 后端）：`backend_profiles` 表按 URL upsert，heartbeat 超 5 分钟算 inactive；归属聚合从已发布流程的 `workflow_definitions.published_bpmn_xml` 快照解析 backendProfileUrl 聚合 skillRefs（多实例 profile 列表逐行展开，`BpmnContextParser.parseBackendTasks`）；发布校验 `validateBackendTasks`（URL 非空且已注册、delegate/async 绑定、prompt 引用、映射 target、skillRefs）。
- 引擎 delegate（flowable-engine）：`DshBackendTaskDelegate` 解析扩展 → `{{}}` 插值（与 user task 共用 `DshPromptInterpolator`）→ 提交+轮询（`DshBackendClient`，配置 `dsh.backend.*`）→ result JSON 按 outputMappings 写变量（与 user task 共用 `DshVariableMappingSupport`；array 根整体覆盖不做 append 聚合，深路径按叶子字段声明转换）。
- 失败语义：任何失败（HTTP/超时/failed/JSON 不合法/映射违规）抛异常 → async Job 按 `R3/PT1M` 重试 → 耗尽走失败路径；profile 任务表是进程内存态，重启丢运行中任务，靠调用方重试兜底。

## 关键文档

- 架构图：`docs/plans/dsh_enterprise_architecture_v5.html`
- Process Context 机制设计：`docs/plans/2026-09-01-process-context-design.md`
- DSH backend task 设计：`docs/plans/2026-09-14-dsh-backend-task-design.md`
- Supabase 建表与配置手册：`docs/plans/2026-08-19-supabase-setup-guide.md`
- BPMN 组件教程：`docs/plans/2026-08-24-bpmn-components-tutorial.md`
