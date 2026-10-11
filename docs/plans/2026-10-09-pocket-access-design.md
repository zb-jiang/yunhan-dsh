# 云汉 Pocket Access（员工端手机远程访问）设计文档

日期：2026-10-09。状态：M1（代理、双闸门、LAN、管理路由、设置页基础）、M2（审计上报）、M3（隧道、公网网卡）与 M4（设置页配对/设备/身份卡）已实施，§11 可走查项（含 2026-10-11 补走的条目 6 公网链路与互斥切换）已于 2026-10-10/11 完成真机手工验证（审计断言随 M2 实施复验：POCKET_DEVICE_PAIRED / POCKET_IDENTITY_REJECTED 已接线，TASK_COMPLETE 属后续流程节点任务、不在本插件事件集内，见 §11 走查记录），M0 技术验证记录见 §14。

本文档定义企业员工端（DSH enterprise profile）的「手机访问」能力：员工用手机扫码即可实时访问自己电脑上运行的 DSH 员工端 Web 界面，在外出时查看 AI 对话、处理流程待办。覆盖代理层、暴露控制、公网隧道、审计、设置页五个工作项；移动端 UI 适配明确不在本期范围。

## 1 背景、目标与非目标

### 1.1 产品定位

员工离开电脑后仍需要驱动自己工位上的 DSH 员工端：审批人在外批流程待办、查看 agent 任务的实时输出、向工位 agent 追加指令。现有方案（远程桌面、SSH）门槛高且体验差。Pocket Access 在员工 PC 的 DSH 进程内增加一个受控的接入面：手机扫码配对后，手机浏览器呈现的即是本机 webserver 的实时镜像（同一会话空间、同一身份、双向可操作）。

### 1.2 非目标（本期明确不做）

- 移动端 UI 适配（抽屉布局、触控优化）：后续独立工作项。本期手机看到的是桌面布局。
- 插件自更新与自重启（参考实现有，我们不需要——员工端由企业部署管理）。
- 临时访客 PIN、多套独立密码体系（我们用「配对码 + Supabase 同账号登录」替代，见 §5.2）。
- CLI 独立进程模式（只做插件模式）。
- web-console 下发的组织级策略（管理员集中控制员工能否开启 pocket）：v1 用本地 Config，后续项见 §12。
- 对 DSH 核心包与 base/web-app bundle 的任何修改（企业定制边界）。

## 2 现状事实（实施者必读的仓库机制盘点）

以下事实全部来自当前代码，是本设计的地基。第三方开发者在动手前应先按路径通读这些文件。

### 2.1 本地 webserver 的绑定与信任栅栏

- webserver 由 `packages/host/webserver` 实现（`ctx.webServer`），企业 enterprise profile 经 `packages/bundle/web-app/cordis.patch.yml:169-177` 配置为 `host: 127.0.0.1, port: 3080`——**只绑 loopback**，手机无法直连。
- 浏览器侧 Connection 对 `/api` 有信任栅栏：非 loopback Host 需要 `trustedHosts` 声明（`packages/client/connection/src/index.ts` 的 ConnectionConfig.trustedHosts）。本设计不改 webserver 绑定、不改 trustedHosts——代理把入站请求的 Host/Origin 改写为 loopback 权威后转发，上游栅栏自然放行（这正是代理层的存在意义，也是它成为唯一安全闸门的原因）。
- webserver 的 upgrade 路由表支持 WS 升级，但其 FetchHandler 契约不表达「升级后原始 socket 双向转送、首帧先于 upgrade 响应写回、半关闭语义」——因此代理核心使用自有 `node:http.Server`（决策依据见 §3 决策 D3）。

### 2.2 浏览器准入：launch token 与 dsh-auth cookie

- `packages/client/connection/src/browser-auth.ts`（M0.1 代码验证）：launch token（32 字节随机）存进程级 `WeakMap`，**每次进程重启重新生成**；credentials store 的 `credentialKey('client-connection', 'browser-session')` 持久化的是 cookie 的 HMAC 签名 secret（`{kind:'grant', payload:{version:1, secret}}`），跨重启恢复——因此 **cookie 跨重启有效而 launch token 每次重启变化**。首次带 `?token=` 访问 → 303 + `Set-Cookie: dsh-auth-<sha256(authority)>`（HMAC 签名、HttpOnly、SameSite=Strict、30 天）；此后凭 cookie 准入，`/api` 请求经 `connection.admit(req)` 校验 Host 信任 + cookie。
- **该 cookie 只证明「浏览器曾被 launch token 授权」，不携带用户身份。** 同一进程的所有浏览器共享同一 launch token。
- 手机经代理访问时必须完成同一次握手：代理在 `GET /` 且无 dsh-auth cookie 时自动向路径补 `?token=<launch token>`，上游 303 换 cookie。launch token 的获取方式（**宿主 API 唯一路径**，credentials 直读已证伪）见 §6.2.4，M0 验证完成。PC 重启后 cookie 因签名 secret 恢复而继续有效，手机零输入场景不受 token 轮换影响。

### 2.3 企业身份层：Supabase JWT、/me 与 currentUser 单例

- 浏览器端 `packages/client/ui-enterprise/src/client/EnterpriseUi.tsx`：supabase-js `persistSession`，access token 存浏览器 `localStorage['dsh.enterprise.token']`，每次企业 API 调用带 `Authorization: Bearer`。企业层**没有会话 cookie**，纯请求级验证。
- `/me` 链路：浏览器 `GET /api/enterprise/auth/me`（带 Bearer）→ `packages/enterprise/platform-user-api/src/index.ts:177-189` 解析 token → `ctx.platformUsers.getUserByToken()`（provider 在 `packages/enterprise/platform-user-console`，JWKS 本地验签 + web-console `GET /api/users/me` 自读）→ emit `platform-user/verified` → `packages/enterprise/user-identity-context/src/index.ts` 的 `CurrentUserService.observe()` **无条件覆盖**进程级单例 `ctx.currentUser`。
- **硬事实：webserver 侧的 Supabase token 快照是每进程全局一份，不按浏览器区分。** 桌面与手机两个浏览器同时登录时，后调 /me 者覆盖先者；token 续期（TOKEN_REFRESHED）也会重调 /me 触发覆盖。若两端是同一员工（同 sub），覆盖等价于刷新，无害；若是不同人，后登录者将劫持整个进程的企业身份（skill-sync、llm-access、knowledge、身份注入块全部消费者都随后登录者工作）。**本设计的身份绑定闸门（§5.2、§6.4）正面解决此问题。**
- 登出：`POST api/enterprise/auth/signout` → emit `platform-user/signout` → currentUser 清空。
- **登录遮罩盖住整帧**：ui-enterprise 注册 `shell.overlay` 认证遮罩（`packages/client/ui-enterprise/src/client/index.ts:96-106`，模块注释「未登录/待审批/被禁用时盖住整帧」）——企业 profile 下主界面（含设置菜单、全部业务 UI）必须先完成 Supabase 登录才可见；登录页常驻的「服务配置」弹层是唯一的登录前配置面。**因此设置页内的任何操作（含 pocket 配对码生成）都天然发生在已登录会话中**——能生成配对码的人已经通过了企业认证，首次配对业务流必然是「PC 登录 → 设置页取码 → 手机扫码」。

### 2.4 设置、持久化与子进程的既有能力

- 部署可变配置走 schemastery `Config` + `.volatile()` 字段（`ctx.settings` 设置面板自动投影，config-editor 持久化到活跃 profile patch）。企业插件标准骨架见 `packages/enterprise/skill-sync/src/index.ts`。
- 简单运行时状态文件先例：skill-sync 写 `$DSH_HOME/skill-sync/state.json`（经 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath`）。
- 秘密存储先例：credentials 包（`credentialKey`）。
- 子进程标准：`ctx.subprocess.spawn({ argv, stdio, graceMs, signal, env })`（`packages/subprocess/subprocess`），返回带 `done`/`terminate()`/`waitForExit()` 的 handle；env 有清洗（credential 形状的名与 `DSH_*` 剥除）。**隧道子进程必须走它，不得裸用 child_process。**
- 生命周期纪律：`docs/defensive-patterns.md`——dispose 必须到达 quiescence（先关监听器、再销毁被跟踪 socket、再 server.close 并 await）；单请求异常绝不进程退出；子进程 env 不给 ambient 环境。

### 2.5 审计

- 表：`public.audit_events`（建表 SQL 见 `docs/plans/2026-09-21-local-pg-setup-guide.md` §3.1：id/event_type/target_user_id/operator_id/details JSONB/created_at）。
- 写入：`apps/web-console/backend/.../audit/AuditService.record(eventType, targetType, targetUserId, operatorId, details)`，各业务 Service 在事务内同步调用。
- 安全：`config/SecurityConfig.java`（SecurityFilterChain + `@PreAuthorize` + JWT JWKS 验签；服务间走 `ServiceKeyAuthFilter`，白名单仅 `GET /api/backend/kb/`）。**注意仓库中不存在 RouteSecurityPolicyRegistry 这个组件，不要按它设计。**
- 「员工 PC 上的 DSH Node 进程携员工 JWT 调 web-console」有大量先例：platform-user-console、user-identity-context 的 my-org-positions、llm-access 的 /api/llm/models、knowledge 的代理。审计上报走同一模式。

### 2.6 企业插件与 bundle 注册

- 新包骨架：`packages/enterprise/<pkg>/`（package.json/exports/tsconfig references/src/index.ts/src/invariant.ts/tests/<pkg>.spec.ts/README 三件套）。
- 注册三步：`packages/bundle/enterprise-app/package.json` 的 dependencies 加 `workspace:*`；`packages/bundle/enterprise-app/cordis.patch.yml` 的 `- insert:` 加行（id/name/config）；bundle README 的 Inserted row 表补行。
- 客户端 UI 集中在 `packages/client/ui-enterprise`，设置页插槽契约见 `packages/client/ui-settings/src/client/contract/slots.ts`：`settings.section`（完整设置页）、`settings.general.item`、`settings.plugins.tab`。ui-enterprise 已有先例：`id: 'enterprise-services'` 的 settings.section 注册（`src/client/index.ts:155-161`）。

## 3 已确认的关键决策

- **D1 功能默认关闭。** `enabled` Config 默认 false；员工在设置页显式开启（开启动作本身进审计）。
- **D2 双闸门安全模型。** 闸门一：一次性配对码 → 设备 cookie（设备与工位绑定）；闸门二：手机上的 Supabase 登录必须与桌面当前员工同账号（身份绑定，防「配对码泄漏 + 内部人自有账号」的搭车），桌面未登录时手机请求一律拒绝。不引入独立 PIN 体系——Supabase OIDC 就是密码层。详见 §5。
- **D3 代理核心自建 `node:http.Server`。** 理由：WS 升级后需要原始 socket 级操作（首帧先写、半关闭、RST teardown、协议层心跳注入），FetchHandler 契约不表达这些；仓库「插件裸开 HTTP 监听器」虽无先例，但 `apps/cli/config/examples/github-review` 的隔离域第二 webserver 模式同样不满足 socket 级需求。代理必须是唯一 LAN 暴露面；webserver 本体保持只绑 127.0.0.1 不动。
- **D4 手机是严格镜像，永不引导身份。** 手机请求仅在桌面已登录且与手机 Supabase 账号一致时放行；桌面未登录（进程内 currentUser 为空）时一律 403 并提示「回电脑端登录后再用」——进程内的企业身份只能由桌面侧建立，手机不接受引导（拍板理由：宁可罕见窗口回 PC 登录一次，不给「已配对设备 + 任意员工账号」留下接管进程身份的通道）。桌面登出事件联动吊销全部已配对设备（signout-everywhere）。
- **D5 管理面与数据面隔离。** 设置页管理路由只允许 loopback 直连访问；代理对管理前缀强制 403 拒绝转发（因为代理改写 Host 后上游无法区分桌面与手机，代理侧拒绝清单是唯一可靠控制点）。
- **D6 公网隧道默认关闭、fail-closed。** Host 分类「认不出的按公网」处理；隧道支持快速隧道（trycloudflare）与命名隧道（Token + 固定域名）两种模式，均需显式开启。企业推荐命名隧道。
- **D7 审计走 web-console 新端点。** 员工 PC 的 pocket 插件携员工 JWT `POST /api/pocket/access-events`，web-console 落 audit_events；不可达时本地 JSONL 缓冲重放。
- **D8 客户端 UI 落在 ui-enterprise。** 新注册 `settings.section`（id `pocket-access`），不新建客户端包。文案遵循 ui-enterprise 既有惯例（中文直写）。

## 4 总体架构

```
员工 PC（DSH enterprise profile 进程）
┌────────────────────────────────────────────────────────────┐
│  webserver  127.0.0.1:3080（不动：DSH UI / API / WS mux）      │
│        ▲ loopback 直连                ▲ 代理转发（Host 改写） │
│  桌面浏览器                            pocket-access 代理      │
│  （现有全部行为不变）                    0.0.0.0:3081          │
│                                        ├ 闸门一：配对码→设备cookie │
│  ui-enterprise 设置页「手机访问」        ├ 闸门二：同账号校验     │
│   └─ /api/enterprise/pocket/*（仅   │        │ HTTP+WS 透传       │
│      loopback；代理侧拒转发）        ├ LAN 探测/二维码        │
│                                     ├ cloudflared 隧道子进程  │
│                                     └ 审计上报→web-console   │
└────────────────────────────────────────────────────────────┘
   手机浏览器 ──(A) 同一局域网: http://<LAN-IP>:3081 ──────────┘
             ──(B) 公网: https://<隧道域名> → cloudflared → loopback:3081
   web-console :8080  ← POST /api/pocket/access-events（员工 JWT）
```

- **链路 A（局域网）**：手机与 PC 同网段，直连代理端口。默认形态。
- **链路 B（公网）**：cloudflared 把公网域名回连 `127.0.0.1:3081`（源地址必为 loopback，靠公网 Host 分类 + fail-closed 识别为公网流量，施加同等闸门）。
- 手机浏览器拿到的页面即 webserver 的完整 UI：静态资源、`/api`、WS（`/api/events.mux`）全部经代理同源透传，页面内相对 URL 自然落在代理权威上。

## 5 安全模型

### 5.1 信任边界

| 边界 | 信任内容 | 控制点 |
| --- | --- | --- |
| 代理端口 ↔ LAN/公网 | 不可信。LAN 内同事、嗅探者、公网扫描器都在这一侧 | 双闸门 + fail-closed 分类 + 限速 |
| 代理 ↔ webserver | 本机 loopback，完全信任（Host 改写后） | 无（这正是设计核心：把不信任收敛到代理一层） |
| 设置页管理路由 | 仅桌面浏览器（loopback 直连） | 代理拒绝转发 + webserver 路由本身要求 loopback |
| 手机浏览器 ↔ Supabase | 员工真实凭据（OIDC 密码登录），不经代理 | 既有 Supabase 体系 |

### 5.2 双闸门

**闸门一：设备配对。**

- 设置页生成一次性配对码：CSPRNG 8 字符、去除易混淆字符的字母数字表、TTL 5 分钟、单次使用、可撤销；二维码是公用的：隧道运行中编码公网 origin（`https://<隧道域名>/__pocket/pair?code=<code>`，公网 origin 在局域网内同样可达——经 Cloudflare 边缘回源），未运行时回退 `http://<lanIp>:<port>/__pocket/pair?code=<code>`。配对端点对带 `?code=` 的 GET 直接兑付配对（303 回根 + Set-Cookie），表单页只在 URL 无 code 时渲染——扫码即完成配对，无需手动输码。配对码生成受登录遮罩保护（§2.3）——生成动作必然发生在 PC 端已登录会话中，本身就是一道隐式认证。
- 手机打开后代理校验 code（常量时间比较）→ 签发设备 cookie `dsh_pocket_device=<deviceId>.<HMAC-SHA256(deviceId, pairingSecret)>`（HttpOnly、SameSite=Strict、Path=/、Max-Age 30 天）→ 303 到 `/`。pairingSecret 为持久随机密钥（存运行时状态文件，0600），**设备配对跨进程重启有效**——配对是「可信设备」语义：一次配对、长期有效、可吊销。与参考实现「会话绑定进程」（重启即全部失效）刻意不同，原因：配对码只能在员工电脑旁生成，若绑定进程，员工在外时 PC 重启即永久失联且无远程重新配对手段，主打场景断裂；代价是失窃手机重启后仍保持配对，缓解：30 天上限、设置页随时吊销、lastSeenAt 可见、后续不活动过期升级项（§12）。
- 设备清单（id/createdAt/lastSeenAt/UA/revokedAt/source）持久化于 `$DSH_HOME/pocket-access/devices.json`（0600），上限 10 台，可在设置页逐一吊销。source 为最近一次配对（含复用）的网络入口（`lan`/`wan`，由代理的来源分类映射：公网宿主 → `wan`，其余含 loopback → `lan`），设置页设备表显示「公网/局域网」列；早于该字段引入的记录缺失，显示「—」。cookie 校验 = HMAC 有效 **且** 设备在活跃清单中（吊销即时生效）。设备 cookie 按 host 隔离是浏览器标准行为：同一手机经局域网与公网两个入口会各发起一次配对，配对成功时按 UA 复用——存在同 UA 的活跃设备则复用其记录（刷新 lastSeenAt、覆盖 source 为最近入口、重签 cookie，不占设备上限），UA 不同或为空才新建；局域网/公网两个入口因此只显示一条设备记录。
- 配对码尝试限速：单 IP 5 次失败/60s 锁 60s；全局 50 次/60s 锁 30s；锁定期内不做比对（防止锁定窗口变成免费穷举窗口）；HTTP 与 WS 上的 code 尝试并入同一计数器；无凭据访问与 cookie 失配不计失败。

**闸门二：同账号身份绑定（严格镜像，无策略开关）。**

- 代理对携带 `Authorization: Bearer <jwt>` 的转发请求执行：`sha256(token)` 查 5 分钟正向缓存，未命中则 `ctx.platformUsers.getUserByToken(token)` 解析平台用户 → 与 `ctx.currentUser` 当前用户比对 `id`。
- 桌面已登录：不一致 → 403 + 审计 `POCKET_IDENTITY_REJECTED`（reason=mismatch）；一致 → 放行（/me 覆盖等价于同账号 token 刷新，无害）。
- 桌面未登录（currentUser 为空）→ 一律 403 + 审计 `POCKET_IDENTITY_REJECTED`（reason=no-desktop-identity），页面提示「回电脑端登录后再用」。手机永不引导进程身份——进程内的企业身份只能由桌面侧建立。**该场景已被登录遮罩收窄到极罕见**：首次配对必然发生在 PC 已登录时（§2.3），正常重启后手机靠自身 persistSession 静默恢复会话；只有「进程重启 + 桌面浏览器无人打开 + 手机端 Supabase 会话恰好也过期」三者同时成立才会出现，此时员工回 PC 登录一次即恢复，无数据损失。
- 登出联动：`platform-user/signout` 事件 → 清空设备清单并立即对全部活跃 WS 隧道发 close 帧（状态码 4002、reason「桌面端已退出登录」）——桌面点「退出登录」等于下线所有已配对设备，手机端即时感知断线；重连被闸门一拒绝回 401（`code: device-unpaired`），手机端失效页接管（§6.3 撤销段）。

**不带 Authorization 的请求（DSH 原生 API：会话、消息、WS）**：闸门一通过即放行——配对码即该层的凭证，与参考实现的模型等价。残余风险（配对码泄漏者可触碰 DSH 工作区）在威胁模型表中显式接受，缓解手段：一次性 + 短 TTL + 员工自己生成 + 吊销 + 审计。

用户视角时间线（实施者对照 §11 验证）：

- 第 1 天（在电脑旁）：PC 登录 → 设置页「手机访问」生成二维码 → 手机扫码完成配对（一次即可，30 天有效、可吊销）→ 手机打开链接看到的是同一个企业登录页（登录遮罩对代理流量同样生效）→ 输一次 Supabase 账号密码，手机浏览器 persistSession 从此记住。
- 日常：手机打开链接直接进主界面，零输入（配对 cookie 与手机端 Supabase 会话都在）。
- PC 重启后：服务端身份记忆清空（仅内存），手机打开链接 → 手机自身会话仍有效，其 /me 自动把服务端身份补回 → 照常可用，零输入。
- 罕见窗口（进程重启 + 没人开过桌面浏览器 + 手机端会话恰好失效三者同时成立）：手机重新输密码登录也不被接受——服务端拒绝（手机永不引导身份）并提示「回电脑端登录后再用」；回 PC 登录一次后手机照常可用。

### 5.3 Host/源地址分类（fail-closed）与 policyHost

两套分类器，兜底方向**相反**且各有理由：

| 分类器 | loopback | lan | public | 认不出的兜底 |
| --- | --- | --- | --- | --- |
| classifyHost（Host 头/域名） | localhost/0.0.0.0/::1/127.*/裸 IPv6/空 | RFC1918；CGNAT 100.64.0.0/10（Tailscale/ZeroTier）；fe80:/ULA；`.local`；无点单标签 | 其余一切 | loopback（历史行为，防裸 IPv6 误伤本机） |
| classifySource（TCP 源地址） | 同上 + 169.254.* | 同上 | 其余一切 | **public**（源地址不可伪造，兜底必须收紧） |

- **policyHost（只收紧不放松）**：Host 头可伪造（直连代理端口写 `Host: 127.0.0.1` 即可冒充本机），因此用源地址分类给 Host 声明设下限——仅当源地址的保护级别（loopback=0 < lan=1 < public=2）**高于** Host 声明级别时，用源地址覆盖 Host 参与判定。方向不能反：隧道公网流量的源地址恰是 127.0.0.1，若按源覆盖会把公网降级成免密。
- 公网 Host 强制走完整双闸门且要求隧道处于运行态，否则 403——不存在「陌生域名按 LAN 处理」的口子。
- 手动 LAN 地址覆盖（`lanIpOverride`）优先级最高：Radmin 等公网段 overlay 地址一律按局域网裁决。
- 客户端 IP 识别：源为 loopback（隧道回连）时认 `cf-connecting-ip`，其余一律 socket 源地址，`x-forwarded-for` 永不信任。
- 两个分类器 + 网卡打分（§6.5）三处的网段表必须共用同一常量表。

### 5.4 会话与限速语义汇总

- 设备 cookie 30 天 + 持久配对（跨重启、可吊销）；配对码 5 分钟单次；限速参数见 §5.2；握手重试（launch token 注入）按 IP 3 次/60s 上限（Safari 不保存 http://纯IP 源上 3xx Set-Cookie 的兼容处理见 §6.2.5）。
- 上游请求流式透传，不整体缓冲 body（附件上传可到 50MB）；代理自身管理路由 body 上限 8MB。

### 5.5 威胁模型

| # | 威胁 | 缓解 | 残余 |
| --- | --- | --- | --- |
| T1 | LAN 同事扫描 3081 端口直连 | 无配对 cookie 一律 403 引导页 + 限速 | 无 |
| T2 | 伪造 Host 头冒充 loopback | policyHost 源地址只收紧 | 无 |
| T3 | 嗅探 QR（肩窥/录屏） | 5 分钟单次码、生成需已登录会话（§2.3）、可吊销、审计配对事件 | 短窗口内可用，可事后吊销 |
| T4 | 配对码泄漏 + 内部人用自己账号搭车 | 闸门二同账号校验 + 403 + 审计；桌面未登录时手机请求也一律拒绝 | 无 |
| T5 | 手机端 cookie 被同一 LAN 设备窃取（http 无 TLS） | cookie 为 HMAC 值 + 可吊销 + lastSeenAt 可见；公网隧道走 HTTPS 边缘 | LAN 明文传输是已接受残余风险（与参考实现一致），后续项可加 mTLS/PIN 二次确认 |
| T6 | 公网隧道域名被扫描 | 双闸门照常 + 命名隧道固定域名 + 随机快速域名天然轮换 | 无新增 |
| T7 | 桌面端 dsh-auth cookie 经代理泄漏到手机？ | cookie 按代理权威隔离（host-only），不跨设备 | 无 |
| T8 | 手机 /me 覆盖桌面身份 | 同账号时等价刷新；异账号被闸门二拒绝 | 无 |
| T9 | 通过代理调管理路由（手机遥控开关隧道） | 代理侧对 `/api/enterprise/pocket/**` 一律 403 拒转发（§5.6） | 无 |
| T10 | cloudflared 子进程逃逸/挂起 | ctx.subprocess 托管 + env 清洗 + 优雅停止阶梯 + quiesce | 无 |

### 5.6 管理面隔离

代理转发前的拒绝清单（不论任何 Host/来源）：`/api/enterprise/pocket/`、`/api/enterprise/auth/signout`（桌面登出是本地动作；手机端登出按钮仅清自己浏览器的 supabase 会话）。webserver 侧管理路由同时要求 loopback Host（纵深防御，虽然经代理的流量已被拒）。denylist 为常量表并配单测。

## 6 组件设计

### 6.1 包结构与插件骨架

新包 `packages/enterprise/pocket-access/`（包名 `@deepseek-ai/dsh-pocket-access`，插件 id `pocket-access`）：

```
src/index.ts          入口：Config、apply、服务组装、事件接线、effect 清理
src/proxy.ts          代理核心（HTTP+WS、改写、闸门、压缩、注入、心跳）
src/pairing.ts        配对码/设备清单/cookie 签发与校验
src/identity.ts       闸门二：同账号校验（getUserByToken + 缓存）
src/classify.ts       classifyHost/classifySource/policyHost + 网段常量表
src/lan.ts            LAN IP 探测（打分制 + WSL interop + 手动覆盖）
src/tunnel.ts         cloudflared 生命周期（二进制解析/quick/named/自动恢复）
src/audit.ts          审计事件构造 + web-console 上报 + 本地缓冲
src/state.ts          运行时状态文件（devices.json / tunnel-marker.json / 0600）
src/handshake.ts      launch token 获取 + 注入 + 303 过渡页 + 重试计数
src/invariant.ts      companion 不变量插件（说明为何无需运行时不变量）
tests/pocket-access.spec.ts（可按模块拆多个 spec）
```

- `inject = ['webServer', 'currentUser', 'platformUsers', 'subprocess']`（具体服务键名以 llm-access/skill-sync 实际 inject 为准，实施时核对）。
- Config 自包含校验在 apply 开头 throw（端口范围、布尔等）；「未配置合法化」模式：`enabled: false` 是合法初始态，设置页是首次配置入口。
- 全部注册走 `ctx.effect(() => disposer, 'pocket-access: <what>')`；服务类挂 `declare module` 合并（照 skill-sync 的 SkillSyncService 模式）。
- 上游端口取 `ctx.webServer.port`，拿不到即 fail loud（fiber FAILED），不静默降级。

### 6.2 代理核心（src/proxy.ts）

#### 6.2.1 监听与端口

- 绑定 `0.0.0.0:<bindPort>`，默认 3081；EADDRINUSE 时从 bindPort 起顺延尝试至多 10 个端口，全部占用才抛错；实际端口进状态快照（设置页与二维码都用实际端口）。
- 维护 `clientSockets` Set（含 WS 升级后的 socket——`server.closeAllConnections()` 不含升级 socket）；dispose 顺序：摘路由/停隧道（保留自动恢复标记）→ destroy 全部 client socket → `server.close()` → await quiesce（defensive patterns）。
- 每请求 catch 兜底 400/destroy，单请求异常绝不影响进程。

#### 6.2.2 HTTP 请求管线（顺序即实现顺序）

1. policyHost 判定（§5.3）：公网 verdict 且源非 loopback 一律 403（LAN 设备 / 裸公网源伪造公网 Host）；隧道回连的 Host 恰为公网域名、源必为 loopback（cloudflared 保留原始 Host 头），豁免放行走闸门。
2. 管理路由 denylist（§5.6）：命中 → 403，不透传。
3. 局域网总开关：`lanEnabled=false` 且判定为 LAN 来源时——浏览器导航（Accept 含 text/html 或路径为 `/`/`.html` 结尾，按 pathname 判以容忍 query）返回 403 提示页，API 返回 403 JSON `{"error":"lan-disabled"}`。loopback 与公网 Host 放行（隧道回连必经 loopback；公网继续走闸门）。
4. 闸门一校验：设备 cookie；无/无效 → 导航请求返回配对引导页（内嵌输入框，POST `/__pocket/pair`，限速同 §5.2），API/WS 返回 401 JSON（`error` 为对外文案 + 机器可读 `code`：签名有效但已吊销 → `device-revoked`，其余含桌面登出清空 → `device-unpaired`，供手机端失效页区分原因，§6.3）。
5. 闸门二校验：带 Authorization 的请求按 §6.4。
6. 头改写（loopbackAuthority）：头键全小写化（防大小写并存重复头）；丢弃并重建 `host=127.0.0.1:<upstreamPort>`、`origin=http://127.0.0.1:<upstreamPort>`、referer（有则解析后强制 loopback 权威，解析失败回退 `http://authority/`）、`sec-fetch-site: same-origin`（宿主特权方法栅栏要求；跨 Host 注入防御）。
7. 清洗 URL 上 `dsh-desktop-*` 前缀 query 参数（历史收藏污染防御），HTTP 与 WS 一律清。
8. launch token 握手注入（§6.2.4）。
9. 转发：`agent: false`（每请求独立连接），流式透传 body，双向断连清理（一侧关闭即销毁另一侧流）。上游连接失败 → 502 文本提示「DSH webserver 未就绪」。

#### 6.2.3 WebSocket 升级管线

上游事实（M0.4 已验证）：webserver 的 upgrade 路由表生产环境唯一注册方是 api-gateway，路径 `/api/remote.mux`（`REMOTE_STREAM_MUX_PATH`，`packages/api/gateway/src/stream-protocol.ts`），客户端连 `ws(s)://<页面权威>/api/remote.mux`；升级 handler 内先 `connection.admit(req)`——与 HTTP `/api` 同一栅栏（Host 信任 + sec-fetch-site + Origin + dsh-auth cookie）再进入 mux。因此代理对 WS 隧道请求套用与 HTTP 完全相同的头改写并携带 dsh-auth cookie 即可，无需在代理上注册任何 upgrade 路由，与 webserver 路由表零冲突。

1-4 与 HTTP 完全同一套判定（policyHost → denylist → LAN 开关 → 闸门一；WS 上带配对码参数的尝试并入限速器），拒绝时写裸 HTTP 状态行后 destroy。

2. 头改写 + dsh-desktop-* 清洗后向上游发起 upgrade；**head 字节（浏览器握手后立即发出的首帧）必须先于 `proxyReq.end()` 写入**——等 101 之后再写会迟到，mux 协议错过窗口。
3. 上游 101：手写 `HTTP/1.1 101 Switching Protocols` + 原样回传上游 upgrade 头 + head 字节，随后 `socket.pipe(proxySocket, { end: false })` 双向转发（`end:false` 防 half-open 僵尸——上游 loopback 收 FIN 不自动关）。
4. teardown 用 `resetAndDestroy()`（RST 强制关）；半关闭（'end'）同样触发 teardown；**上游 socket 的 error 事件必须吞掉**（webserver 重启时 ECONNRESET 不得崩宿主）。
5. 心跳注入：浏览器侧每 30s 写协议层 Ping 帧（`0x89 0x00`，RFC 6455 浏览器自动回 Pong 不经 JS）；任意入站字节归零 miss；连续 2 个周期零入站 destroy（触发客户端指数退避重连，防 NAT/省电静默断链假活）。timer unref，close/error 清理。心跳可整体关闭（Config）。

#### 6.2.4 launch token 获取（M0.1 已验证）

**唯一路径 = 宿主 API**：`ctx.connection.authenticatedUrl(baseUrl)`（服务键 `connection`，`HostConnectionHandle`；实现在 `packages/client/connection/src/rpc-host.ts`，委托 `browserAuth.authenticatedUrl`）。调用 `authenticatedUrl('http://127.0.0.1:<webPort>/')` 后从返回 URL 的 `?token=` 解析 launch token；先例见 `packages/bundle/web-app/src/index.ts` 的 `ctx.inject(['connection'], ...)`。**credentials store 直读不可行**——`credentialKey('client-connection', 'browser-session')` 存的是 cookie 签名 secret 而非 launch token（M0.1 证伪，§2.2）。launch token 每次进程重启重新生成，代理不得缓存跨重启使用，每次握手即时取用。`ctx.connection` 不可用时握手功能标记 unavailable，配对页提示「请先在桌面浏览器打开一次 DSH」并在状态快照透出 `handshakeAvailable: false`。注入规则：仅 `GET /`、请求尚无 `dsh-auth-` 前缀 cookie、launch token 非空时，路径补 `?token=`；URL 带 `__pocket_reauth=1` 强制重握手；已带 dsh-auth cookie 时不注入（防 303 死循环）。

#### 6.2.5 Safari 握手兼容

上游 303 + 本轮已注入 token 的 HTML 导航 → 改写为 200 过渡页（保留 Set-Cookie、删 location、meta refresh 0 跳 `/`）。按 IP 的握手重试计数 3 次/60s：注入即记录，见到 dsh-auth cookie 即清零，超限后 HTML 请求返回 503 + 可操作提示（建议换 Chromium 浏览器或走 HTTPS 公网入口）。

#### 6.2.6 流式压缩与 polyfill 注入

- 压缩：客户端接受 gzip/br && 响应未压缩 && **非 SSE**（content-type 不含 text/event-stream）&& (json 或 text/*) && (无 content-length 或 ≥1024B) → brotli q6（否则 gzip）；流式 pipe，res close 时销毁上游流与压缩流。
- polyfill 注入：**v1 注入清单为空，`injectHtml` 不实施**——真机实测（§14.3，HuaweiBrowser 17/Chromium 132）证实 `AbortSignal.any` 原生可用、`crypto.randomUUID` 由 util-crypto 接管、transport shim 不需要；仅当未来出现缺 API 的旧 WebView 时再引入（机制要点留档：判重用标记属性 `data-dsh-pocket-*` 而非搜字符串；只对未压缩 HTML；注入后删 content-length/etag、强制 `cache-control: no-store`、重算长度）。
- SSE 与已压缩响应绝不缓冲、绝不注入。

### 6.3 配对与设备管理（src/pairing.ts、src/state.ts）

- 配对码：CSPRNG（`crypto.randomInt`，禁止 Math.random——配源码守卫测试防回归）8 字符；字符表 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（去 0/O/1/I/l）；TTL 300s；一次性（使用即焚）；并发有效码最多 1 个（生成新的作废旧的）。
- 设备：id = CSPRNG UUID；cookie 值 `<deviceId>.<HMAC-SHA256(deviceId, pairingSecret)>`；pairingSecret 与设备清单持久化 `$DSH_HOME/pocket-access/devices.json`（0600，写入后 fsync，含每台 lastSeenAt）；上限 10 台，超出拒绝并提示先吊销；校验 = HMAC 有效且 deviceId 在活跃清单中（吊销即时生效、跨重启有效）。配对成功先查同 UA 活跃设备（UA 为空不查），命中则复用记录并跳过上限检查——覆盖同一手机经局域网/公网两个入口各配对一次的场景（§5.2），复用与新建都把调用方传入的 source 记为设备最近入口（不传保持缺失）；否则计入上限新建。
- 撤销：设置页逐台吊销（吊销成功即对该设备全部活跃 WS 隧道发 close 帧，状态码 4001、reason「配对已撤销」）；`platform-user/signout` 全清并断开全部隧道（4002）；`enabled` 关闭时全部连接即时 403（监听器关闭）。被踢手机端感知断线后自动重连，新请求被闸门一拒绝回 401（`device-revoked` / `device-unpaired`）。
- 手机端失效页：浏览器 WS API 在升级失败时不暴露 HTTP 状态码与响应体，核心连接层把重连失败当普通网络故障无限指数退避，手机端只会停在「重新连接中」。因此失效判定放在 UI 层（ui-enterprise `pocket-pairing-expiry.ts` + `PocketPairingExpired.tsx`）：连接离开 connected 后用普通 fetch（能读到 401 body）探测一次 `api/enterprise/auth/config`——401 按 `code` 细分为「配对已撤销」（`device-revoked`）或「配对已失效」（其余，含桌面登出清空），403 判为「手机访问已关闭」，其余状态或网络异常不置结论；探测结论是终态，落地后停止探测并渲染全屏失效页（原因 + 重新扫码指引 + 重新加载按钮），探测返回时连接已恢复 connected 则丢弃过时结论。PC Electron 直连 webserver 端口不经代理闸门，永不触发。
- 本地 JSONL 审计缓冲（§6.7）同目录 `audit-backlog.jsonl`。

### 6.4 闸门二实现（src/identity.ts）

- `sha256(token)` → `{ userId, at }` 正向缓存 5 分钟（负向不缓存——避免攻击者用垃圾 token 打满缓存；负向直接走校验并计数限速）。校验走 `ctx.platformUsers.getUserByToken`（JWKS 本地验签 + web-console /users/me，网络调用因此必须缓存）。
- 与 `ctx.currentUser.user?.id` 比较；结论与决策见 §5.2。账号不一致统一 403 `identity-mismatch`、桌面未登录 403 `desktop-login-required`；403 响应体的 `error` 值为面向手机端的中文展示文案（机器原因与具体差异只进日志/审计，不进响应体）。
- token 变化（续期）自然换缓存键，无失效逻辑需要。

### 6.5 LAN 探测（src/lan.ts）

- 网卡枚举打分：跳过 127.*/169.254.*/internal；私网（RFC1918 + CGNAT 100.64/10）+100；接口名匹配物理网卡正则（wlan/wi-fi/ethernet/eth\d/en\d/wlp\d/以太网/本地连接等）+20；匹配 VPN/虚拟网卡正则（radmin/tailscale/zerotier/tun/tap/vpn/vethernet/virtual/vmware/virtualbox/wsl/docker/teredo 等）−50；同分保持枚举序；无私网时回退最高分（纯 VPN 环境仍可用）。候选列表（含手动覆盖值，去重）进状态快照供下拉选择。
- WSL：判据 = `/proc/version` 含 microsoft/wsl 或 `WSL_DISTRO_NAME`/`WSL_INTEROP` 存在（**绝不能用 WSLENV 判**——Windows Terminal 在原生 Windows 也设置它）；经 interop 执行 `ipconfig.exe`（PATH 不含时用 `/mnt/c/Windows/System32/ipconfig.exe` 绝对路径，timeout 5s），解析中英文输出（按顶格块分段、跳过 VPN 正则命中的块、取每块首个 IPv4），失败回退本机探测。
- 探测结果缓存 15s（设置页 3s 轮询下避免重复枚举）。

### 6.6 隧道管理（src/tunnel.ts）

- 二进制解析顺序：显式路径（Config `cloudflaredPath`）→ PATH 探测（`subprocess.resolveExecutable`，win32 查 `cloudflared.exe`，其余查 `cloudflared`）。**不做自动下载与缓存**——cloudflared 由用户手工安装（Windows winget、macOS brew、或官网安装包），程序只探测不安装；PATH 无可执行文件时抛 TunnelRequestError（消息含平台化安装指引，经管理路由 400 直达设置页错误提示，隧道卡 error 态同样显示）。
- 快速隧道：`cloudflared --no-autoupdate tunnel --url http://127.0.0.1:<proxyPort> --protocol http2`（`--no-autoupdate` 必须在全局位置；http2 强制走 TCP 443 规避 UDP 7844 被企业网屏蔽）。URL 解析正则排除 `api.trycloudflare.com`（负向前瞻），stdout+stderr 合并扫，30s 就绪超时，失败摘要：参数错误取命中行、运行期错误取尾部 4 行、500 字符上限。
- 命名隧道：Token 经 **`TUNNEL_TOKEN` 环境变量**注入子进程（长期凭据不进 argv/进程列表）；`cloudflared --no-autoupdate tunnel run --protocol http2`；就绪判据 stderr 出现 `Registered tunnel connection`；URL 由 `https://<tunnelHostname>` 拼出。Token 持久化于运行时状态文件（0600），UI 只回显 `tokenSet: boolean`。
- 生命周期：单飞（in-flight start 复用）；stop 与 start 竞态处理（旧 start 的 finally 仅在引用仍是自己时清理）；意外退出回调把状态打回 error（UI 不得永远显示可用）；**自动恢复标记** `tunnel-marker.json`：手动停止/恢复出厂删除标记，进程 dispose（被动消失）保留标记，下次启动读到标记自动拉起，恢复失败保留标记下次再试；标记读写经串行队列（防异步写晚于删除落盘复活标记）。
- 子进程一律 `ctx.subprocess.spawn`（env 清洗、graceMs 停止阶梯、done 正交上报）；stdout/stderr 摘除监听后 resume（防 64KB 管道阻塞卡死子进程）；spawn error 必须接（坏二进制不得崩宿主）。
- 开启公网必须每次显式确认（UI 免责弹窗 + **服务端强制校验 `disclaimer: true`**，防绕过前端直调）。

### 6.7 审计上报（src/audit.ts + web-console 新端点）

事件类型（operator = 员工本人，target = 员工本人或 pocket_device）：

| event_type | 时机 | details 要点 |
| --- | --- | --- |
| POCKET_ENABLED / POCKET_DISABLED | 设置页开关 | port |
| POCKET_DEVICE_PAIRED | 配对成功 | ip、ua 摘要、deviceId |
| POCKET_DEVICE_REVOKED | 吊销/登出联动 | deviceId、原因 |
| POCKET_IDENTITY_REJECTED | 闸门二拒绝（账号不一致或桌面未登录） | ip、presentedUserId（不回 token）、reason（`identity-mismatch` 或 `desktop-login-required`，与 identity.ts `IdentityCheckFailureReason` 对齐） |
| POCKET_TUNNEL_STARTED / STOPPED | 隧道开关 | mode、url |
| POCKET_LAN_DISABLED_HIT | LAN 关闭期间被拒 | ip |

- 上报：员工 PC Node 进程携 `ctx.currentUser.getToken()` `POST {webConsoleUrl}/api/pocket/access-events`，body 为事件数组（≤100 条/批）；成功后从本地 backlog 清除。
- 失败缓冲：`$DSH_HOME/pocket-access/audit-backlog.jsonl` 追加，启动与每次上报成功后重放；backlog 上限 1000 条，溢出丢最旧并 warn。
- web-console 侧新增 `PocketAccessController`（`@RequestMapping("/api/pocket")`，方法级 `@PreAuthorize("isAuthenticated()")`，`@AuthenticationPrincipal AuthContext auth`）：schema 校验事件数组 → 逐条 `auditService.record(eventType, "pocket_device", targetUserId, auth.platformUserId(), details)` → `ApiResponse.ok()`。无登录态时（员工未登录、进程内无 token）事件只进 backlog，等登录后重放——**审计不丢**。

### 6.8 配置面与运行时状态

Config（schemastery，volatile 可热改）：

| 字段 | 类型/默认 | 说明 |
| --- | --- | --- |
| enabled | boolean，false | 总开关；关闭即停监听器与隧道 |
| bindPort | 1–65535，3081 | 代理起始端口（EADDRINUSE 顺延） |
| lanEnabled | volatile boolean，true | 局域网接入开关（独立于总开关） |
| lanIpOverride | volatile string，'' | 手动局域网地址（非法 IPv4 setter 拒绝） |
| tunnelEnabled | volatile boolean，false | 公网隧道开关（另需每次 start 显式确认） |
| tunnelMode | volatile 'quick'\|'named'，'quick' | 隧道模式 |
| tunnelHostname | volatile string，'' | 命名隧道固定域名（归一化：剥协议/路径/端口、小写、须为合法域名拒裸 IP） |
| heartbeatEnabled | boolean，true | WS 心跳 |
| cloudflaredPath | string，'' | 手动二进制路径；'' 走 PATH 探测（不自动下载，探测失败报错给安装指引） |
| webConsoleBaseUrl | string（env WEB_CONSOLE_URL 兜底 http://127.0.0.1:8080） | 审计上报目标 |
| pairingTtlMs / maxDevices / rateLimit 参数 | 常量，不做成 Config | 协议常量与安全不变量不入配置面（仓库规则） |

运行时状态文件（`$DSH_HOME/pocket-access/`，全部 0600）：`devices.json`、`tunnel-token.json`（命名隧道 Token，仅 tokenSet 回显）、`tunnel-marker.json`、`audit-backlog.jsonl`。损坏/缺失一律回默认 + warn，不抛错阻断启动。

## 7 契约

### 7.1 代理拦截规则（对外可见行为）

| 请求 | 结果 |
| --- | --- |
| 无设备 cookie 的导航请求 | 200 配对引导页（输入码表单 / 5 分钟提示） |
| 无设备 cookie 的 API/WS | 401 JSON：未配对/登出清空 `{"error":"本设备尚未配对，或电脑端已退出登录导致配对失效，请重新扫码配对。","code":"device-unpaired"}`；已吊销 `{"error":"该设备的配对已被撤销，请重新扫码配对。","code":"device-revoked"}` |
| 配对码正确 | Set-Cookie 设备 id + 303 `/`（随路完成 launch token 握手） |
| 配对码错误/过期 | 引导页带错误文案；限速同 §5.2 |
| LAN 关闭时的 LAN 来源 | 403 提示页 / `{"error":"局域网访问已关闭，请在电脑上的手机访问设置中开启。"}` |
| 异账号 Bearer | 403 `{"error":"手机端登录账号与桌面当前登录账号不一致，请在手机上改用与电脑相同的账号登录。"}` + 审计 |
| 桌面未登录时的 Bearer 请求 | 403 `{"error":"桌面端未登录，请先在电脑上登录 DSH 后再使用手机访问。"}` + 审计 |
| `/api/enterprise/pocket/**`、`/api/enterprise/auth/signout` | 403（denylist） |
| 上游不可达 | 502 文本 |

### 7.2 webserver 管理路由（仅 loopback，代理不转发）

前缀 `/api/enterprise/pocket`（POST JSON，body ≤8MB，错 JSON 400）：

| 端点 | 请求 | 响应 |
| --- | --- | --- |
| GET status | — | §7.4 状态快照 |
| POST enabled | {enabled} | 快照 |
| POST lan | {enabled} | 快照 |
| POST lan-override | {ip}（'' 清除） | 快照（非法 400） |
| POST pairing | {action:'create'\|'revoke', deviceId?} | 快照 |
| POST tunnel | {action:'start'\|'stop', disclaimer?}（start 必须 disclaimer:true） | 快照 |
| POST tunnel-config | {mode?, hostname?} | 快照 |
| POST tunnel-token | {token}（'' 清除） | 快照 |

所有响应返回**完整快照**（部分更新也回全量，避免前端局部合并丢状态）。路由注册 `ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler }))`，handler 内先拒绝非 loopback Host（纵使代理 denylist 失效也拦得住）。

### 7.3 web-console 新端点

`POST /api/pocket/access-events`：JWT 认证、`isAuthenticated()`；请求体 `{ events: [{ eventType, targetUserId?, details, occurredAt }] }`（≤100 条）；校验 eventType ∈ §6.7 枚举、details 为对象；逐条 AuditService.record；响应 `ApiResponse.ok({ accepted: n })`。

### 7.4 状态快照（UI 契约）

```jsonc
{
  "enabled": true, "proxyPort": 3082, "upstreamPort": 3080,
  "handshakeAvailable": true,
  "lan": { "enabled": true, "url": "http://192.168.1.50:3082", "qr": "data:image/png;base64,...",
           "candidates": ["192.168.1.50", "100.119.24.44"], "override": "" },
  "devices": [{ "id": "...", "createdAt": 0, "lastSeenAt": 0, "ua": "...", "source": "lan" }], // source = lan|wan|null，null 为字段引入前的旧记录
  "pairing": { "code": "AB23CD45", "expiresAt": 0, "qr": "data:image/png;base64,..." },
  "identity": { "currentUserId": null }, // null = 桌面未登录，手机侧 Bearer 请求将被拒绝
  "tunnel": { "enabled": false, "state": "idle", "mode": "quick", "url": null,
              "hostname": "", "tokenSet": false, "detail": "", "startedAt": 0 },
  "audit": { "backlog": 3 }
}
```

二维码生成：本地 `qrcode` 依赖（M0 确认其 MIT 许可后引入），`errorCorrectionLevel:'M'`、宽 220；内容为纯 URL（含配对码），URL 的 origin 取 `resolvePublicOrigin`（src/index.ts：隧道 running 时返回公网 origin——quick 用边缘 URL、named 拼归一化 hostname，未运行返回 null）优先、局域网 URL 兜底——一个二维码公网/局域网通用（§5.2）；QR 结果按 URL 缓存（容量 8、只淘汰最旧——设置页 3s 轮询下二维码生成是 CPU 密集操作）。

## 8 客户端 UI（ui-enterprise）

- 注册（`src/client/index.ts`，照 `enterprise-services` 先例）：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'pocket-access', order: 31, label: () => '手机访问' }, PocketAccessSection))`。
- `src/client/pocket/PocketAccessSection.tsx`：区块化布局——总开关与状态卡（端口、握手可用性）；局域网卡（开关、二维码、候选 IP 下拉 + 手动覆盖、当前 URL）；配对卡（生成码按钮 + 码/二维码/倒计时、设备清单表含接入入口（公网/局域网/未知）与吊销按钮）；身份卡（当前绑定员工显示；桌面未登录时显示「桌面未登录，手机暂不可用」提示）；公网网卡（免责声明弹窗 + 开启/关闭、模式切换、命名隧道的域名与 Token 表单——Token 仅显示「已配置」）；审计缓冲数提示。3s 轮询 status；所有写操作调 §7.2 路由后用返回快照整体替换。
- 局域网与公网访问互斥（2026-10-11 决策，UI 层保证）：管理路由仅 loopback 可达、设置页是唯一入口，服务端不约束两开关同时开启；由设置页在开启一侧前先经管理路由关闭另一侧（`runMutualExclusive` 串行两个写操作、共享一次 busy 周期，第一步失败即中止）。两入口互斥后配对二维码始终指向当前唯一入口（§7.4 `pairOrigin` 语义无歧义）。
- 文案：沿用 ui-enterprise 中文直写惯例（与 `jsonTreeLabels.ts` 同策略）；免责声明文案须含「公网即把可执行代码的 DSH 暴露到互联网」警示句。
- 提交中模态遵守既有「蒙版防重复点击」惯例；loading/错误态复用现有组件。

### 8.1 工作区目录选择的移动端可用性（enterprise-app bundle 补丁）

问题：web-app 的 `directory-picker` 行是 `-auto`（`dsh-host-directory-picker-auto`），boot 时按宿主一次性解析（loopback bind + win32 → native）；native 表面走宿主 Electron `dialog.showOpenDialog`，手机页面调用 `directoryPicker.pick` RPC 经代理到达 PC 后对话框弹在 PC 屏幕上。auto 的 README 把该场景明确列为 Known Limitations（"opens the chooser on the unattended workstation"），按客户端自适应等一个「同时服务本地与远程客户端」的部署——企业版正是该部署，但 v1 不动上游 seam。

决策（2026-10-10）：enterprise-app patch 禁用 `-auto` 行，直接组合 browse 表面两行（`dsh-host-directory-picker-browse` 后端 + `dsh-client-ui-directory-picker-browse` 客户端表面，disable+insert 写法照 `apps/web/tests/pin-browse-picker.overlay.yml`）。browse 表面是应用内自绘目录浏览器（Miller-column 对话框，走 `list`/`createDirectory` RPC，无 OS chooser），已适配窄视口，手机与 PC 同一交互。

后果：PC Electron 上选工作区也从 OS 对话框变为应用内对话框（功能完整：导航、编辑路径、新建文件夹、隐藏项过滤）；上游若落地按客户端自适应，撤掉本 patch 恢复 auto 即可。

## 9 测试策略

单测（vitest，`packages/enterprise/pocket-access/tests/`），按「测试描述行为」命名，重点全表覆盖：

- **classify 矩阵**：classifyHost/classifySource 全表（含 CGNAT、`.local`、裸 IPv6、空 Host、兜底方向相反性）；policyHost「只收紧不放松」方向性 + 伪造 Host 用例；网段三处共用常量表断言。
- **闸门一**：配对码生成（CSPRNG 源码守卫——本文件不得出现 Math.random）、TTL/单次/并发作废、cookie 签发与持久清单校验、吊销即时生效、限速三通道（POST/URL/WS）并入同计数、锁定期不比对、成功清零、常量时间比较。
- **闸门二**：同账号放行（并验证 /me 幂等语义）、异账号 403+审计（reason=mismatch）、桌面未登录 403+审计（reason=no-desktop-identity）、缓存命中/过期。
- **代理行为**：Host/Origin/Referer/sec-fetch-site 改写断言（**用原始 http.request 带 Host 头测试——fetch 会静默丢弃 Host 写入，测不到公网分支**）；WS 首帧先于 end、`end:false`、RST teardown、半关闭销毁、上游 error 吞掉、心跳 missLimit 断连；压缩（大 JSON 字节一致、SSE/已压缩不二次压）；注入（未压缩 HTML、标记判重、no-store）；denylist；LAN 开关 403 两形态；502；EADDRINUSE 顺延；dispose quiesce（升级 socket 也被销毁）。
- **握手**：注入条件、不无限循环、303→200 过渡页、重试上限 503、Safari 计数清零路径。
- **隧道**：命令行参数断言（`--no-autoupdate` 全局位置、http2、Token 走 env 不走 argv）、URL 正则排除 api.、单飞/竞态/TDZ 回归、自动恢复标记的保留与删除矩阵（手动停删/dispose 留/恢复失败留）、错误摘要分段、二进制解析（显式路径直通 / PATH 探测命中 / PATH 缺失抛 TunnelRequestError 含安装指引）。
- **LAN 探测**：打分矩阵（Radmin 不遮 WLAN、双私网、纯 VPN 回退、WSL 中英文 ipconfig 解析、仅 WSLENV 不误判原生 Windows）。
- **审计**：事件构造、批量上报成功清 backlog、失败缓冲与重放、溢出丢最旧、web-console 端点 schema 校验（Controller 侧单测按 web-console 既有测试模式，若该工程无测试基建则至少验证 SQL 与权限注解）。
- **设置持久化**：每字段默认/合法/非法/清除；状态文件损坏回默认。
- 真机冒烟（不进 CI）：LAN 配对全链路、公网隧道全链路各一条脚本化用例，放 `tests/local/`（照参考实现 test/local 模式）。
- 快照策略：设置页属 product-user-visible UI，实施时检查 ui-enterprise 既有 keyless recorded-session 基线，若覆盖设置页则同步更新（以 `docs/testing.md` 与 snapshots/AGENTS.md 为准）。

## 10 工作项清单

### M0 技术验证（先行 spike，产出记录进本文档 §14）——**已完成（2026-10-09），结论见 §14**

1. ~~launch token 获取路径验证~~ ✅ 宿主 API 唯一路径；credentials 直读证伪（§14.1）。
2. ~~3061 前置：手机经临时代理访问 dev 实例~~ ✅ 真机四项全过：dsh-auth 握手、cookie 持久、supabase-js http 登录、WS 透传；polyfill 需求清单实测为空（§14.3）。
3. ~~`qrcode` 依赖许可证确认~~ ✅ MIT（§14.4）。
4. ~~web-app patch 对 webserver upgrade 行为实测~~ ✅ 上游唯一路由 `/api/remote.mux`，admit 同 HTTP 栅栏，代理零冲突（§14.2）。

### M1 代理核心 + 双闸门 + LAN（`packages/enterprise/pocket-access/`）

- 包骨架全套（package.json/exports/tsconfig references——须逐个声明对 webserver、user-identity-context、platform-user、subprocess、home-paths、util 的引用/README 三件套 + README.i18n.yaml 登记/invariant.ts）。
- classify/policyHost/lan/proxy/pairing/identity/handshake/state 各模块 + 单测。
- ui-enterprise 最小设置页（先只读 status + 总开关 + LAN 卡，先不做隧道）。
- bundle 注册三步（enterprise-app package.json 依赖 + cordis.patch.yml insert 行 + README 表）。
- `packages/enterprise/README.md` 包清单表补行。

### M2 审计

- web-console `PocketAccessController` + AuditService 接线 + SecurityConfig 无需改（JWT 默认链路已覆盖 /api/**）。
- pocket-access 侧 audit.ts + backlog 重放 + 事件接线（开关/配对/吊销/身份/隧道全事件）。
- web-console 前端审计页无需改（事件进入通用 audit_events，按 eventType 可筛）。

### M3 隧道

- tunnel.ts 全模块（解析/quick/named/自动恢复/单飞）+ subprocess 接线 + 单测（cloudflared 手工安装，PATH 探测缺失报错）。
- 设置页公网网卡 + 免责弹窗（服务端 disclaimer 校验）。

### M4 设置页完整化 + 收尾

- 配对卡（生成码/倒计时/设备表/吊销）、身份卡、审计缓冲提示。
- README 三件套双语化 + `verify-translation-pairing --write`（注意先 git add 暂存再跑）。
- 端到端手工验证（§11）走查 + 文档状态行更新为「已实现」。

### 项目收尾（每个里程碑共同要求）

- `pnpm run typecheck`、`pnpm run lint`、目标包 vitest 全绿（由仓库所有者手工执行——沙箱限制）。
- 每个 effect 标签、每处注册可对照本文档章节。
- 不改 base/web-app patch、不改 DSH 核心包——PR diff 应只含 `packages/enterprise/pocket-access/`、`packages/client/ui-enterprise/`、`packages/bundle/enterprise-app/`、`apps/web-console/`、`packages/enterprise/README.md`、本文档。

## 11 端到端手工验证清单

准备：两台设备（PC + 手机，同 WiFi）；Supabase 可达；web-console 已启动且员工账号已开通；DSH enterprise profile 已启动。

1. 正向链路：设置页开启 pocket → 出现局域网二维码 → 手机扫码（自动完成配对，无需输码）→ 手机出现完整 DSH 界面 → 手机登录同一 Supabase 账号 → 待办工作台可见、AI 对话实时同步（桌面打字手机滚动）、手机提交一条待办流程（结构化映射成功）→ web-console 审计页出现 POCKET_DEVICE_PAIRED 与 TASK_COMPLETE。
2. 双闸门：手机换另一个员工账号登录 → 企业 API 403、审计出现 POCKET_IDENTITY_REJECTED → DSH 原生会话仍可见（符合设计）→ 换回正确账号恢复。罕见窗口：重启 DSH（不开桌面浏览器）并清除手机端 Supabase 会话 → 手机重新登录被拒、提示回电脑端登录、审计 reason=no-desktop-identity → 桌面登录后手机恢复可用。
3. 吊销与登出：设置页吊销该设备 → 手机界面即时断连并出现「配对已撤销」全屏失效页（重连不再无限转圈）；桌面点退出登录 → 手机全部即时断连并出现「配对已失效」失效页；两种场景下页面提供「重新加载」按钮与重新扫码指引。
4. LAN 开关与总开关：关闭局域网访问 → 手机新导航请求回 403 提示页、已打开页面出现「手机访问已关闭」失效页 → 桌面浏览器（loopback）不受影响。关闭总开关 → 数秒内出现「手机访问连接已断开」失效页；重新开启总开关 → 失效页自动消失、连接恢复。
5. 管理面隔离：手机上直接请求 `/api/enterprise/pocket/status` → 403。
6. 公网链路（可选，需外网）：前提——cloudflared 已手工安装并加入 PATH（Windows `winget install --id Cloudflare.cloudflared`、macOS `brew install cloudflared`），未安装时开启公网卡应报错并显示安装指引。然后开启快速隧道 → 设置页二维码切换为公网地址 → 同一手机扫码直连（自动配对）→ 4G 网络下完整走一遍正向链路 → 设备列表仍只显示一条记录（同 UA 复用，§5.2）；重启 DSH → 隧道自动恢复 → 公网地址变了但手机重新扫码可连。
7. Safari 兼容（如有 iOS 设备）：确认握手不无限重定向，超限后出现可操作提示页。
8. WSL（如有环境）：WSL 内跑 DSH → 二维码给的是 Windows 宿主物理网卡 IP。

走查记录（2026-10-10，真机 PC + 手机同 WiFi）：条目 1、2、3、4、5 的行为部分全部实测通过。条目 1/2 中的审计断言（POCKET_DEVICE_PAIRED、TASK_COMPLETE、POCKET_IDENTITY_REJECTED）依赖 M2 审计接线，随 M2 实施复验。条目 7/8 为可选环境项，有待机环境时补测。

走查记录（2026-10-11，真机 + cloudflared 外网）：条目 6 公网链路实测通过（快速隧道开启 → 二维码切公网地址 → 4G 手机扫码直连）；§8 局域网/公网互斥切换实测通过（开一侧自动关另一侧，二维码始终指向当前唯一入口）。

## 12 边界与后续项

- 移动端 UI 适配（抽屉布局/触控）——独立后续工作项。
- web-console 下发组织级策略（管理员集中允许/禁止 pocket、强制隧道策略）——需要 console 新增策略表与员工端拉取，v2。
- 放开「手机引导身份」的可选策略——v1 已拍板为严格镜像（桌面未登录时手机请求一律拒绝）；若未来接受「已配对设备 + 真实凭据」引导进程身份，需新增管理员开关、专项审计事件与威胁模型重评，v1.1 候选。
- 设备 cookie 不活动过期（仅真实用户操作续期，WS/自动请求不续）与渐进锁定——参考实现演进方向的借鉴项，v1.1。
- LAN 明文传输的强化（可选 mTLS 或配对后再加本地确认）——待威胁反馈；现实缓解见下方部署建议。
- 会话开始/结束粒度的远程访问审计（现在记事件级，不记会话时长）。
- Electron 桌面壳前向兼容：设计不感知桌面壳——企业规划形态（Electron 应用包 = 浏览器页面 + 同一 webserver 后台服务）下，桌面壳加载的仍是 127.0.0.1:3080，代理照常面向 webserver，桌面流量不经代理。已内置适配：URL 一律清洗 `dsh-desktop-*` 参数（§6.2.2）。将来若 Electron 壳引入「非壳浏览器访问门禁」（上游 403）或 advanced 布局模式（禁用网页布局、手机白屏），需分别补 403 提示页改写与白屏警告覆盖层，届时在 §14 回填。
- 高安全部署建议：LAN 形态为明文 HTTP，`Authorization: Bearer` 携带的 Supabase access token（默认约 1 小时时效）可被同网段嗅探后冒用；高敏环境建议仅在 VPN overlay（Tailscale/ZeroTier——流量已被 overlay 加密，网段已按 LAN 分类）或公网隧道（Cloudflare HTTPS 边缘）形态启用，或由企业统一分发 cloudflared 并锁定版本 SHA256。
- 远程设备治理：v1 的配对与吊销均需在员工电脑旁操作（持久配对缓解了重启失联，但失窃手机的吊销仍需人到工位）；v2 可由 pocket 向 web-console 心跳上报设备清单与代理地址，管理员在 console 侧查看/吊销任意员工的设备，员工也可远程发起重新配对。

## 附录 A：采纳的参考实现踩坑经验（行为规格，非代码引用）

以下条目在设计中已转化为具体规则（正文已标注），此处汇总留痕：

1. Host 头可伪造——policyHost 源地址只收紧不放松；方向不能反（隧道流量源是 loopback）。
2. `cf-connecting-ip` 仅 loopback 来源认；XFF 永不信任。
3. URL `?token=` 与 WS 握手是限速旁路——三通道并入同一限速器；锁定期不做比对。
4. 无凭据访问与 cookie 失配不计失败——防正常用户自锁；cookie 存 sha256(PIN:sessionKey) 类哈希而非明文。
5. 常量时间比较；PIN/码生成必须 CSPRNG（配源码守卫测试）。
6. fail-closed：Host 认不出按公网（陌生域名强制完整闸门）；classifySource 兜底方向与 classifyHost 相反。
7. WSL 判据禁用 WSLENV（Windows Terminal 原生也设置）；interop ipconfig.exe 需绝对路径兜底。
8. 多网卡打分制 + 手动覆盖优先（Radmin/Easytier/Tailscale 场景）。
9. WS 首帧必须先于 upgrade end 写入；`end:false` 防 half-open；RST teardown；上游 error 必须吞。
10. 空闲 WS 需协议层心跳（NAT/省电静默断链）——30s ping、2 miss 断开。
11. Safari 不保存 http://纯 IP 源上 3xx 的 Set-Cookie——303 改 200 过渡页 + 重试上限。
12. SSE 不缓冲不压缩；已压缩 HTML 不注入；注入用标记属性判重。
13. 压缩选 brotli q6（q11 压 17MB 要 40s+）；触发条件含「无 content-length 或 ≥1024B」。
14. cloudflared：`--no-autoupdate` 全局位置；`--protocol http2` 规避 UDP 屏蔽；URL 正则排除 api.；Token 走 env 不走 argv；监听摘除后管道必须 resume；spawn error 必须接；安装交给用户手工完成，程序只做 PATH 探测，缺失报错附安装指引。
15. 自动恢复标记：手动停删、进程被动消失留、恢复失败留；标记读写串行队列。
16. EADDRINUSE 端口顺延（上限 10）；close 必须显式销毁升级 socket（closeAllConnections 不含它们）。
17. dsh-desktop-* URL 参数是雷区——一律清洗不注入。
18. 非 loopback 权威下 `crypto.randomUUID`/`AbortSignal.any` 可能缺失——最小 polyfill 仅在缺失时安装，宿主自带不覆盖。
19. `?token=` 种 cookie 后子资源才放行——扫码直达首响应即种 cookie。
20. cloudflared 不做自动下载（下载基础设施在不可信网络环境易成为故障点）——用户手工安装，程序只探测 PATH，探测失败报错附平台化安装指引。

## 14 M0 验证记录（2026-10-09 代码层验证回填）

### 14.1 launch token 获取路径（M0.1，已验证）

- **唯一可行路径 = 宿主 API `ctx.connection.authenticatedUrl(baseUrl)`**。服务键 `connection`（`HostConnectionHandle`，`packages/client/connection/src/rpc-host.ts`），实现委托 `browserAuth.authenticatedUrl`；调用 `authenticatedUrl('http://127.0.0.1:<webPort>/')` 后解析返回 URL 的 `?token=` 即得 launch token。宿主先例：`packages/bundle/web-app/src/index.ts` 的 `ctx.inject(['connection'], ...)`。
- **credentials store 直读已证伪**：`credentialKey('client-connection', 'browser-session')` 持久化的是 cookie 的 HMAC 签名 secret（`{kind:'grant', payload:{version:1, secret}}`），不是 launch token。launch token 只存在于进程级 `WeakMap`（keyed by `ctx.root`，`browser-auth.ts` 的 `PROCESS_LAUNCH_TOKENS`），**每次进程重启重新生成**（`browser-auth.host.spec.ts` 证实跨进程 token 变化、同 root 复用）。
- 与设计的自洽性：cookie 之所以跨重启有效，是签名 secret 经 credentials store 恢复使旧 cookie 签名校验继续通过——「PC 重启后手机零输入」场景成立，但机制是「恢复签名 secret」而非「恢复 token」（§2.2 已同步修正）。代理每次握手即时向宿主取 token，不缓存跨重启。
- 降级路径维持原设计：`ctx.connection` 不可用 → `handshakeAvailable: false`。

### 14.2 webserver upgrade 与代理 WS 转发不冲突（M0.4，已验证）

- webserver `registerUpgrade()` 为精确路径注册表，无匹配路径即 `socket.destroy()`；生产环境唯一注册方是 api-gateway，注册路径 `/api/remote.mux`（`REMOTE_STREAM_MUX_PATH`，`packages/api/gateway/src/stream-protocol.ts:7`），注册时机等待 `appReady`（客户端先于 ready 的连接靠重连恢复）。客户端实测连接 `ws(s)://<页面权威>/api/remote.mux`（gateway.client/stream host spec 证实）。
- 升级 handler 内先 `connection.admit(req)`（`packages/api/gateway/src/index.ts:251-259`）——与 HTTP `/api` 同一栅栏：`isTrustedApiRequest`（Host 信任 + `sec-fetch-site=cross-site` 拒绝 + Origin 匹配 Host 权威）+ `browserAuth.isAuthenticated`（dsh-auth cookie）。
- 结论：代理自建 server 把升级请求原样隧道到 upstream，upstream 自己的路由表正常处理；代理对 `/api/remote.mux` 隧道请求套用与 HTTP 相同的头改写并携带 dsh-auth cookie 即可，无需注册任何 upgrade 路由（§6.2.3 已同步写入）。

### 14.3 非安全上下文 API 缺失清单（M0.2，代码层结论；真机实测留手工）

- `crypto.randomUUID`：**无需 polyfill**。仓库已有 `@deepseek-ai/dsh-util-crypto`（`crypto.getRandomValues` 实现 v4 UUID，非安全上下文可用），`no-restricted-properties` lint 规则强制 `crypto.randomUUID` 调用方指向该模块；全仓 grep 证实客户端产品代码无直接 `globalThis.crypto.randomUUID` 调用（仅 util-crypto 自身与 experimental/webworker-runtime 的独立 shim）。
- transport shim：**无需注入**。`__DSH_TRANSPORT__` 是 Electron/桌面壳专用的页面全局，JSDoc 明示「absent in the served web app」，`apply()` 对缺失走默认浏览器 HTTP+WS carrier（`packages/client/connection/src/client/index.ts`）；客户端 WS URL 从 `__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI` 派生（`stream-client.ts:476-477`），pocket 域名下自然指向代理，无需任何 shim。
- `AbortSignal.any`：客户端代码大量直接使用（gateway client 的 stream-client/remote-stream/remote-events、session-controller client 等）。它**不是 secure-context-gated API**，但要求 Chrome 116+ / Safari 17+ / Firefox 121+——现代移动浏览器原生支持，仅旧 WebView 缺失。保留为唯一注入候选，真机实测确认后决定（§6.2.6 已同步收敛）。
- 剪贴板：公共助手 `writeClipboard`（`packages/client/ui-primitives/src/clipboard.ts`）已有 `execCommand('copy')` 降级，非安全上下文可用；但 `JsonTree.tsx:759`、`SignInDialog.tsx:55` 两处直接调 `navigator.clipboard.writeText`，非安全上下文会抛 TypeError → 已知降级点（JSON 树与登录对话框的复制按钮失效），不阻塞，实施时顺手改走 `writeClipboard`。
- `crypto.subtle` / `serviceWorker.register` / `Notification`：客户端无使用，无风险。
- **真机实测已完成（2026-10-09，`D:\works\tmp\pocket-spike.mjs` 一次性代理，仓库外不提交）**：华为 ELS-AN00（HarmonyOS / Android 10），HuaweiBrowser 17.0.8.310（Chromium 132 内核）。四项全过——① dsh-auth 自动握手（`?token=` 注入 → 303 → cookie）直达 DSH 界面；② 杀进程重开浏览器零输入直达（cookie 持久成立，且证实 cookie 无 Secure 属性在 http 下可收，`browser-auth.ts` 的 `sessionCookie`）；③ supabase-js 企业登录在 http 非安全上下文全链路可用（http 页面 → https Supabase 不属混合内容）；④ 会话直播流式正常（`/api/remote.mux` WS 透传 OK）。特性矩阵实测：`isSecureContext: false`、`AbortSignal.any: "function"`（原生可用）、`crypto.randomUUID: "undefined"`（符合预期，util-crypto 接管）、`navigator.clipboard: "undefined"`（符合预期，见上）、`localStorage: ok`、`WebSocket: function`。

### 14.4 qrcode 依赖许可证（M0.3，已验证）

- `qrcode`（node-qrcode，soldair）1.5.4 = **MIT**（基于 Kazuhiko Arase 的 MIT 实现）；`@types/qrcode` 1.5.6 = MIT。满足「MIT 方可引入」约束，按 §7.4 引入。

### 14.5 M0 结论汇总

| 验证项 | 结论 | 对设计的影响 |
| --- | --- | --- |
| launch token 获取 | 宿主 API 唯一路径；credentials 兜底证伪 | §2.2、§6.2.4 已修正 |
| WS 转发不冲突 | 上游唯一路由 `/api/remote.mux`，admit 同 HTTP 栅栏 | §6.2.3 已补充；代理无新增负担 |
| 非安全上下文 API | 注入清单为空：randomUUID/transport shim 无需，AbortSignal.any 真机原生可用 | §6.2.6 已定稿（v1 不实施 injectHtml）；两处 clipboard 直调为已知降级点 |
| qrcode 许可证 | MIT，可引入 | 无 |
