# AOCI 认知索引试点方案（2026-10-16）

## 背景与目标

云汉代码量持续增长，跨文件关联改动（上游分歧补丁、enterprise 包间事件、bundle patch 组合、Java↔TS 语义关联）越来越依赖个人记忆与纪律性登记。[aoci-spec/aoci-code](https://github.com/aoci-spec/aoci-code)（v0.1.0-rc21，FSL-1.1-MIT）提供"模型撰写 FRAS 条目 + 本地 MCP 服务器治理"的 Git 版本化代码库认知索引，对症缓解该痛点。

**试点范围（铁律）**：只管辖云汉企业定制层，不碰官方源码区。整仓（5700+ TS 文件）远超该工具约 50 万行的适用规模，且官方代码已有成熟的文档纪律，对其建索引低价值高成本。

**退出路径**：索引资产（aoci*.txt、.aoci/、AGENTS.md 托管块）均为试点期间新增，试点失败时直接删除并还原 AGENTS.md 即可，对 upstream 合并无残留影响。

## 阶段 0：安装（不动云汉仓库）

1. 建目录 `D:\tools\aoci\`。
2. 从 [v0.1.0-rc21 Release](https://github.com/aoci-spec/aoci-code/releases/tag/v0.1.0-rc21) 下载 Windows 资产：
   - `aoci_0.1.0-rc21_windows_amd64.zip`
   - `SHA256SUMS`
3. 校验（官方 install.md 原文流程）：

```powershell
$Archive = "aoci_0.1.0-rc21_windows_amd64.zip"
$Expected = ((Select-String -Path .\SHA256SUMS -Pattern "  $([regex]::Escape($Archive))$").Line -split '\s+')[0]
$Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) { throw "archive checksum mismatch" }
```

4. 解压 `aoci.exe` 到 `D:\tools\aoci\aoci.exe`（稳定绝对路径，MCP 配置将写死此路径）。
5. 验证：

```bash
D:/tools/aoci/aoci.exe --version   # 期望: aoci version 0.1.0-rc21
D:/tools/aoci/aoci.exe --repo D:/works/deepseek-harness doctor
```

前置依赖：本机 git 必须可用（Safe Inventory 从 Git 取文件清单，git 缺失会 fail closed：`safe_inventory_git_unavailable`）。二进制本身无 Go/Cosign 等运行时依赖。

## 阶段 1：圈定管辖范围（必须在首次 scan 之前）

官方文档明确：**对象角色在首次 `scan` 时冻结**，事后收窄范围属于 coverage reduction，需要 TTY 审批流程。所以顺序必须是：init → 加 scope 规则 → 验证角色 → 才做首次 scan。

### 1.1 目标 index 角色（要建索引的目录）

| 目录 | 理由 |
|---|---|
| `packages/enterprise/**` | 企业插件全集：服务、事件、HTTP 路由 |
| `packages/client/ui-enterprise/**` | 员工端 UI（含 rightbar 企业表面） |
| `packages/bundle/enterprise-app/**`、`packages/bundle/enterprise-backend/**` | bundle patch 组合关系 |
| `apps/flowable-engine/**` | Java 侧流程引擎与 Dsh* 语义 |
| `apps/web-console/**` | Java 管理面（OrgUnits、验签） |

### 1.2 排除规则（observe/exclude 角色）

对仓库其余部分（packages/ 官方包、apps/desktop、apps/web、vendor/、native/、snapshots/、docs/、scripts/、website/ 等）加 exclude 规则。

**官方警告（原文）**：不要用 `exclude **` + `index svc-a` 的白名单模式——用户 index 规则会覆盖 profile 内建规则，把测试和 fixture 拉进 Whole-Index。正确做法是**显式排除清单**。

操作顺序：

```bash
cd D:/works/deepseek-harness
AOCI=D:/tools/aoci/aoci.exe

# 1) 初始化（host 配置文件后续加 .gitignore）
$AOCI --repo . init --locale zh-CN --agent codex

# 2) 首次 scan 之前加排除规则（rule add 的 pattern 具体语法以
#    `aoci scope rule add --help` 和 docs/managed-scope-and-budget.md 为准）
$AOCI --repo . scope rule add --help
# 按官方文档对每个非企业目录加 exclude 规则（packages 官方子包、
# apps/desktop、apps/web、vendor、native、snapshots、docs、scripts、website…）

# 3) 逐点验证角色（关键一步，不要跳过）
$AOCI --repo . scope rule list
$AOCI --repo . scope explain packages/enterprise/process-start/src/index.ts   # 期望 index
$AOCI --repo . scope explain packages/core/src/index.ts                       # 期望 exclude
$AOCI --repo . scope explain apps/desktop/src/platform-view.ts                # 期望 exclude

# 4) 设置认知预算，控制建索引 token 上限
$AOCI --repo . scope budget show
$AOCI --repo . scope budget set <上限>   # 建议 6 万 token 量级起步，按需调
```

### 1.3 AGENTS.md 托管块（上游冲突点，提前登记）

`aoci init` 会向仓库根 AGENTS.md 写入一段受管理的规则块（官方说明：`init` writes … the managed `AGENTS.md` rules block …）。处理约定：

- 该块是**企业新增改动**，在 AGENTS.md 的 upstream merge-preserve 登记表中追加一条（与 ui-sidebar-right mount() 补丁同级），upstream 合并时若冲突须保住此块。
- `.gitignore` 需要追加 init 写出的宿主配置文件（如 `.codex/`、`.mcp.json` 等机器绑定绝对路径文件；官方原文：Add those files to the repository's `.gitignore` and do not commit them）。`.gitignore` 本身是共享文件，此行同样纳入合并登记。
- **不要**把 `aoci.txt`、`aoci.meta.txt`、`aoci.code.txt`、AGENTS.md 加进 .gitignore（官方原文：ignored asset is silently skipped，索引无法建立）。

## 阶段 2：首次 scan，建立 Baseline

```bash
$AOCI --repo . scan        # 建立 managed Baseline
$AOCI --repo . verify      # 应报告全部 Missing（尚未写条目）
$AOCI --repo . check
```

注意：`scan --force` 不是重定义治理范围的捷径；后续范围调整走正式 Scope Change 工作流（`aoci scope activate` 等）。

## 阶段 3：接入宿主（WorkBuddy）

在 `~/.workbuddy/mcp.json` 的 `mcpServers` 中添加（该文件在仓库外，不产生任何 upstream 冲突）：

```json
"aoci": {
  "command": "D:/tools/aoci/aoci.exe",
  "args": ["--repo", "D:/works/deepseek-harness", "mcp"]
}
```

写好后到连接器管理页对新增的自定义 MCP 服务器点"信任"生效。MCP 模式下 stdout 保留给 JSON-RPC，日志走 stderr。

Claude Code 等其他宿主如需共用，用 `aoci init --agent <name>` 对应的宿主配置方式接入（其配置文件同样 .gitignore）。

## 阶段 4：分批建索引（控制 token 成本）

条目由宿主模型阅读源码后通过 MCP 工具撰写（模型负责语义，AOCI 负责治理）。分三批，每批结束验证到 aligned 再进入下一批：

| 批次 | 范围 | 侧重点 |
|---|---|---|
| 1 | `packages/enterprise/` | 服务与事件的 R 关联（如 platform-user-api ↔ user-identity-context）、S 字段承载上游分歧补丁语义 |
| 2 | `ui-enterprise` + 两个 bundle | openTabIn/adoption 机制、bundle patch 组合、client bundle 重建纪律写入 S |
| 3 | `flowable-engine`、`web-console` | Java↔TS 跨语言 Dsh* 语义关联 |

给代理的建索引指令模式（官方推荐流程）：

> 阅读 <批次范围> 的源码与相关文档，为每个 index 角色文件撰写 FRAS 条目，用 `aoci_update_entry` 提交完整批次，收尾调用 `aoci_maintain`，最后 `aoci verify` 与 `aoci check` 直到 aligned。S 字段只收"不可推断且写错会出事"的约束（如上游分歧补丁、配置 volatile 语义、重建纪律），R 字段只收强关联文件对。

成本控制：

- 首次建索引是大额一次性投入（第三方实测全仓 12.8M tokens；云汉企业层预计低一个数量级以上），靠 `scope budget` 封顶。
- 日常装载开销依赖 prompt 缓存命中（实测 96%+ 可摊平），尽量在同一宿主内连续工作。
- 用 `aoci ui --detach --json` 的本机面板（仅 loopback）随时看覆盖率、压缩比与漂移。

## 阶段 5：日常使用与发版流程整合

- 日常任务无需特殊指令：项目规则（AGENTS.md 托管块）会让代理在代码与测试稳定后自动检查索引变化并 `aoci_maintain`。
- **发版节奏新增一步**（与"全量回归测试"并列）：

```text
官方发新 tag → 本地合并 → aoci verify → 维护 Stale 条目（aoci_maintain）→ aoci check 通过 → 全量回归 → 构建安装包
```

- rc 版本升级跟随：rc21 → 新 rc 时重跑 `aoci --version` 确认 + `doctor` + `verify`（治理协议仍是 v1/v2，升级影响需观察 release note）。

## 阶段 6：试点评估（2–4 周）

| 指标 | 记录方式 | 通过线 |
|---|---|---|
| R/S 条目实际命中率 | 每次关联改动任务记录是否靠索引提前发现关联文件 | 周均 ≥1 次真实命中 |
| 维护边际成本 | 每任务额外 token / 耗时 | ≤ 任务成本的 10% |
| tag 合并重对齐工作量 | 每次同步后 Stale 条目数与修复耗时 | 可接受且随版本稳定 |

- **通过** → 范围扩展（scope change 加目录，如 docs/plans、expense-ctrl 契约层），并考虑把数据库 schema 索引（PG 系统目录只读，凭据走环境变量名）纳入。
- **不通过** → 退出：删除 `aoci*.txt`、`.aoci/`，还原 AGENTS.md 托管块与 .gitignore 追加行，移除 WorkBuddy MCP 条目，零残留。

## 风险与已知限制（试点期间持续观察）

1. rc 阶段项目，规范（Volumes v1 / repository-cognition-object v2）仍在演进。
2. 语义漂移盲区：代码变更可检测（SHA 基线），但"设计理由已被推翻"无法检测——tag 合并后的人工 review 仍不可省。
3. 多人/多会话并发维护索引缺协调机制（第三方实测确认）；当前单人+代理开发模式风险低，团队化前需立条目分工约定。
4. FSL-1.1-MIT：企业内部使用无碍；若未来云汉衍生产品需分发，须复核许可条款。
