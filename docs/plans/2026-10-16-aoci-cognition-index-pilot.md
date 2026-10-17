# AOCI 试点操作手册

## 0. 这份文档要帮你做成什么事（先看懂再动手）

我们要给云汉代码库请一位"图书管理员"——一个叫 **AOCI** 的小工具。它会让 AI 给企业定制层的每个源码文件写一张**目录卡片**，卡片上记四件事（简称 FRAS）：

| 栏 | 记什么         | 举例                   |
| - | ----------- | -------------------- |
| F | 这个文件是干嘛的    | "处理流程任务提交"           |
| R | 改它必须一起看哪些文件 | "改它就要同时改 xxx.ts"     |
| A | 它对外提供什么接口   | "导出 xxx 函数"          |
| S | 代码里看不出来的坑   | "这是企业补丁，合并官方代码时会被冲掉" |

以后你让 AI 改代码，AI 先读完卡片再动手，就不容易漏改关联文件。卡片存在几个文本文件里，跟随代码一起被 Git 管理。

**本手册会改云汉项目里的文件**（第 2 部分开始）。全是新增文件，试点失败可以直接删干净，不影响和官方代码的合并。

**本手册所有命令都在 PowerShell 里执行**（开始菜单搜 PowerShell，打开即可）。

***

## 第 1 部分：安装 AOCI

1. 工具已装在 `D:\aoci\aoci.exe`（压缩包也在这个文件夹里）。
2. 版本已确认：`aoci version 0.1.0-rc21`。
3. 完整性校验：官方 SHA256SUMS 清单当时代理网络抽风下载失败，改用 GitHub 官方 API 里登记的资产指纹比对——本地算出的 SHA256（`d7a34e5f…d6b499665`）与官方发布值完全一致，压缩包是真的。
4. 体检（doctor）已跑：仓库识别正常、git 可用；仅提示"尚未初始化、没有基线"，这正是第 2 部分要做的，属预期现象。

***

## 第 2 部分：初始化（从这一步开始会改云汉项目）

### 步骤 7：让 AOCI 在项目里"安家"

**目的**：生成放卡片的文件（`aoci.txt` 等）、规则说明书（`.aoci/config.json`），并在项目根的 `AGENTS.md` 里加一段"给 AI 看的使用说明书"（以后每个 AI 宿主读到它，就知道要先读卡片、走完要维护卡片）。

```powershell
cd D:\works\deepseek-harness
D:\aoci\aoci.exe --repo . init --locale zh-CN --agent codex
```

两个参数解释：

- `--locale zh-CN`：说明书和提示用中文。
- `--agent codex`：AOCI 不认识"Trae"这个名字，它的预置名单是 codex / claude / opencode / cursor / qoder。这里随便选一个让 init 能跑通（它会生成一份该宿主的连接配置文件），**我们真正连 Trae 是第 5 部分手动配的**，所以选 codex 不影响任何功能。

**成功的样子**：项目里多了 `aoci.txt`、`aoci.meta.txt`、`aoci.code.txt`、`.aoci\` 文件夹，`AGENTS.md` 末尾多了一段 AOCI 托管块。

### 步骤 8：登记这次改动，防止以后合并官方代码时出乱子

**目的**：云汉项目要定期合并官方新版本。今天新增的东西如果登记了，将来合并时就知道"这些是我们的，冲突时保留我们的"。

做两件小事：

1. 打开 `AGENTS.md`，找到"upstream merge-preserve deviations"登记表（企业补丁登记的地方），加一行：**"AOCI 托管块（init 生成）——合并时保留"**。
2. 用记事本打开项目根的 `.gitignore`，追加一行 `.codex/`（init 给 codex 生成的连接配置文件含本机路径，官方要求不要提交进仓库；`aoci.txt` 等**不要**加进去，加了它们工具就罢工）。

### 步骤 9：提交一次 Git（可选但推荐）

**目的**：给"试点开始前"拍个快照，以后想反悔随时能退回来。

```powershell
git add -A
git commit -m "chore: AOCI 认知索引试点初始化"
```

***

## 第 3 部分：圈定管辖范围（顺序绝对不能反！）

> 关键规则：文件的角色在下一步"首次扫描"时**一次性定死**。所以必须先贴标签、再扫描。事后想缩小范围要走麻烦的审批流程。

### 步骤 10：查看加规则的命令怎么写

**目的**：先看说明书再动手，避免瞎猜格式。

```powershell
D:\aoci\aoci.exe --repo . scope rule add --help
```

**成功的样子**：打印出 `scope rule add` 的参数说明。按它要求的格式来写下一步的规则（pattern 语法以这里打印的为准，也可以参考官方文档 `docs/managed-scope-and-budget.md`）。

### 步骤 11：切到"白名单"模式，只登记要管的目录（整段复制即可）

**目的**：默认模式（production）会把整个云汉仓库（几万个文件）都纳入管辖，做卡片太贵太慢，还会管到官方代码。我们改用 AOCI 官方原生的 **custom 白名单模式**：默认**所有**目录都是"不用管"，只有点名登记的目录才"要管"。以后从官方同步来再多新代码，都自动是"不用管"，**一条规则都不用补**——这正是"只枚举需要管理的代码"的写法。

**要管（做卡片）的目录**：`packages/enterprise/`（15 个企业插件）、`packages/client/ui-enterprise/`、`packages/bundle/enterprise-app/`、`packages/bundle/enterprise-backend/`、`apps/flowable-engine/`、`apps/web-console/`、`apps/expense-ctrl/`、`docs/plans/`（企业设计文档）、`.agents/UPSTREAM-MERGE.md`（单文件：上游合并偏差登记，用 file 类型规则精确点名）。

**第 1 小步：把模式切成 custom**。用记事本打开 `.aoci\config.json`，在 `"managed_scope"` 段里找到下面这一行，把 `production` 改成 `custom`，保存：

```json
"profile": "production",
```

（整个文件里只有这一个 `"profile"` 字段，别的不用动。custom 是官方三种模式 production / full / custom 之一，不是黑科技。）

**第 2 小步：登记 6 个要管的目录，外加几条护栏**。在 PowerShell 里把下面**整段**复制、回车：

```powershell
cd D:\works\deepseek-harness
$A = "D:\aoci\aoci.exe"

# --- A. 登记要管的目录（这些里面的源码做卡片）---
& $A --repo . scope rule add idx-enterprise --action index --pattern packages/enterprise --pattern-kind directory --reason "企业插件层，企业定制代码"
& $A --repo . scope rule add idx-ui-enterprise --action index --pattern packages/client/ui-enterprise --pattern-kind directory --reason "企业客户端 UI，企业定制代码"
& $A --repo . scope rule add idx-bundle-app --action index --pattern packages/bundle/enterprise-app --pattern-kind directory --reason "企业应用打包，企业定制代码"
& $A --repo . scope rule add idx-bundle-backend --action index --pattern packages/bundle/enterprise-backend --pattern-kind directory --reason "企业后端 profile，企业定制代码"
& $A --repo . scope rule add idx-flowable-engine --action index --pattern apps/flowable-engine --pattern-kind directory --reason "流程引擎，企业定制代码"
& $A --repo . scope rule add idx-web-console --action index --pattern apps/web-console --pattern-kind directory --reason "管理面前后端，企业定制代码"
& $A --repo . scope rule add idx-expense-ctrl --action index --pattern apps/expense-ctrl --pattern-kind directory --reason "费用控制应用，企业相关代码"
& $A --repo . scope rule add idx-docs-plans --action index --pattern docs/plans --pattern-kind directory --reason "企业设计文档"
& $A --repo . scope rule add idx-upstream-merge --action index --pattern ".agents/UPSTREAM-MERGE.md" --pattern-kind file --reason "上游合并偏差登记，单文件精确点名"

# --- B. 护栏 1：构建产物和日志不写卡片（--order 10 表示这条例外压过上面的 index）---
& $A --repo . scope rule add excl-lib-build --action exclude --pattern "**/lib/**" --pattern-kind glob --order 10 --reason "TS 编译产物，不做卡片"
& $A --repo . scope rule add excl-engine-logs --action exclude --pattern "apps/flowable-engine/logs/**" --pattern-kind glob --order 10 --reason "运行日志，不做卡片"
& $A --repo . scope rule add excl-tessdata --action exclude --pattern "apps/web-console/tessdata/**" --pattern-kind glob --order 10 --reason "OCR 语言包二进制，不做卡片"
& $A --repo . scope rule add excl-minjs --action exclude --pattern "**/*.min.js" --pattern-kind glob --order 10 --reason "压缩产物，不做卡片"
& $A --repo . scope rule add excl-mincss --action exclude --pattern "**/*.min.css" --pattern-kind glob --order 10 --reason "压缩产物，不做卡片"
& $A --repo . scope rule add excl-sourcemap --action exclude --pattern "**/*.map" --pattern-kind glob --order 10 --reason "source map，不做卡片"

# --- C. 护栏 2：测试文件只"感知变更"，不写卡片（按各目录实际测试位置精确圈定）---
& $A --repo . scope rule add obs-ent-tests --action observe --pattern "packages/enterprise/**/tests/**" --pattern-kind glob --order 5 --reason "测试职责，感知变更不写卡片"
& $A --repo . scope rule add obs-ui-ent-tests --action observe --pattern "packages/client/ui-enterprise/**/*.test.ts" --pattern-kind glob --order 5 --reason "测试职责，感知变更不写卡片"
& $A --repo . scope rule add obs-bundle-app-tests --action observe --pattern "packages/bundle/enterprise-app/**/*.test.ts" --pattern-kind glob --order 5 --reason "测试职责，感知变更不写卡片"
& $A --repo . scope rule add obs-bundle-backend-tests --action observe --pattern "packages/bundle/enterprise-backend/**/*.test.ts" --pattern-kind glob --order 5 --reason "测试职责，感知变更不写卡片"
& $A --repo . scope rule add obs-engine-java-tests --action observe --pattern "apps/flowable-engine/**/src/test/**" --pattern-kind glob --order 5 --reason "Java 测试，感知变更不写卡片"
& $A --repo . scope rule add obs-console-java-tests --action observe --pattern "apps/web-console/**/src/test/**" --pattern-kind glob --order 5 --reason "Java 测试，感知变更不写卡片"
& $A --repo . scope rule add obs-console-fe-tests --action observe --pattern "apps/web-console/**/*.test.ts" --pattern-kind glob --order 5 --reason "前端测试，感知变更不写卡片"

Write-Output "==== 全部规则添加完毕，用下一步抽查验证 ===="
```

说明：

- **为什么 custom 模式不怕官方同步**：没被规则点名的目录一律"不用管"。官方新增的代码不会自动混进管辖；哪天想把某个新企业目录也管起来，照 A 组样式加一条 index 规则即可（首次扫描前随时加；扫描之后加会走审批流程）。
- **B、C 组为什么要带 `--order`**：同一条路径被几条规则同时命中时，order 数值大的说了算。B 组 exclude（order=10）压过 A 组 index（order=0），构建产物不会被"整个目录要管"误拉进来；C 组 observe（order=5）同理。
- **target/、dist/、node_modules/ 没写规则**：AOCI 的安全边界本来就永远不读它们，规则够不着也不用写。
- **`**/lib/**` 是按目录名全局匹配的**：万一企业包里有正经的 `src/lib/` 源码目录被误伤，用 `aoci --repo . scope explain <那个文件>` 能看出命中的是哪条规则，把该规则的模式收窄到具体包即可。
- **C 组是按 2026-10-17 实际扫描的测试文件位置写的**（enterprise 用 `tests/` 目录、ui-enterprise 用 `*.test.ts`、两个 Java 应用用 `src/test/java`）。以后企业代码里新增了别的测试位置，照样式补一条 observe 规则。
- 如果中途某条命令报"规则已存在"，不影响后面，继续跑即可。

### 步骤 12：抽查验证

**目的**：扫描开始前最后确认标签没贴错。指着四个具体文件问它"这个你管不管"：

```powershell
D:\aoci\aoci.exe --repo . scope rule list
D:\aoci\aoci.exe --repo . scope explain packages/enterprise/process-start/src/index.ts
D:\aoci\aoci.exe --repo . scope explain packages/enterprise/backend-task/lib/index.js
D:\aoci\aoci.exe --repo . scope explain packages/core/src/index.ts
D:\aoci\aoci.exe --repo . scope explain apps/desktop/src/platform-view.ts
```

**正确的答案**：第 1 个 = index（管，命中的是 idx-enterprise 规则）；第 2 个 = exclude（命中的是 excl-lib-build 规则，验证构建产物护栏生效）；第 3、4 个 = exclude（官方代码，custom 模式默认不管）。任何一个不对，回到步骤 11 改规则。

### 步骤 13：设预算

**目的**：写卡片要消耗 AI 的 token（可以理解为钱）。设个上限防止失控。真实语法（`--help` 已核实）：

```powershell
D:\aoci\aoci.exe --repo . scope budget show
D:\aoci\aoci.exe --repo . scope budget set --max-tokens 60000 --mode enforce
```

- `--max-tokens 60000`：整套卡片的总量上限 6 万 token（保守起步值，不够再加）。
- `--mode enforce`：超过上限就拒绝继续写；另一种取值 `observe` 只警告不拦。
- 如果这条命令提示需要激活（出现 `scope_change_required` 字样），补一句：`D:\aoci\aoci.exe --repo . scope activate`。

***

## 第 4 部分：首次扫描

### 步骤 14：正式盘点 + 检查

**目的**：这是"开工仪式"——AOCI 清点管辖范围内的文件，建立基线（Baseline，相当于"户口本"）。以后代码一变，它靠比对就知道哪些卡片过期了。

```powershell
D:\aoci\aoci.exe --repo . scan
D:\aoci\aoci.exe --repo . verify
D:\aoci\aoci.exe --repo . check
```

**成功的样子**：`verify` 报告一堆 Missing（还没写卡片，正常，下一步补）。

三个命令的大白话：

| 命令       | 干什么                     | 大白话  |
| -------- | ----------------------- | ---- |
| `scan`   | 清点管辖内的文件，建立基线（Baseline） | 登记户口 |
| `verify` | 逐个比对"代码现状"和"卡片"是否一致     | 对账   |
| `check`  | 把对账结果和所有治理规则汇总          | 总检   |

对账结果的三种"不一致"，各有名字：

- **Missing** = 这个文件还没有卡片（首次扫描后全是它，正常）。
- **Stale** = 代码改了，卡片内容过期了（最常见的维护对象）。
- **Orphan** = 文件删了，卡片还挂着（删掉卡片即可）。

我们追求的最终状态叫 **aligned（对齐）**：该有卡片的文件都有卡片，且每张卡片和代码一致。

***

## 第 5 部分：把 AOCI 连到 Trae

### 步骤 15：在 Trae 里添加 MCP 服务器

**目的**：MCP 是 AI 助手和外部工具之间的"标准插座"。插上之后，Trae 里的 AI 就能调用 AOCI 的九个工具（读卡片、写卡片等）。

在 Trae 中打开 MCP 管理界面（AI 侧栏的 MCP 入口，不同版本位置可能不同，找不到就在设置里搜"MCP"），选择手动添加 / 编辑 JSON，把下面这段加进去（如果已有其他 MCP 配置，只把 `"aoci": {...}` 那一段合并进现有的 `mcpServers` 里）：

```json
{
  "mcpServers": {
    "aoci": {
      "command": "D:\\aoci\\aoci.exe",
      "args": ["--repo", "D:\\works\\deepseek-harness", "mcp"]
    }
  }
}
```

保存后确认列表里 aoci 显示为已连接/已启用。

### 步骤 16：测试插座通不通

**目的**：确认 Trae 里的 AI 真能调到 AOCI。

在 Trae 的 AI 对话框（Agent/智能体模式）里发：

> 调用 aoci\_rules 工具，把返回的规则内容简单总结给我

**成功的样子**：AI 回答的内容里出现 FRAS 规则、配额之类的说明，说明插座通了。

***

## 第 6 部分：让 AI 写卡片（分三批，别一口气吃完）

### 步骤 17：第一批——packages/enterprise/

**目的**：企业插件层是关联改动最频繁的地方，卡片价值最高，先做它。分批做是为了控制成本、好排查问题。

这一层目前共 15 个包（2026-10-17 实测清单）：backend-task、flowable-task-proxy、instance-workspace、kb-context、knowledge、llm-access、platform-user、platform-user-api、platform-user-console、pocket-access、process-start、session-delete、skill-sync、user-identity-context、web-console-proxy。

在 Trae 里发这段提示词（整段复制）：

> 请为 AOCI 索引撰写第一批条目。范围：packages/enterprise/ 下所有 index 角色文件。做法：先调用 aoci\_maintain 获取待办清单，逐个阅读源码后撰写 FRAS 条目，用 aoci\_update\_entry 提交完整批次，最后调用 aoci\_maintain 收尾，并保证 aoci verify 结果为 aligned。写卡片要求：R 字段只写"改这个文件必须一起看/改"的强关联文件（比如事件发送方和接收方）；S 字段只写代码里看不出来的坑（比如上游分歧补丁、必须重建 bundle 之类的纪律），宁可少写不要编造。

**成功的样子**：AI 汇报批次完成，然后在 PowerShell 里跑 `D:\aoci\aoci.exe --repo . verify` 和 `check`，结果为 aligned（或没有 Missing）。

### 步骤 18：第二、三批

**目的**：覆盖剩余范围。做法同上，只把提示词第一行的"范围"换掉（精确路径已按 2026-10-17 的目录结构核实）：

- 第二批：`packages/client/ui-enterprise/`、`packages/bundle/enterprise-app/`、`packages/bundle/enterprise-backend/`
- 第三批：`apps/flowable-engine/`、`apps/web-console/`

***

## 第 7 部分：日常怎么用（只有三句话）

1. **派活照常**：在 Trae 里正常说需求即可。`AGENTS.md` 里的说明书会让 AI 自己"先读卡片、改完代码维护卡片"，你不用每次提醒。
2. **顺手体检**：改完一个功能后，在 PowerShell 跑一次 `aoci --repo . verify`，看到 aligned 就安心。
3. **想看全貌**：跑 `D:\aoci\aoci.exe --repo . ui --detach --json`，浏览器打开它打印的网址，能看到卡片覆盖率、漂移情况（只读面板，仅本机能访问）。

***

## 第 8 部分：以后合并官方新版本时（按《启动脚本.txt》的真实流程，插入一步）

**目的**：每次同步官方代码，管辖的文件会新增/删除/修改，卡片就过期了。让卡片重新对齐之后再去验证，AI 干活才不会拿着旧地图找路。

以下是你的同步脚本（`docs/plans/启动脚本.txt` 末尾"从upstream merge完验证命令"）的完整顺序，其中**第 4 步是新增的 AOCI 动作**，其余原样保留（示例 tag 名 `dsh-v0.2.0-rc.2` 每次换成实际最新 tag）：

```powershell
# ===== 第 0 步：先确认真的需要合并 =====
git fetch upstream --tags
git merge-base --is-ancestor dsh-v0.2.0-rc.2 feat/enterprise-platform; if ($?) { "已包含" } else { "未包含" }
# 显示"已包含"→ 不用合并，收工；"未包含"→ 继续

# ===== 第 1 步：master 对齐官方最新 tag =====
git checkout master
git fetch upstream --tags
git reset --hard dsh-v0.2.0-rc.2        # 换成实际最新 tag 名

# ===== 第 2 步：把官方代码合进企业开发分支 =====
git checkout feat/enterprise-platform
git merge master

# ===== 第 3 步：解决冲突（如有）=====
# pnpm-lock.yaml 直接用官方版：
git checkout --theirs pnpm-lock.yaml
git add pnpm-lock.yaml
# 其他共享文件以官方为准，重新套企业改动。
# ★ 特别注意：AGENTS.md 若冲突，务必把"AOCI 托管块"留在企业版里（第 2 部分登记过的）。
#   aoci.txt / aoci.code.txt / .aoci\ 都是 feat 分支新增文件，官方没有，不会冲突。
# 全部解决后：
git add .
git merge --continue

# ===== 第 4 步：【新增】让卡片和合并后的代码重新对齐 =====
D:\aoci\aoci.exe --repo . verify        # 看有多少 Stale / Orphan / Missing
# 然后在 Trae 里发下方的提示词，让 AI 修复
D:\aoci\aoci.exe --repo . check         # 确认 aligned

# ===== 第 5 步：项目验证（原脚本命令，原样执行）=====
pnpm install
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
pnpm run typecheck
pnpm run build
pnpm dsh --profile enterprise

# ===== 第 6 步：推送 =====
git push origin feat/enterprise-platform:master
```

第 4 步在 Trae 里发的提示词（整段复制）：

> AOCI 索引刚经历一次上游合并。请运行 aoci\_maintain 获取过期清单，逐个核对当前源码后用 aoci\_update\_entry 修正所有 Stale 和 Orphan 条目；这次合并新引入的、管辖范围内的文件要补写条目。收尾再调用一次 aoci\_maintain，并保证 aoci verify 结果为 aligned。

两点说明：

- AOCI 对齐只读源码文件，和 `pnpm` 验证互不干扰。如果合并改动太大，也可以先跑完第 5 步再回来做第 4 步——只要**在 push 之前**完成即可。
- 卡片对齐属于"合并收尾动作"，不要拖到下次开发才补。

***

## 第 9 部分：四年后……不对，四周后：验收和后悔药

### 验收（试点满 2–4 周时回答三个问题）

| 问题      | 怎么判断                              |
| ------- | --------------------------------- |
| 卡片帮上忙了吗 | 是否有真实的"靠卡片提前发现关联文件"的例子？一次都没有 = 没用 |
| 维护烦不烦   | 每次改动后维护卡片花的时间/成本能否接受？             |
| 合并官方版本时 | 修复过期卡片的工作量能否接受？                   |

三个都是"是"→ 扩大范围继续用；有"否"→ 走下面的后悔药。

### 后悔药（退出步骤，零残留）

1. 删项目里的 `aoci.txt`、`aoci.meta.txt`、`aoci.code.txt`、`.aoci\`
2. 还原 `AGENTS.md`（删掉 AOCI 托管块和登记行）、`.gitignore`（删掉 `.codex/`）
3. 在 Trae 的 MCP 列表里移除 aoci
4. `D:\aoci\` 整个文件夹想删就删