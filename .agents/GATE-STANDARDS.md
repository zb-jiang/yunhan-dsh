# Gate 写作规范（lint / typecheck / hygiene / doc-sync）

`pnpm run lint`、`pnpm run typecheck`、`pnpm run hygiene`、`pnpm run doc-sync` 是机器可查的写作规范：每个 gate 对应一条硬性规则。写代码/文档前先查「改动 → 同步动作速查表」，把配套改动放进同一个变更集；不要等门禁失败再事后修订。

## 四个命令跑什么

| 命令 | 实际执行 |
|---|---|
| `pnpm run lint` | `build:lib:host` + oxlint（`scripts/run-oxlint.ts .`） |
| `pnpm run typecheck` | `build:lib:host` + `tsc -b tsconfig.client.json`（Client 程序经 references 覆盖全仓库） |
| `pnpm run hygiene` | `run-gates hygiene`：vendor rescope、publint、constraints、default-product-isolation、package-dependencies、application-entrypoints、DSH package licenses、package invariants、node-next types、optional dependency imports、client packages、client UI i18n、client route resolution、proxy-aware dispatchers、no new unknown casts、Cordis config、runtime closure |
| `pnpm run doc-sync` | `run-gates doc-sync`：43 个 gate（doc typecheck、文档站点构建、双语配对、各 catalog、export jsdoc、Agent Note、doc budgets、upgrade guides 等，完整名单见 `scripts/run-gates.ts` 的 `docSyncLeafGates`） |

## 改动 → 同步动作速查表（先查这里）

| 本次改动 | 必须同步的动作 | 对应 gate |
|---|---|---|
| 新增/删除包的 `src/invariant.ts` | 见下「package invariants」：有/无两种形态的全链路 wiring + README 双语原因句 | package invariants |
| 增/删任何包 tsconfig.json 的 references | `pnpm run gen-tsconfig-paths` 重生成 `tsconfig.base.json` | tsconfig paths |
| 改 README.md / README.zh.md 被记录的小节 | 两侧同步改 → `pnpm run verify-translation-pairing --write --all` 重录 `README.i18n.yaml` → 跑 check 验证 | translation pairing |
| 新增/修改 Config 字段 | `docs/config-catalog.md` + `.zh.md` 加/改条目 | config catalog、config source ownership |
| 新增/修改 tool | tool catalog 文档同步 | tool catalog |
| 新增/修改 client API / slot / 事件 | client catalog 文档同步 | client catalog |
| 新增/修改 cordis 服务、插件、事件 | cordis catalog 同步；scoped 事件键未入 payload 需 `@dshScopeScan unsupported` | cordis catalog、scoped events |
| 新增/升级 npm 依赖 | npm dependency catalog 文档同步 | npm dependency catalog |
| 新增导出（模块/函数/类/常量） | 每个模块和导出有 JSDoc；函数式导出带 `@param`/`@returns`；文档放声明处 | export jsdoc |
| SessionEventMap / 持久化类型变更 | persistence catalog + type history + 升级指南；按 docs/session-format-status.md 处理 | persistence catalog、persistence type history、released persistence history |
| externally perceptible breaking change | 用 dsh-create-upgrade-guide 写 `docs/upgrade-guide/v<版本>/...` | upgrade guides |
| 企业功能（packages/enterprise、ui-enterprise、bundle/enterprise-* 等） | `docs/subsystems/enterprise.md` + `.zh.md` 加条目 | subsystem pages |
| 版本号变更 | 同步全部 workspace 引用处；rc 阶段按 docs/session-format-status.md 推进 | constraints |
| Client UI 新文案 | typed dictionary + `t()` / localized primitive props，禁止硬编码 | client UI i18n |
| TypeScript 断言 | 禁止新增 `as unknown` / `<unknown>`；存量只减不增 | no new unknown casts |
| 新增 Agent Note | 只为 durable decision rationale 写；分类与格式过 gate | agent note classification、agent note format |
| 编写/修改包 README | Summary 一句话 + 模型体验 + limitations 小节符合 gate 要求 | package README Summaries / model experience / limitations |

## 各门禁硬性细则

### package invariants（hygiene，最易踩）

- 只有当「独立观测可能分叉」时才发布 `./invariant`（真实断言的 companion）；否则**不要**创建空 invariant。
- 有 `src/invariant.ts` 的包：`exports["./invariant"]`、`files` 的 `lib/invariant.js`、tsconfig references 的 invariants 项、`peerDependencies` + `devDependencies` 的 `@deepseek-ai/dsh-invariants` 必须齐全。
- 没有 `src/invariant.ts` 的包：上述四处 wiring 必须全部不存在，且 README 必须含原因句（正则 `/No (?:(?:runtime )?invariant )?companion is published(?: because|[.:;—])\s+\S/i`），双语对齐：
  - en：`No runtime invariant companion is published: <具体原因>.`
  - zh：`不发布运行时不变量伴随导出：<具体原因>。`

### translation pairing（doc-sync，高频失败）

- README.md / README.zh.md 是确认过的双语 pair，逐小节哈希记录在同包 `README.i18n.yaml`。
- 改一侧必须同步改另一侧，然后重录（`--write --all`），再跑 check 验证；只改一侧会被拒。
- 豁免范围（`scripts/translation-pairing.manifest.json` 的 excluded）：`docs/plans/`、`apps/web-console/frontend/README.md` —— 企业本地中文文档，不需配对。

### tsconfig paths（doc-sync）

- `tsconfig.base.json` 的 package aliases 是生成物：改任何包 tsconfig references 后必须 `pnpm run gen-tsconfig-paths`，否则 `--check` 判 stale。
- 跨包 import 一律用包名（paths 解析到 `src/`）；包内相对 import 用 `.ts` 后缀。

### lint（oxlint）表达式细则

- 返回值被忽略的箭头函数用 block body（void API、forEach/setInterval/React props）。
- 同步会失败的 async 函数写 `return Promise.reject(...)`。
- catch 参数标注 `unknown`；空 catch 命名错误与原因，try 保持单语句。
- `String()` 只用于非对象（对象先分支 `JSON.stringify`）；`JSON.parse` 结果先断言形状再读取。
- mock `fetch` 输入收窄为 `URL | string`；vitest matcher 加花括号（`toThrow`/`vi.waitFor`）。
- 抑制要窄：`oxlint-disable-next-line <rule> -- <reason>`（≤140 字符）；JSX 区间用块禁用/启用。
- 类型感知规则与 TS narrowing 不一致时，把收窄子句内联进 `if`；不因 lint 判冗余而删除运行时守卫（`?.`、null check）。

### typecheck

- `strict: true` + `noImplicitAny`；剩余 `any` 必须注释为什么无法收窄。
- 事件 JSDoc 带 `@mode` 与 payload `@param`；封闭 union 以 `assertNever` 收尾。
- Client/Host 双 face 的包用 face 专属 leaf config + solution-only root；repo-wide 程序 seed 到 face config，不 seed 根。

### doc-sync 其他硬性项

- **concrete terms**：不用隐喻；`contract`/`boundary`/`shape` 换成精确词（response fields、JSON validation、ESM exports），`contract` 只留给真正的义务承诺。
- **markdown**：链接可解析（含 website 死链检查）、行宽、mermaid 语法。
- **doc budgets**：AGENTS.md 等有大小上限；内容确实需要更多空间时显式提 ceiling。
- **Agent Note**：归档笔记冻结只读；新笔记分类正确。
- **catalog gates**（config/tool/client/cordis/dependency/persistence）：代码加了东西，对应 catalog 文档必须跟上。

## 存量欠账（只减不增，不要新增同类）

- client UI i18n 硬编码文案（约 338 处，`verify-client-ui-i18n` 报告）
- `as unknown` 断言（约 37 处，`verify-no-unknown-casts` 报告）
- Cordis config gate 在本机 Windows symlink 环境的已知失败（环境问题，非代码缺陷）

## 沙箱内验证（不跑 pnpm）

改完 DSH 代码不要跑 `pnpm run typecheck` / `pnpm run build`（沙箱限制），用 node 直跑等价 gate：

```sh
node --import tsx/esm scripts/gen-tsconfig-paths.ts --check
node --import tsx/esm scripts/verify-translation-pairing.ts
node --import tsx/esm scripts/verify-package-invariants.ts
node --import tsx/esm scripts/check-workspace-constraints.ts
```

仍失败的，把对应 pnpm 命令列给用户手工执行。多文件编辑必须逐个串行执行，禁止同批并行（历史多次出现后一编辑基于旧快照覆盖前一编辑结果）。
