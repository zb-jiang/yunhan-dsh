# 流程实例云工作空间设计

日期 2026-10-14 · 状态：定稿（TO-BE）· 范围：web-console、员工端 DSH（enterprise profile）、DSH backend profile、flowable-engine delegate

## 1. 概述

每个流程实例拥有一个云端共享文件空间（下称实例空间）。实例下所有节点——员工待办的 AI 会话、DSH backend task、引擎端自动节点——实时共享同一空间，支持高频上传、下载、读写、删除。它是流程上下文变量之外的第二套实例级协同机制。

### 1.1 三套机制的分工

| 机制 | 内容形态 | 读写频率 | 主要消费方 |
|---|---|---|---|
| 流程上下文变量 | 结构化数据（string/object/array...） | 低，节点产出一次 | 网关路由、映射、prompt 插值 |
| 应用知识库 | 沉淀文档，重向量索引 | 几乎只读 | RAG 检索 |
| 实例空间（本设计） | 非结构化文件 | 高频 | 实例全部节点实时共享 |

### 1.2 非目标

- 不修改 DSH 核心 workspace 语义（`WorkspaceRegistry`/`SessionHeader.cwd`/本地文件工具链全部不动）
- 实例空间文件不进知识库向量索引
- 不做文件版本、文件锁、回收站；并发写同名文件为整文件原子替换、后写者胜
- 不做服务端推送，列表为拉取式
- 管理面启动流程实例的会话暂不绑定实例空间（发起人经后续 user task 上传）

### 1.3 定案记录

| 项 | 结论 |
|---|---|
| 访问模式 | 本地/云双工作空间并行；本地工作区机制不变 |
| 存储 | web-console 服务器本地磁盘 |
| 可见性 | **实例参与人可见**（2026-10-17 修订，见下） |
| 参与人集合 | 发起人 + 历任/现任办理人 + system_admin/应用管理员；会签/计票提前收工时收到待办但未办理的人**同样计入**（其待办被引擎自动删除仍留历史 assignee，天然覆盖） |
| 员工端删除 | 允许，与 web-console 一致，删审计计 |
| 生命周期 | 永久保留，不自动清理；web-console 可删除单文件 |

> **可见性修订（2026-10-17）**：实测暴露水平越权——实例 A（小王发起）的文件清单，同应用成员张三在未绑定该实例的会话里用 workspace_list 携自身 JWT 即可读取。原定案「应用成员可见本应用全部实例的空间；不收窄到实例参与人」收紧为「实例参与人可见」：web-console 员工面在应用成员闸门后追加实例参与人闸门（§4.4），员工端 workspace_* 工具改为仅绑定实例的会话注入（§5.1(d)）。SoD 过滤掉从未收到待办的成员不在集合内。同机切换登录账号可打开他人会话记录的面经评估不处理（真实场景几乎不发生）。

## 2. 总体架构

```
员工端 DSH (PC, 可关机)                    企业服务器
┌─────────────────────────┐               ┌──────────────────────────────┐
│ 右侧栏: 本地空间 tab(现有) │   HTTP        │ web-console :8080            │
│ 右侧栏: 实例空间 tab(新增)  │ ──本地webserver│  /api/workspace/instances/** │← 员工 JWT
│ @ 补全含实例空间文件        │   :3080 代理→ │  /api/backend/instances/**  │← X-Service-Key
│ AI 工具 workspace_*      │               │  元数据(本地PG)+磁盘文件       │
└─────────────────────────┘               └──────────┬───────────────────┘
                                                    │ X-Service-Key
                                          ┌─────────┴────────┐
                                          │ backend profile   │
                                          │ (workspace_* 工具) │
                                          └───────────────────┘
                                          ┌───────────────────┐
                                          │ flowable delegate │
                                          │ (Java HTTP 直调)  │
                                          └───────────────────┘
```

要点：

- 员工端所有访问（侧栏 UI 与 AI 工具）统一经本地 webserver 前缀代理转发到 web-console，代理注入员工 JWT；浏览器与 Node 进程共用同一代理。
- backend profile 与引擎 delegate 走 X-Service-Key 服务面直连 web-console。
- 引擎零耦合：不新建/修改 ACT_* 表，`processInstanceId` 仅作关联键；实例空间随首次写操作惰性建立。
- 元数据表缓存实例的应用归属（application_id），历史实例在引擎不可达时仍可浏览。

## 3. 存储与数据模型

### 3.1 磁盘布局

```
{dsh.instance-workspace.root}/
  {applicationId}/
    {instanceId}/
      {relPath...}          # 任意层子目录，relPath 原样落盘（NTFS 支持中文名）
```

- `root` 相对路径相对于 web-console 启动目录解析。
- 写入走"临时文件 + 同卷 rename"保证整文件原子替换；rename 失败响应 500。
- 删除即删元数据行 + 磁盘文件；删除后残留的空目录不要求回收。

### 3.2 元数据表（本地 PG public schema，DDL 并入 local-pg-setup-guide）

```sql
CREATE TABLE public.instance_workspace_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id VARCHAR(64) NOT NULL,          -- flowable process instance id
    application_id UUID NOT NULL,              -- 实例空间首写时解析并缓存
    rel_path TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    content_type TEXT,
    uploaded_by TEXT,                          -- 员工 platformUserId；服务面固定 'dsh-service'
    uploaded_by_label TEXT,                    -- 显示名快照（员工 displayName / 'dsh-service'）
    source_task_id VARCHAR(64),                -- 写入来源节点 id，可空
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (instance_id, rel_path)
);
CREATE INDEX idx_iwf_instance ON public.instance_workspace_files (instance_id);
```

磁盘文件是事实源；元数据供列表快查、配额求和与审计。写操作：先落盘成功再插/更行；删除：先删行再删盘。两侧不一致时以磁盘为准，元数据缺行视为文件不存在（元数据行存在但文件缺失时 list 标记缺失，download/delete 返回 404）。

### 3.3 web-console 配置节（@ConfigurationProperties(prefix = "dsh.instance-workspace")，record + 紧凑构造器校验）

```yaml
dsh:
  instance-workspace:
    root: ${INSTANCE_WORKSPACE_ROOT:./data/instance-workspaces}
    max-file-mb: 64            # 单文件上限；不得超过 spring.servlet.multipart.max-file-size
    max-instance-total-mb: 512 # 单实例总量上限
    max-entries: 2000          # 单实例文件数上限
```

multipart 全局上限沿用 `application.yml` 现有 `spring.servlet.multipart` 配置（当前 `KB_MAX_UPLOAD_MB:50`）；实现时将实例空间的单文件上限与 multipart 上限对齐说明写入该配置注释。

> 实现修正（2026-10-15）：`read-max-bytes` 不进 web-console 配置节——web-console 全量返回文件内容，不做截断；实际截断发生在消费方（员工端插件 / backend profile 的 workspace_read 工具，256KB 上限超出截断并提示），由该工具侧配置承载。

## 4. web-console 后端 API

### 4.1 员工面（JWT）：`/api/workspace/instances/{instanceId}/files...`

新 `InstanceWorkspaceController`（`@RestController @RequestMapping("/api/workspace/instances")`，无类级 `@PreAuthorize`，鉴权下沉 Service，模式参照 KnowledgeController）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/{instanceId}/files` | 元数据列表（全量，受 max-entries 截断）。响应 `ApiResponse.ok(List<InstanceWorkspaceFile>)` |
| GET | `/{instanceId}/files/content/{*relPath}` | 文件流下载（StreamingResponseBody，capture-the-rest 捕获值带前导 `/`，Controller 剥掉后校验） |
| GET | `/{instanceId}/files/export` | 导出实例空间 zip（application/zip） |
| POST | `/{instanceId}/files` | 上传/覆盖字节文件。multipart：`path`（表单字段，relPath）+ `file`。已存在同 relPath 为覆盖 |
| POST | `/{instanceId}/files/text` | 写文本文件。JSON：`{ path, content, sourceTaskId? }`。已存在为覆盖 |
| DELETE | `/{instanceId}/files/content/{*relPath}` | 删除单文件（同上剥前导 `/`） |

`InstanceWorkspaceFile` record：`relPath, sizeBytes, contentType, uploadedByLabel, sourceTaskId, createdAt, updatedAt`。

每个写/删方法落审计（§4.6）。

### 4.2 服务面（X-Service-Key）：`/api/backend/instances/{instanceId}/files...`

新 `BackendWorkspaceController`（`@RequestMapping("/api/backend/instances")`，模式照 BackendKbController：不用 `@AuthenticationPrincipal`、`ApiResponse.ok` 包装、复用 `ServiceKeyProperties`）。端点与员工面同构（无 export）：

- `GET /{instanceId}/files`
- `GET /{instanceId}/files/content/{*relPath}`
- `POST /{instanceId}/files`（multipart）
- `POST /{instanceId}/files/text`
- `DELETE /{instanceId}/files/content/{*relPath}`

服务面只验服务密钥，不做成员校验；实例归属解析与员工面共用同一实现（§4.4）。

### 4.3 ServiceKeyAuthFilter 扩展

现有 `ServiceKeyAuthFilter` 白名单为单前缀常量且仅 GET。扩展为条目集合：

```java
// 每条目: 前缀 + 允许方法集合
List<ServiceRoute> SERVICE_ROUTES = List.of(
    new ServiceRoute("/api/backend/kb/",        Set.of(HttpMethod.GET)),
    new ServiceRoute("/api/backend/instances/", Set.of(GET, POST, DELETE)));
```

保持现有恒时比对与 fail-loud 401 语义；通过后注入 `ROLE_DSH_SERVICE` principal 不变。

### 4.4 归属解析与鉴权

`InstanceWorkspaceService` 内单一解析方法，员工面/服务面共用：

1. 查 `instance_workspace_files` 是否已有该 `instance_id` 的行：有 → `application_id` 取自行。
2. 无行 → 调 flowable 解析（模式照 `ProcessInstanceService.resolveWorkflow` 三级回退）：`getRuntimeProcessInstance` → 404 时 `getHistoricProcessInstance` → `processDefinitionId`/`bpmnProcessKey` → `WorkflowDefinitionJdbcRepository.findByProcdefId` → 回退 `findByBpmnProcessKey` → `workflow_definitions.app_id`。解析失败（实例不存在/无定义）响应 404。
3. 首次写操作成功时，元数据行落库即完成归属缓存；此后该实例不再访问 flowable。

鉴权差异仅在解析后：

- 员工面两级闸门（2026-10-17 起生效）：
  1. `checkAppMemberAccess(auth, applicationId)`（system_admin/应用管理员直通，其余要求 active 成员——照 KnowledgeService.checkAppMemberAccess 口径），失败 403。
  2. `checkInstanceParticipant(auth, instanceId)`（可见性修订新增）：参与人 = 发起人 + 历任/现任办理人 + system_admin/应用管理员，其余 403（消息「您不是该流程实例的参与人」）。办理人经 flowable 历史解析——按 processInstanceId 查 HistoricTaskInstance 收集 assignee（被自动删除的未办理待办同样留历史记录，会签/计票提前收工的收到人天然计入）；发起人取历史实例 startUserId。运行中实例参与人随流程推进增长：进程内按 instanceId 缓存、TTL 过期自愈（TTL 走配置项，默认 60s），已结束实例参与人稳定可长缓存。员工面全部路径（list/download/export/upload/write/delete）先应用成员、再参与人。
- 服务面：服务密钥即信任边界，不做成员/参与人校验（调用方是引擎 delegate 与 backend profile，任务指派即授权）。

读操作（list/download）在空间尚无元数据行时：员工面仍执行解析步骤校验实例存在与应用归属（防任意 instanceId 探测），通过后返回空列表；服务面直接返回空列表。

### 4.5 路径规则、配额与原子性

`relPath` 校验（统一 util，员工面/服务面共用）：

- 拒绝绝对路径、`..` 段、反斜杠（统一 `/` 分隔）、空段、`.` 段；规范化后落盘。
- 拒绝 Windows 保留字符 `<>:"|?*` 与控制字符（磁盘直接存文件名，需 NTFS 可落）。
- 拒绝 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，忽略大小写，含 `CON.txt` 形态——取扩展名前首段比对），避免 NTFS 落盘失败。
- 单段长度 ≤ 255，总长度 ≤ 1024。
- 校验失败响应 400，错误消息列明非法字符。

配额（写操作前校验，超限 413/400，消息含当前用量与上限）：

- 单文件：`max-file-mb`（覆盖写时按新文件大小校验）。
- 实例总量：`size_bytes` 求和 + 新文件 ≤ `max-instance-total-mb`。
- 实例文件数：行数 < `max-entries`。

并发：整文件原子替换（临时文件 + rename），后写者胜；删除与读并发时读方 404，调用方自行重试。无文件锁。

### 4.6 审计

每次 upload（含 text 写）/delete 调 `AuditService.record`（模式照 KnowledgeService.deleteDocument）：

| 事件类型 | operatorId | details |
|---|---|---|
| `INSTANCE_WS_FILE_UPLOAD` | 员工面=platformUserId，服务面=null | `instanceId, appId, relPath, sizeBytes, mode(upload|write), sourceTaskId, actor(服务面为 'dsh-service')` |
| `INSTANCE_WS_FILE_DELETE` | 同上 | `instanceId, appId, relPath, actor` |

读/下载不记审计。

## 5. 员工端 DSH（enterprise profile）

### 5.1 instance-workspace 插件（新包 `packages/enterprise/instance-workspace`）

单一插件承担员工端四件事，参照 knowledge/kb-context 既有模式；挂载进 `packages/bundle/enterprise-app/cordis.patch.yml`。

**（a）本地 webserver 前缀代理**

注册 `{ kind: 'prefix', path: '/api/enterprise/workspace', handler }` 转发到 web-console `/api/workspace/**`，Node 侧注入员工 JWT（`ctx.currentUser.getToken()`，取不到回 401；volatile `webConsoleBaseUrl` 无效回 502——逐条照 knowledge 插件 proxyRequest 语义）。浏览器侧栏 UI 与 Node 侧 AI 工具都请求该前缀，不再各自鉴权。

代理转发逻辑与 knowledge 的 proxyRequest 高度同构：实现时将该转发器提取为共享模块（如 `packages/enterprise/web-console-proxy`），knowledge 与本插件共同消费，避免重复实现。

**（b）会话注册端点（照 kb-context 的 session-context 模式）**

`POST /api/enterprise/workspace/session-context`，body `{ sessionId, processInstanceId }`，幂等登记 Node 进程内映射。UI 在待办会话创建后调用（§5.2）。无映射的会话（自由对话）不注入实例空间上下文。

**（c）pre-step 每回合注入（照 kb-context 的 agent/pre-step 模式，专用 MessageSource kind 进 session log）**

会话有映射时，每回合注入一段确定性文本（`renderInstanceWorkspaceContextText`，纯函数、双语 key 随 kb-context 惯例）：

```
<instance_workspace>
本会话关联流程实例云工作空间（实例内所有节点共享）。
instanceId: <id>
taskId: <taskDefKey 或 taskId>
对话与 @引用 中出现的实例空间文件用以下工具操作：
  workspace_list(instanceId)                    列出文件
  workspace_read(instanceId, path)             读文本文件
  workspace_write(instanceId, path, content)    写/覆盖文本文件
  workspace_upload(instanceId, localPath, path)        上传本地文件
  workspace_download(instanceId, path)          下载到本会话本地工作区（同名冲突默认拒绝）
  workspace_delete(instanceId, path)            删除文件
</instance_workspace>
```

**（d）workspace_* 工具（defineTool 形态照 knowledge 的 kb_* 工具）**

员工端执行时鉴权走代理（JWT）；工具参数 `instanceId` 必填（pre-step 注入提供该值，模型传参）。工具集：

> **注入范围修订（2026-10-17）**：员工端工具注册从插件根上下文的全局 `ctx.tools.register` 收窄为 per-agent scope 注入（harness 现成的 agent 作用域机制）——仅 session-context 登记过实例映射的会话可见 workspace_*，未绑定实例的会话（自由对话/新对话）工具目录中不出现，防止模型在无关会话被诱导用捡到的 instanceId 操作他人实例。backend profile 服务面保持全局注册（服务密钥通道，instanceId 由任务 payload 提供，靠任务指派约束）。

| 工具 | 参数 | 语义 |
|---|---|---|
| `workspace_list` | `instanceId` | 经代理调员工面 list，返回紧凑清单（relPath+大小） |
| `workspace_read` | `instanceId, path` | 员工面 download；按 `read-max-bytes` 截断，超限返回前段+截断提示 |
| `workspace_write` | `instanceId, path, content` | 员工面 text 写 |
| `workspace_upload` | `instanceId, localPath, path` | 读本地文件（相对会话 cwd 解析，`readBytes` 上限照 KbUploadAction 模式）→ multipart 上传 |
| `workspace_download` | `instanceId, path` | 下载落会话本地 cwd 同 relPath；已存在同名文件返回冲突错误，由模型决定改名或放弃 |
| `workspace_delete` | `instanceId, path` | 员工面 delete |

工具 UI 呈现（presentCall/raw 事件卡片）按"Design each tool's UI presentation up front"规范，在实现时随工具定义一并设计（列表/读写卡片化，错误就地展示）。

### 5.2 UI 变更（ui-enterprise）

**（a）右侧栏「实例空间」tab（新增）**

参照 `ui-sidebar-files` 的 tab 注册机制新增 tab 类型（如 `instanceFiles`），组件落在 ui-enterprise：

- 数据源：经 `/api/enterprise/workspace` 代理拉 list（非 workspaceFiles RPC）；拉取时机为打开 tab、切换会话、手动刷新。
- 树形展示 relPath；行信息含大小、上传人、时间。
- 行动作：下载到本地工作区（落会话 cwd 同 relPath，同名冲突弹确认：覆盖/改名/取消）、删除（确认框）、打开预览。
- tab 仅在当前会话绑定待办（存在 instanceId 上下文）时出现；实例上下文从 `Task.processInstanceId`（现有字段）取得。
- 打开预览与本地文件一致：拉取 content 落本地缓存目录（`$DSH_HOME` 下 instance-workspace-cache/{instanceId}/...）→ `tabActions.openResource(fileAddressFor(sessionId, root, path))` → 现有 viewer（`dsh-resource://file`）认领。
- （实施修正 2026-10-16）缓存落点改为会话 cwd 下 `.dsh/instance-workspace-cache/{instanceId}/...`：现有 viewer 只认会话 workspace 内的文件（workspace 外绝对路径被拒 outside-workspace），缓存必须落在 `fileAddressFor(sessionId, cwd, ...)` 可表达的范围内；设计原稿的 `$DSH_HOME` 落点 viewer 无法认领。

**（b）本地树上云动作（新增）**

本地 files tab 行级动作 slot（`sidebar.files.entry.action`，KbUploadAction 同槽位）新增「上传到实例空间」：目标 relPath 默认与本地相对路径一致，确认后经代理 multipart 上传，成功后提示并可跳转实例空间 tab。

**（c）待办会话创建后注册映射**

`createTaskSession` 成功后 POST `/api/enterprise/workspace/session-context { sessionId, processInstanceId }`（enterprise-workbench，紧邻现有 `reportSessionApp` 调用处）。

**（d）@ 实例空间文件（新增 InputTriggerSource）**

照 `kb-trigger-source` 注册第二个 `@` 源（`name: 'instanceWorkspace'`）：

- `candidates`：经代理拉实例 list 后按 query 前缀/包含匹配 relPath，最多 20 条；带 `kind`/分组 header 区分本地引用。
- `onPick` 插入文本固定为 `@实例空间/<relPath>`。
- 序列化即该文本原样进模型消息；模型依 pre-step 注入的指引用 `workspace_read` 读取（与 file-reference 的"路径引用 + 工具自取"语义一致，无内容注入环节）。

### 5.3 登录/代理依赖

代理转发依赖员工登录态（`currentUser`）；未登录时 tab 与工具均返回 401 提示登录。实例空间不引入新的本地持久状态。

## 6. DSH backend profile

### 6.1 请求体扩展（DshBackendClient → backend-task）

`POST /api/backend/tasks` payload 增加两个必填字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `processInstanceId` | string | delegate 从 `execution.getProcessInstanceId()` 取 |
| `taskId` | string \| null | 当前节点 id（`execution.getCurrentActivityId()`），审计用，可空 |

backend-task `dispatchTasks` 同步校验必填性；多实例 loopCardinality 各实例各自携带本实例 id（同实例共享空间为设计预期）。

### 6.2 会话注入与工具（runBackendTask）

- prompt sections 拼装处（现有 `sections` 数组）追加一段 `renderInstanceWorkspaceContextText({ processInstanceId, taskId })`（与员工端共用同一渲染函数）：声明 instanceId/taskId 与 workspace_* 工具用法。
- 工具为 profile 级静态挂载（enterprise-backend cordis.patch.yml 增加 instance-workspace 插件），无登录身份，`resolveAuth` 形态照 knowledge：服务密钥头 + 路径重写 `/api/workspace/*` → `/api/backend/instances/{instanceId}/files/*`；instanceId 由模型传参（sections 提供）。
- backend 会话 cwd 语义不变。

## 7. 引擎端自动节点（定制 delegate）

普通 Service/Send/Script/Business Rule 等定制 delegate 需要访问实例空间时，直接 HTTP 调 web-console 服务面（`X-Service-Key` 头，参照 `WebConsoleKbClient` 的服务密钥调用模式）：

- 读：`GET /api/backend/instances/{instanceId}/files/content/{relPath}`
- 写：`POST .../files/text` 或 multipart `.../files`
- 删：`DELETE .../files/content/{relPath}`

不提供 Java SDK，delegate 自行以 RestClient 调用；instanceId 取 `execution.getProcessInstanceId()`。

## 8. web-console 前端管理面

`InstanceDetailView`（InstanceDetail.tsx）现有垂直 section 结构中、流程变量区块之后新增「云工作空间」区块，组件 `pages/InstanceWorkspacePanel.tsx`（props：`instanceId`；自 load，模式照 KnowledgeTab）：

- 文件列表：relPath、大小、content type、上传人、来源节点、时间。
- 上传按钮：选择本地文件上传（multipart，走员工面 POST 端点；管理员经 checkAppMemberAccess 直通），relPath 默认取文件名。
- 行动作：下载、删除（确认框，删除后刷新并记 audit）。
- 导出 zip 按钮。
- 空间为空显示空态文案；历史实例（已结束）同一入口可浏览（归属走历史解析回退）。
- 前端 API client 落 `src/api/instance-workspace.ts`，走现有 `request` 封装。

## 9. 安全与限制汇总

| 项 | 规则 |
|---|---|
| 员工面鉴权 | 员工 JWT + 应用成员闸门 + 实例参与人闸门（发起人/历任现任办理人/system_admin/应用管理员） |
| 服务面鉴权 | X-Service-Key 恒时比对，fail-loud 401 |
| 实例可见性 | 实例参与人可见（2026-10-17 修订，原「应用成员全部实例」因水平越权收紧） |
| 路径 | 拒绝绝对路径/`..`/反斜杠/Windows 保留字符；规范化后落盘 |
| 单文件上限 | `max-file-mb`（默认 64MB，须 ≤ multipart 全局上限） |
| 实例总量 | `max-instance-total-mb`（默认 512MB）+ `max-entries`（默认 2000） |
| 读取上限 | `workspace_read` 按 `read-max-bytes` 截断 |
| 并发写 | 整文件原子替换，后写者胜；无锁无版本 |
| 删除 | 硬删（行+磁盘文件），审计留痕 |
| 生命周期 | 永久保留；不自动清理 |
| 审计 | 仅变更类操作（upload/write/delete），读不记 |

## 10. 实现任务分解（按闭环测试切分）

每个任务完成后用产品功能做闭环测试（不测裸 API）。任务 1 的后端部分已完成（2026-10-15，含 DDL 并入 local-pg-setup-guide §3.9、启动脚本 `INSTANCE_WORKSPACE_ROOT` 环境变量），前端面板实现后整体验收。

### 任务 1：web-console 管理面（实例详情「云工作空间」面板）

**落点**：

- 后端（已完成）：`config/InstanceWorkspaceProperties.java`、`instanceworkspace/` 包（Repository/Service/两个 Controller/dto）、`security/ServiceKeyAuthFilter.java` 条目化、`application.yml` 配置节
- 前端（待实现）：`pages/InstanceWorkspacePanel.tsx`（新）+ 挂入 InstanceDetailView（流程变量区块之后）+ `src/api/instance-workspace.ts`（现有 request 封装），面板功能见 §8（列表/上传/下载/删除/导出 zip/空态）

**前置**：手工在 local PG 执行 local-pg-setup-guide §3.9 DDL。

**闭环测试**（全部通过管理面页面操作）：

1. 启动脚本「启动web console」段起 web-console（先 `npm run build` + `mvn clean package -DskipTests`）。
2. 管理面发起一个含 user task 的流程实例（或直接打开一个历史实例详情）：实例详情流程变量区块之后出现「云工作空间」区块，空态文案正常。
3. 点「上传」选择本地文件 → 列表立即出现该文件，大小/上传人/时间正确；行「下载」内容与原文件一致。
4. 行「删除」→ 确认框 → 行消失，刷新页面后不再出现；「导出 zip」解压与列表一致。
5. 上传超过 max-file-mb（默认 64MB）的大文件 → 页面报错并提示用量上限。
6. 换非本应用成员账号登录打开同一实例详情 → 云工作空间区块报无权限。
7. 历史实例（已结束）打开同一区块仍可上传/浏览/下载。

### 任务 2：引擎 delegate payload 扩展

**落点**：`apps/flowable-engine/.../delegate/DshBackendClient.java`（改）：submit payload 加 `processInstanceId`（`execution.getProcessInstanceId()`）/ `taskId`（`execution.getCurrentActivityId()`，可空）。

**前置**：无（新字段向后兼容，未升级的 backend-task 忽略之）。

**闭环测试**（回归）：

1. 重打包启动 flowable-engine + web-console + 既有 backend profile（不升级）。
2. 管理面发起一个既有 backend task 流程：任务正常完成、流程走完（回归不破坏）。
3. backend profile 任务记录确认 payload 已含 processInstanceId/taskId。

> 顺序约束：必须先于任务 3——backend-task 启用必填校验后，旧引擎 payload 会校验失败。

### 任务 3：backend profile workspace_* 工具 + sections 注入

**落点**：

- `packages/enterprise/instance-workspace/`（新包，本任务实现**服务面模式**）：服务密钥直连 web-console `/api/backend/instances/**`（resolveAuth 照 knowledge：`X-Service-Key` 头 + 路径重写 `/api/workspace/*` → `/api/backend/instances/{instanceId}/files/*`）；工具 `workspace_list/read/write/upload/download/delete`（read 按 read-max-bytes 截断，download 落会话 cwd、同名冲突拒绝）；落共用渲染函数 `renderInstanceWorkspaceContextText`（任务 4 复用）
- `packages/enterprise/backend-task/src/index.ts`（改）：payload 必填校验 + sections 追加 `renderInstanceWorkspaceContextText({ processInstanceId, taskId })`
- `packages/bundle/enterprise-backend/cordis.patch.yml`（改）：挂载 instance-workspace 插件

**前置**：任务 1（管理面可用）、任务 2（payload 字段）。

**闭环测试**：

1. 启动脚本「启动DSH backend profile」段起 backend profile（工作空间 D:\works\test，需 `DSH_SERVICE_KEY`）。
2. 按启动脚本「测试」段模板提交一个 backend task，指令改为「用 workspace_write 在实例空间写 hello.txt 内容为 hi，然后 workspace_list 确认。只输出JSON，不要任何其他文字。」，body 带 processInstanceId/taskId。
3. 管理面该实例详情「云工作空间」出现 hello.txt：上传人 dsh-service、来源节点为该任务；审计有上传记录。
4. 再提交一个任务让模型 `workspace_download` 到会话工作目录已存在的同名文件 → 工具报冲突；模型改用新文件名后成功。
5. body 不带 processInstanceId 提交 → 任务直接失败（fail loud）。
6. 可选：多实例 loop 的 backend task 各实例读写同一空间。

### 任务 4：员工端插件 Node 侧（代理 + pre-step + 工具 JWT 模式）

**落点**：

- `packages/enterprise/web-console-proxy`（新共享模块）：knowledge.proxyRequest 提取为共享转发器，knowledge 同步重构消费
- `packages/enterprise/instance-workspace/`（扩展**员工面模式**）：前缀代理 `/api/enterprise/workspace` → web-console `/api/workspace/**`（Node 侧注入员工 JWT，未登录 401、baseUrl 无效 502）；`POST .../session-context` 幂等登记；agent pre-step 每回合注入 `renderInstanceWorkspaceContextText`（专用 MessageSource kind 进 session log）；workspace_* 工具同包复用、JWT 代理模式
- `packages/bundle/enterprise-app/cordis.patch.yml`（改）：挂载

**前置**：任务 1。

**验收**：本任务只交付 Node 侧能力，不做界面操作型端到端测试——行为由包行为测试覆盖（JWT 代理模式、session-context 端点 401/400/204 幂等、pre-step 注入与无绑定跳过、fail loud），待办会话的自动登记在任务 5 才接上，界面操作闭环全部归入任务 5。

### 任务 5：员工端 UI（实例空间 tab、@ 源、会话注册、树上云）

**落点**：ui-enterprise——实例空间 tab（`instanceFiles`，数据源经 `/api/enterprise/workspace` 代理拉 list，树形 relPath + 大小/上传人/时间 + 下载/删除/预览，仅绑定待办会话出现）；本地 files tab 行动作「上传到实例空间」（`sidebar.files.entry.action` 槽位，KbUploadAction 同槽）；@ InputTriggerSource `instanceWorkspace`（list 匹配 ≤20 条，插入 `@实例空间/<relPath>`）；enterprise-workbench `createTaskSession` 成功后 POST session-context（紧邻 reportSessionApp）。

**前置**：任务 4（代理 + session-context 端点）。

**实施状态**（2026-10-16 代码完成，闭环测试待手工执行）：

- 实例空间 tab 两阶段注册在 ui-enterprise apply（类型不注册 guide，仅程序化打开）；`openTask` 绑定分支与确认绑定后先开实例空间 tab 再开任务档案（后开者激活，进入待办默认看档案）；已完成会话不开实例空间 tab、不重放上报。
- 下载同名冲突提供 覆盖/取消 二选（设计原稿的「改名」未实现——改云端路径会破坏各节点共享同一 relPath 的约定；本地落盘名即 relPath 末段，可用上传/预览之外的方式改名本地文件）。上传同覆盖语义，提交前查清单，目标已存在时弹同名确认（2026-10-16 补，与下载冲突确认对称）。
- 预览缓存落点见 §5.2（a）实施修正：会话 cwd 下 `.dsh/instance-workspace-cache/{instanceId}/`，经本地 pull 端点由 Node 侧落盘。
- @ 源候选取 list 后按 relPath 大小写不敏感包含匹配、截取 20 条，onPick 插入纯文本 `@实例空间/<relPath>`（无 chip、无 codec）。
- session-context 上报挂在 `openTask` 绑定分支与确认绑定处（比设计原稿的「createTaskSession 成功后」更宽：已绑定会话每次进入都幂等重报，204 幂等语义下无害，并给 webserver 重启后的内存映射多一层自愈）；页面刷新后对进行中绑定重放。
- Node 侧配套：本地 pull 端点 `POST /api/enterprise/workspace/pull`（本会话随任务 5 交付，见包 README「员工面路由」节）。

**闭环测试**（两成员协同，全部为界面操作，覆盖任务 4 Node 侧端到端行为）：

1. 启动脚本「启动DSH enterprise profile APP」段起员工端（`WEB_CONSOLE_URL` 指向 web-console）。
2. 员工 A 从待办进入会话：出现实例空间 tab，模型上下文出现 `<instance_workspace>` 注入段（UI 在 createTaskSession 后自动 POST session-context）。
3. 让 AI `workspace_list` / `workspace_write`：成功后管理面该实例「云工作空间」看到新文件（上传人=该员工）。
4. A 在本地树点「上传到实例空间」选文件 → B 打开自己的待办，实例空间 tab 立即看到该文件。
5. B 在实例空间 tab 点「下载」→ 落到本地工作区（同名冲突弹确认）。
6. B 会话输入 `@实例空间/` 出现候选，选中后 AI 用 workspace_read 读取内容正确。
7. 实例空间 tab 的删除有确认框，预览打开现有 viewer 正常。
8. 自由对话（无待办绑定）：无注入、无实例空间上下文、无实例空间 tab、@ 无实例候选。
9. 退出登录后再让 AI 用工具 → 明确 401 提示；停掉 web-console 再用 → 502 提示，本地工作区功能不受影响。

### 任务 6：实例参与人鉴权 + 工具注入收窄（2026-10-17 新增）

**落点**：

- `apps/web-console/backend/.../instanceworkspace/InstanceWorkspaceService.java`（改）：员工面路径在 `checkAppMemberAccess` 之后追加 `checkInstanceParticipant`——flowable 历史解析参与人（HistoricTaskInstance 收集 assignee + 历史实例 startUserId），进程内按 instanceId 缓存（TTL 配置项，默认 60s）；失败 403「您不是该流程实例的参与人」
- `packages/enterprise/instance-workspace/src/index.ts`（改）：员工端工具注册从根上下文收窄为 per-agent scope（绑定实例的会话才注入；dsh-scope 的 agent 作用域机制现成）；backend 服务面注册不变
- `docs/plans/2026-10-14-instance-workspace-design.md` §1.3/§4.4/§5.1(d)/§9 已随本任务修订

**实施状态**（2026-10-17，闭环测试待人工执行）：

- Java 侧已实施：`InstanceWorkspaceProperties` 新增 `participant-cache-ttl-seconds`（默认 60，环境变量 `INSTANCE_WORKSPACE_PARTICIPANT_CACHE_TTL`）；`InstanceWorkspaceService` 新增参与人解析缓存与两级闸门（startUserId 空时回退 `dsh_applicant_user_id` 历史变量，历史任务全量收集 assignee 不过滤 deleteReason，管理员直通不触发引擎调用），8 个 Mockito 用例覆盖。
- Node 侧已实施：`Config` 新增必填 `toolMount`（`global`=根注册表全局注册，`boundSessions`=仅绑定实例的会话经 agent scoped 注册表逐个注入，WeakSet 幂等，session-context POST 主路径 + `agent/created` 兜底双入口）；`enterprise-app` 挂 `boundSessions`、`enterprise-backend` 挂 `global`（服务面不变）；vitest 37 用例全过（含 boundSessions 4 个新用例）。

**前置**：无（可与闭环测试并行）。

**闭环测试**（复现原越权路径验证收紧）：

1. 员工 A 新对话用 `dsh_process_start` 发起实例（记录返回的 instanceId）。
2. 员工 B（同应用成员、非参与人）登录：新对话里 AI 工具目录无 workspace_*；即使给出该 instanceId，模型也没有工具可调；直接经代理调员工面 list → 403「您不是该流程实例的参与人」。
3. B 收到同一实例的待办后再访问 → 通过（成为办理人）。
4. 会签/计票场景：C、D 同时收到待办，D 先提交、C 的待办被自动删除 → C 仍可读该实例空间（参与人含未办理的收到人）。
5. system_admin / 应用管理员访问任意实例空间 → 直通。
6. backend profile 服务面读写不受影响（回归任务 3 闭环测试）。

### 配套说明

- §7 定制 delegate 访问实例空间是使用约定（RestClient 直调服务面），无独立实现任务；服务面 API 随任务 1 交付，可直接作为其测试面。
- 工具 UI 卡片（presentCall/raw 事件）随任务 3/4 一并交付；双语 README 按仓库惯例随各任务同步。
