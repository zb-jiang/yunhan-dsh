# Coding Agent 任务书：员工端图形化 SKILL 浏览与安装（SkillHub 方案）

> 使用说明：文中引用的文件路径是 2026-10-28 调研时的准确入口，行号可能随版本漂移——**以文件路径为准，先读代码再动手**。

---

## 1. 角色与总目标

你是基于 DeepSeek Harness（DSH）仓库的企业级定制开发者。本任务为"云汉"企业员工端（enterprise profile，桌面/Web 同构客户端）新增**图形化的 SKILL 浏览、安装与卸载面板**，数据源为企业自建 SkillHub 服务（外部仓库 `D:\works\enterprise-skillhub`，默认 `http://127.0.0.1:8095`，环境变量 `SKILLHUB_URL` / `SKILLHUB_API_TOKEN`）。

**业务语义**：员工作为 work agent（独立于待办处理场景），需要主动浏览企业 SkillHub 中已发布的技能、了解每个技能的用途、按需安装/卸载。这与现有"BPMN 流程要求的自动预装"机制并存，不替代它。

## 2. 必读代码（动手前全部读完）

| 主题                            | 文件                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库规范                          | `AGENTS.md`、`docs/architecture.md`（改 packages/ 前必读）                                                                                       |
| 现有 skill 同步插件（**本任务的核心扩展点**）  | `packages/enterprise/skill-sync/src/index.ts`                                                                                             |
| SkillHub 清单 HTTP 协议参考（Java 侧） | `apps/web-console/backend/src/main/java/com/dsh/console/skillhub/SkillHubRestClient.java`                                                 |
| skill 发现与 SKILL.md 解析         | `packages/skill/skill-filesystem/src/index.ts`（重点：`parseSkillFile`、roots rank、customSkillDirs）                                            |
| skill 注册表与热失效                 | `packages/skill/skill/src/index.ts`（`SkillRegistry.invalidateCache`）                                                                      |
| **UI 面板模板（整体复刻此模式）**          | `packages/client/ui-plugin-manager/src/client/index.ts`（PANEL_ID / main keyed 插槽 / sidebar.panellist 图标 / `ctx.layout.selectPanel`）       |
| 布局插槽契约                        | `packages/client/ui-layout/src/client/`（main keyed、sidebar.panellist）                                                                     |
| 浏览器侧 API 调用模式                 | `packages/client/ui-enterprise/src/client/kb-api.ts`、`task-api.ts`（同源 fetch + localStorage JWT，token key `dsh.enterprise.token`）          |
| Host 侧 HTTP 代理注册模式            | `packages/enterprise/knowledge/src/index.ts`（`ctx.webServer.register({kind:'prefix',...})`）                                               |
| 客户端包声明格式                      | `packages/client/ui-enterprise/package.json` 的 `dsh.client` 字段；`packages/client/modules/src/index.ts`（`ClientModuleRegistry.resolveMeta`） |
| bundle 接线                     | `packages/bundle/enterprise-app/cordis.patch.yml`、`packages/bundle/enterprise-app/package.json`                                           |
| 本地 i18n / 客户端惯例               | 参考 `packages/client/ui-enterprise/src/client/` 现有写法                                                                                       |

## 3. 已定架构决策（不要重新设计，按此执行）

- **D1 单写者原则（最高优先级）**：`$DSH_HOME/skill-sync/skills` 目录的**唯一写者是 skill-sync 服务**。浏览/安装/卸载一律通过 skill-sync 暴露的 HTTP 端点完成；客户端 UI 与其他任何组件**不得**直接写该目录。skill-sync 进程内对安装/卸载做串行化（互斥），防止并发写。
- **D2 API 层**：扩展现有 `packages/enterprise/skill-sync`（不要新建 host 插件），在该插件已注册的 `/api/enterprise/skills` 前缀下新增端点（见 §4）。
- **D3 UI 层**：新建客户端包 `packages/client/ui-enterprise-skills`，注册 **main 主区面板 + sidebar.panellist 入口图标**（复刻 ui-plugin-manager 的 PANEL_ID 模式）。不做 rightbar 标签、不做设置页承载主功能。
- **D4 namespace 可见性（V1）**：skill-sync 新增配置 `catalogNamespaces: string[]`（经 `packages/bundle/enterprise-app/cordis.patch.yml` 用 `!!js process.env.SKILLHUB_CATALOG_NAMESPACES ?? ''` 逗号分隔接线）。为空时面板显示"管理员未开放技能目录"空态。按员工角色动态过滤留待 V2（web-console 下发），本版本不做。
- **D5 来源标记与卸载规则**：`state.json` 每条记录增加 `source: 'required' | 'manual'` 字段（旧数据迁移：daemon 装的算 `required`）。**`required` 的技能不可卸载**（面板上显示"由流程要求，不可卸载"）；`manual` 可卸载。出厂 bundled skill（`$DSH_BUNDLED_SKILL_DIR`）不在本目录、天然隔离，无需处理。
- **D6 V1 范围**：浏览（列表 + 搜索 + 描述 + 版本 + 已装状态）、安装、卸载（仅 manual）。不做：更新一键化（重装即更新）、按角色权限、上架审核流。

## 4. 任务分解

### Task 1：skill-sync host 侧扩展（`packages/enterprise/skill-sync/src/index.ts`）

1. **`GET /api/enterprise/skills/catalog`**：对 `catalogNamespaces` 中每个 namespace 调用 SkillHub 清单接口（复用现有 `fetchSkillhubManifest` 的请求方式，但保留响应中的 `summary`/`version`/`updatedAt` 字段——参考 `SkillHubRestClient.listNamespaceSkills` 的映射，CLI 端点 `GET {base}/api/cli/v1/namespaces/{ns}/skills` 本身就带这些字段）。返回结构：按 namespace 分组的条目数组，每条含 `{namespace, slug, version, summary, fingerprint, downloadUrl, installed, source, installedVersion}`。`installed`/`source` 从 `state.json` + 本地目录实况合并得出（以目录里真实存在且 SKILL.md name 匹配为准，state.json 只作辅助）。SkillHub 不可达时返回部分失败信息而非 500（面板要能区分"网络错误"和"空目录"）。
2. **`POST /api/enterprise/skills/install`**：body `{namespace, slug}`。校验 slug 符合 kebab-case（复用现有 `SKILL_NAME_PATTERN`）；走现有 `installSkillZip` 安装；写 `state.json`（source=`manual`）；调 `control()?.invalidate()` 热失效。若目标名与 `required` 来源已装的技能重名且 fingerprint 相同 → 幂等返回已安装；fingerprint 不同 → 返回冲突错误（提示由流程管理，不可覆盖）。
3. **`POST /api/enterprise/skills/uninstall`**：body `{slug}`。仅允许 `source === 'manual'` 的条目；删除技能目录（用 `safeJoin` 约束在 skillDir 内）；更新 `state.json`；`invalidate()`。
4. **单写互斥**：install/uninstall 共用一个进程内互斥（简单 Promise 队列即可），与 daemon 的 `runSync` 也互斥。
5. **响应体一律走统一错误码**（参考现有 ensure 端点的风格），禁止把 skillhubToken 泄漏到任何响应或日志。

### Task 2：客户端面板（新建 `packages/client/ui-enterprise-skills`）

1. 包结构对齐 `ui-enterprise`：Node 半区 `src/index.ts` + 浏览器半区 `src/client/index.ts`，`package.json` 声明 `dsh.client: { platform: 'web', inject: [...], }` 并导出 `./client`（inject 列表参考 ui-plugin-manager 的声明，按实际用到的裁剪）。注意 `exports` 与构建配置照抄 ui-enterprise 的 tsdown 配置模式。
2. 面板内容（复刻 `ui-plugin-manager` 的注册方式）：
   - `main` keyed 插槽注册 `PANEL_ID = 'enterprise-skills'` 面板组件；
   - `sidebar.panellist` 注册入口图标与 label（中文名建议「技能库」）；
   - 面板内：namespace 分组列表、搜索框（前端过滤即可）、每条目卡片（名称/summary/版本/来源徽标/已装状态）、操作按钮（安装 / 卸载 / 已由流程要求）。
3. 数据访问：同源 `fetch('/api/enterprise/skills/...')` + `Authorization: Bearer <localStorage dsh.enterprise.token>`（照抄 kb-api.ts 模式）。操作后重新拉取 catalog 刷新状态。
4. 状态与反馈：安装/卸载进行中禁用按钮并显示 pending；错误信息展示后端返回的 message；成功后轻提示。
5. 文案全部简体中文，不硬编码进组件逻辑之外的位置（跟随仓库现有 client 包的文案组织方式即可，不强制 i18n 框架）。
6. **异步刷新不需要跨会话 rightbar 那套复杂机制**：本面板是 root 作用域主区面板，每次打开/操作后拉取即可。

### Task 3：bundle 接线

1. `packages/bundle/enterprise-app/package.json` 增加对新包的依赖；`cordis.patch.yml` 按现有行格式 insert 两个 entry（host 侧 skill-sync 已在，勿重复；client 侧新增 `ui-enterprise-skills`）。
2. 检查 `catalogNamespaces` 配置接线（D4）。
3. **构建纪律**：pnpm 命令 shim 损坏，一律用 `node D:/works/deepseek-harness/node_modules/pnpm/bin/pnpm.cjs <args>`。客户端包改 src 后必须重建 bundle（参照：`cd packages/client/ui-enterprise-skills && node D:/works/deepseek-harness/node_modules/pnpm/bin/pnpm.cjs bundle`），否则浏览器加载的 `lib/client.js` 不含改动。

### Task 4：测试与验收

1. 单元测试：skill-sync 新端点的核心逻辑（catalog 合并、install 幂等/冲突、uninstall 来源校验、互斥）。注意仓库覆盖门禁：`pnpm run test:coverage` 对 `packages/*/*/src` 要求 100%，新代码必须带测试。
2. 本地验收链路（全部通过才算完成）：
   - `pnpm run typecheck`、`pnpm run lint` 通过；
   - 启动 SkillHub（:8095）+ flowable-engine + web-console + enterprise profile 桌面端；
   - 配置 `SKILLHUB_CATALOG_NAMESPACES` 指向一个已发布技能的 namespace；
   - 验证：面板列出技能含 summary 与版本 → 安装 → 会话中 `/技能名` 手势可用、`<available_skills>` 目录出现该技能（**验证热生效，无需重启**）→ state.json 出现 `source:'manual'` → 卸载成功 → 对 `required` 来源技能卸载被拒；
   - 断开 SkillHub 验证降级：面板显示可理解的错误，不影响员工端其他功能；
   - `SKILLHUB_CATALOG_NAMESPACES` 为空时显示管理员未开放空态。
3. 完成后运行 `pnpm run build:check`（在最新 `build:artifacts` 之后）。

## 5. 红线（违反任何一条即返工）

1. **不改上游核心**：所有改动限于 `packages/enterprise/skill-sync`、新建 `packages/client/ui-enterprise-skills`、`packages/bundle/enterprise-app`。`packages/skill/*`、`packages/boot/*`、`packages/client/ui-*`（官方包）一律不改；确有上游能力缺口时在交付说明中提出，而不是直接改。
2. **单写者**：任何绕过 skill-sync 端点直接写 skill 目录的实现一律禁止。
3. **token 不出 host**：`SKILLHUB_API_TOKEN` 只存在于 host 侧插件配置，禁止进入浏览器可达的任何响应、日志或 localStorage。
4. **路径安全**：所有文件删除/写入必须经 `safeJoin` 约束在 skillDir 内，禁止拼接用户输入的原始路径。
5. **登录态**：新端点必须校验员工 JWT（与 ensure 端点同策略），未登录返回 401。
6. 遇到引用文件与描述不符（行号漂移、API 变更）：以实际代码为准，先更新自己的理解再动手；重大出入在交付说明中报告。

## 6. 交付物

1. 上述代码与测试；
2. `docs/plans/` 下新增实现说明文档：架构图（数据流：面板 → skill-sync 端点 → SkillHub / 本地目录）、端点清单、配置项说明、V2 待办（按角色 namespace 过滤、一键更新、上架审核）；
3. 验收链路的执行记录（命令与结果摘要）。
