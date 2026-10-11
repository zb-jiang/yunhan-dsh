# 云汉 SSO 认证中心方案设计

| 项   | 内容                                                                                             |
| --- | ---------------------------------------------------------------------------------------------- |
| 日期  | 2026-10-11                                                                                     |
| 状态  | 设计共识已达成，待实施                                                                                    |
| 范围  | 认证中心可配置架构（Supabase / Casdoor / 客户 IdP）；三处验签点配置化；钉钉/飞书集成路径；SOR 门禁对应表服务（设计概要）                    |
| 非范围 | KB Storage 的 Supabase 耦合迁移（独立项）；凭据保管库（加密存储密码/密钥，见第 7 节，按需另立项）；SOR 逐个接入的详细适配设计（随各 SOR 接入时单独出方案） |

核心共识：**云汉只做 OIDC 的发起登录（RP）与本地验签（RS）两个角色，发证方（IdP）放在可配置的认证中心里**。

***

## 1. 背景与现状

### 1.1 现状认证体系

云汉当前的认证体系以 Supabase Auth 为根：

| 组件                   | 现状                                                                                        | 代码位置                                               |
| -------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 登录                   | 前端持 Supabase anon key 直连 Supabase Auth                                                    | `platform-user-api`（volatile 配置）                   |
| 验签 ① 员工端             | enterprise profile 内 `platform-user-console` 插件，jose 库 + Supabase JWKS，校验 iss + exp + sub | `platform-user-console/src/index.ts`               |
| 验签 ② web-console 后端  | Java NimbusJwtDecoder + Supabase issuer                                                   | `apps/web-console/backend/.../SecurityConfig.java` |
| 验签 ③ flowable-engine | Java NimbusJwtDecoder + Supabase issuer，V1 明确不校验 aud                                      | `apps/flowable-engine/.../SecurityConfig.java`     |
| 用户治理                 | platform\_users 表：审批/禁用/锁定/角色，Web Console 承载写操作                                           | `platform-user` 包                                  |
| 身份关联键                | `auth_subject` = Supabase `sub`                                                           | `platform-user/src/index.ts`                       |

### 1.2 核心问题

1. **账号根在企业外部**：企业实施时员工不可能为云汉单独记一套密码；且换任何认证源都要同时动三处验签点。
2. **Supabase 无中国大陆节点**：官方托管区域最近为新加坡，跨境访问延迟/丢包不可控；JWKS 拉取、登录流量、KB Storage 全在境外。企业客户对"认证依赖境外云"有可用性与数据合规双重顾虑。
3. **国内企业以钉钉/飞书为身份基础设施**：员工身份与在职状态都在 IM 通讯录里，但钉钉/飞书不提供可验签的 IdP 能力（见第 2 节），不能直接当认证中心。

***

## 2. 概念基线：身份源与 IdP

### 2.1 定义

| 概念  | 定义                                              | 例子                                      |
| --- | ----------------------------------------------- | --------------------------------------- |
| 身份源 | 员工真实身份与在职状态的权威所在                                | 钉钉/飞书通讯录、企业 AD/LDAP、Supabase auth.users |
| IdP | 身份提供方：验证身份后签发**可验证凭证**（ID Token + JWKS 公钥端点）的组件 | Supabase Auth、Casdoor、AD FS、Keycloak    |

### 2.2 关键产品事实

| #  | 事实                    | 说明                                                                                                                               |
| -- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| F1 | Supabase = 身份源 + IdP  | auth.users（身份目录）+ 签发 ID Token、JWKS 公钥端点、refresh token 超时续期，认证闭环完整                                                                |
| F2 | 钉钉/飞书只能做身份源，没有 IdP 功能 | 扫码登录走 OAuth2 授权码模式，最终发的是 userAccessToken（不透明令牌），唯一用途是调其 OpenAPI（拿 unionId 等）；不对外签发 ID Token、无 JWKS 端点，服务端无法本地验签。除非购买其 IDaaS 商业服务 |
| F3 | 国内企业基本都能提供"身份源"       | 钉钉/飞书多年市场普及，员工身份与在职状态都在其通讯录中                                                                                                     |
| F4 | 发证方（IdP）角色不可能消失       | 只会**集中**（企业统一 IdP，行业叫 IAM/4A/统一认证）或**分散**（每个系统各自对接身份源、自签会话）。云汉不自研发证，发证方放在可配置的认证中心里（见 D2）                                         |

***

## 3. 企业场景两分法与认证中心配置矩阵

### 3.1 场景两分法

云汉平台未来面对的企业场景只有两种：

- **场景 A：客户有 IdP** → 用客户现有 IdP（路径一或路径二，见 4.4）
- **场景 B：客户没有 IdP** → Casdoor 作为云汉的 IdP，与客户现有"身份源"（钉钉/飞书）集成

### 3.2 认证中心配置组合矩阵

| 组合    | 身份源                 | IdP（认证中心）                                                        | 适用场景                | 云汉侧改动   |
| ----- | ------------------- | ---------------------------------------------------------------- | ------------------- | ------- |
| ①     | Supabase auth.users | Supabase Auth                                                    | DEMO / 海外 / SaaS 模式 | 零改动（现状） |
| ②     | 钉钉通讯录               | 自托管 Casdoor                                                      | 国内无 IdP 的钉钉企业       | 配置切换    |
| ③     | 飞书通讯录               | 自托管 Casdoor                                                      | 国内无 IdP 的飞书企业       | 配置切换    |
| ④-路径一 | 客户 IdP 自有           | 客户 IdP（AD FS/Keycloak/Entra ID/Authing 等，标准 OIDC）                | 客户已有 IdP            | 配置切换    |
| ④-路径二 | 客户 IdP 自有           | Supabase Auth 联邦客户 IdP（原生支持 Keycloak/Entra ID/Okta/generic OIDC） | 客户已有 IdP 且接受联邦中间层   | 零改动     |

> 组合①②③为"云汉提供认证中心"的三种标准组合；组合④为"客户已有认证中心"的两种接入路径。同一部署同一时刻只启用一种组合。

### 3.3 决策记录

| #  | 决策                                                                                           | 说明                                                 |
| -- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| D1 | 身份源交给企业 IM（钉钉/飞书）或 Supabase，**身份治理保留 platform\_users**（批量导入 + 现有审批流）                         | 员工用公司 IM 登录，云汉不存密码                                 |
| D2 | **云汉不自研发证**；认证中心可配置（组合①②③ + 客户 IdP 两路径）                                                      | 云汉只做 OIDC 的发起登录（RP）与本地验签（RS），发证方放在认证中心             |
| D3 | **不做细颗粒 aud 门禁**：aud 策略由认证中心配置决定，验签点只校验 iss + exp + sub                                      | 只做"防出体系"，不做细颗粒门禁                                   |
| D4 | **不做权限集中管控**：员工能进哪些 SOR、在各 SOR 的权限，由各 SOR 自控                                                 | 认证中心签发的 JWT 不承担授权职责                                |
| D5 | backend profile 现状**不验任何 token**（内网信任）；将来机器调用直接用认证中心的机器账号（client credentials / service role） | 服务账号 = 机器法人账户；不自研"机器通行证"                           |
| D6 | token 生命周期（有效期/续期/吊销）由认证中心负责                                                                 | Supabase refresh token、Casdoor 过期与轮换均为现成能力，云汉不自研续签 |
| D7 | Supabase 方案保留，用于 DEMO/海外/SaaS 模式                                                             | 组合①零改动长期存在                                         |

***

## 4. 总体架构

### 4.1 目标链路

```
员工端 ──OIDC 授权码+PKCE──→ 认证中心（可配置）
                              │ 组合① Supabase Auth
                              │ 组合②③ Casdoor ──扫码联邦──→ 钉钉/飞书（身份源）
                              │ 组合④ 客户 IdP
                              ↓ 签发 ID Token + JWKS
员工端持 JWT ──→ 本地 webserver ──转发──→ flowable-engine / web-console 后端

三处验签点（员工端 profile / web-console / engine）
按配置的 issuer/JWKS 本地验签：iss + exp + sub
```

### 4.2 分层职责

| 层               | 职责                        | 持有什么                  |
| --------------- | ------------------------- | --------------------- |
| 身份源             | 证明"你是公司员工"（扫码登录/目录）       | 员工的真实身份与在职状态          |
| 认证中心（可配置）       | 验证身份 → 签发 ID Token + JWKS | **签名私钥**（认证中心自有，云汉不碰） |
| platform\_users | 治理：审批、禁用、锁定、角色            | 用户档案（影子目录）            |
| 三处验签点           | 验 JWT 真伪后放行               | 只有公钥（JWKS）            |
| 各 SOR           | 各自的认证与授权                  | 各自的账号体系               |

**架构回报**：认证中心可配置后，换 IM 平台（钉钉→飞书）只是 Casdoor 配置变化；换认证中心（Casdoor→客户 IdP）也只是配置切换——**三处验签点从此不再动**。

### 4.3 组合②③：Casdoor 登录链路

1. 员工端跳转 Casdoor（OIDC 授权码 + PKCE）
2. Casdoor 展示钉钉/飞书扫码页（**原生 provider，云汉不写任何 IM 集成代码**）；钉钉/飞书开放平台登记的回调域名是 Casdoor 的域名（公网固定），员工端 127.0.0.1 无需登记
3. Casdoor 以 code 换 unionId，匹配或自动创建 Casdoor 用户（DingTalk provider 以 unionid 作用户名）
4. Casdoor 签发 ID Token（sub = unionId）+ JWKS 公钥端点
5. 三处验签点按配置验签 → `auth_subject` = sub → 命中 platform\_users 且 active 则放行；未命中首登 JIT 建 `pending_approval` 影子档案（复用现有审批流）

**Casdoor 选型依据**：开源 Go 单二进制（+ 一个 PG/MySQL），可私有化部署进企业内网；原生钉钉/飞书/企业微信 provider 与通讯录 Syncer；对外标准 OIDC/SAML/CAS；中文文档、国内团队背景。备选 Keycloak 因 JVM 全家桶运维重、国内 IM 协议需写 SPI 而不采用。

### 4.4 组合④：客户 IdP 两路径

| 路径  | 做法                                                                                                            | 适用                            |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 路径一 | 客户 IdP 直接作为云汉认证中心：三处验签点 issuer/JWKS 指向客户 IdP；员工端标准 OIDC 授权码+PKCE（loopback redirect 为 RFC 8252 标准做法，主流 IdP 支持） | 客户 IdP 说标准 OIDC，且客户不接受中间联邦层   |
| 路径二 | Supabase Auth 联邦客户 IdP（原生 Keycloak/Entra ID/Okta/generic OIDC provider）；云汉三端与组合①完全一致                          | 客户接受联邦中间层，或客户 IdP 为 SAML-only |

***

## 5. 云汉侧改造清单与配置模型

### 5.1 三处验签点配置化（改动最小化的关键）

验签框架零替换：Java 侧本就是 NimbusJwtDecoder，TS 侧本就是 jose——改的是"issuer/公钥地址从配置读"，不是验签逻辑。

| #  | 改造点                                                                                              | 位置                                                             | 工作量              |
| -- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------- |
| 1  | web-console 后端 issuer 配置化（`JwtDecoders.fromIssuerLocation(properties.jwtIssuer())` 属性位已存在，补参数校验） | `apps/web-console/backend/.../config/SecurityConfig.java`      | 0.5 人日           |
| 2  | flowable-engine 同上                                                                               | `apps/flowable-engine/.../config/SecurityConfig.java`          | 0.5 人日           |
| 3  | expense-sor issuer/JWKS 配置化                                                                      | `apps/expense-ctrl/expense-sor/.../config/SecurityConfig.java` | 0.5 人日           |
| 4  | 员工端 TS 验签 issuer 配置化（createRemoteJWKSet + jwtVerify 参数从配置读）                                      | `packages/enterprise/platform-user-console/src/index.ts`       | 0.5 人日           |
| 5  | JwtAuthConverter 放宽 email 必填（unionId 场景 email 可空）                                                | `apps/web-console/backend/.../security/JwtAuthConverter.java`  | 0.5 人日           |
| 6  | SSO 配置模型：认证中心类型 + issuer/JWKS/clientId 参数，misconfiguration fails loud                            | 企业配置层                                                          | 1 人日             |
| 7  | 员工端登录 UI 增加 OIDC 模式（授权码+PKCE 回环；保留 Supabase 模式）                                                  | `packages/client/ui-enterprise/src/client/EnterpriseUi.tsx`    | 2\~3 人日          |
| 8  | Casdoor 部署与钉钉/飞书 provider 配置手册（含 IM 开放平台应用登记指引）                                                  | `docs/plans/`                                                  | 1 人日             |
| 9  | auth\_subject 值域兼容与行为测试/快照                                                                       | 测试                                                             | 2\~3 人日          |
| 合计 | <br />                                                                                           | <br />                                                         | **8.5\~10.5 人日** |

### 5.2 SSO 配置模型（契约示意，字段名实施时定）

```yaml
sso:
  provider: supabase | casdoor | customer-oidc   # 认证中心三选一，misconfiguration 在加载期报错
  issuer: https://...                            # 必填：认证中心 issuer
  jwksUrl: https://.../.well-known/jwks.json     # 可选：缺省按 OIDC 发现从 issuer 推导
  clientId: ...                                  # 员工端 RP 注册的 client id
  scopes: openid profile                         # 缺省即可
```

***

## 6. 治理与数据

### 6.1 platform\_users 治理职能保持不变

| 治理动作  | 现状机制                       | 变化                             |
| ----- | -------------------------- | ------------------------------ |
| 批量导入  | 管理员导入员工名册                  | 不变；auth\_subject 改存当前认证中心的 sub |
| 开户审批  | pending\_approval → active | 不变；未导入员工首登只建待审批影子档案（关闭自注册）     |
| 禁用/锁定 | status 四态                  | 不变；禁用后认证中心侧拒绝续期/登录             |
| 角色管理  | platformRoles 三角色          | 不变                             |

### 6.2 auth\_subject 语义与值域

- 该字段本就设计为抽象关联键，语义从"Supabase sub"泛化为"**当前认证中心签发 JWT 的 sub**"——数据口径调整而非结构变更。
- 值域：组合① = Supabase UUID；组合②③ = 钉钉/飞书 unionId；组合④ = 客户 IdP sub。同一部署同一时刻只有一种值域。
- **中途切换认证中心**的存量用户迁移：提供一次性映射迁移脚本（旧 sub → 新 sub）；过渡期验签点可双 issuer 并存（见第 8 节回归要点）。

### 6.3 入离转（JML）联动

- **入职**：IM 平台/客户目录建号 → 名册导入 platform\_users（active 或走审批）→ 登录可用
- **转岗**：IM 部门变化 → 定时同步或 webhook → org positions 更新 → DMN 组织审批路由自动生效（该链路已落地）
- **离职**：IM 删号/禁用 → 登录/续期失败自然失效 + platform\_users 置 disabled → 对应表服务级联失效（见第 7 节）

***

## 7. SOR 门禁对应表服务（设计概要）

> **定位**：把认证中心签发的 JWT 与各 SOR 系统的账号"翻译"起来——员工凭 JWT 进门，对应表告诉他"在这个系统里你叫什么"。**铁律**：只存身份映射、**不存凭据**（密码/密钥）。**凭据保管库**（加密存储密码/密钥的组件，唯一用途是"完全封闭 SOR"的密码代持兜底，见 7.2 入口 4）只在遇到完全封闭的 SOR 时按需另建，且应随 SOR 升级趋向清空。

### 7.1 一个关键前提：映射怎么设计，取决于企业内部 SSO 方案

企业内部存在一套自己的 SSO 体系（**不是**钉钉/飞书——IM 只承担"扫码证明你是谁"这一步）。SOR 系统历史上大多已经接入了这套内部 SSO 或它的前身（AD/LDAP 域账号）。因此对应表的映射模式**不能现在拍死**，必须等企业内部 SSO 方案明确后按情形选型：

| 情形               | 企业内部 SSO 的形态                 | 对应表映射模式                                    | 工作量      |
| ---------------- | ---------------------------- | ------------------------------------------ | -------- |
| ① SOR 已联邦到内部 SSO | 标准 IdP（OIDC/SAML），SOR 直接认它的票 | 认证中心账号 ↔ 内部 SSO 账号做**同名/ID 链式映射**，SOR 侧零改动 | 小        |
| ② 内部 SSO = 统一目录  | AD/LDAP，SOR 用域账号登录           | 同名映射（`云汉账号 = 域账号`），对应表退化为一张同名对照            | 小        |
| ③ 无统一体系          | 各 SOR 自有账号                   | 逐 SOR 摸底身份入口后逐个映射（见 7.2 摸底矩阵）              | 中\~大，逐个来 |

> 设计含义：**对应表服务先建"骨架"（登记表 + 映射表 + JML 联动），映射策略做成可插拔**——骨架不依赖企业 SSO 方案，策略插件等方案明确后逐个填充。

### 7.2 SOR 登记表（sor\_registry）——摸底结果的载体

每个接入的 SOR 登记一行，其中"身份入口类型"是最值钱的字段：

| 字段                  | 说明                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `sorName`           | SOR 名称                                                                                                                             |
| `identityEntryType` | **身份入口类型**：`ldap-domain`（LDAP/AD 域账号）/ `trusted-header`（可信代理头）/ `api-operator`（API 操作人字段）/ `closed`（完全封闭）/ `federated`（已联邦到内部 SSO） |
| `mappingStrategy`   | 映射策略：同名 / 显式对照表 / 待摸底                                                                                                              |
| `probeEndpoint`     | 连通性探测地址（复用现有 probeConnectivity 实现）                                                                                                 |
| `ownerContact`      | SOR 责任人                                                                                                                            |

**摸底结论（已达成共识）**：历史 SOR 的认证与授权是焊死的（谁登录按谁的权限办事），改造 SOR 来适配方案不现实——方案必须绕着"它有什么现成入口"来设计。四个入口按侵入度从低到高：

1. **LDAP/AD 域账号集成**（老系统极常见，改配置即接）
2. **可信代理头注入**（部署在反向代理后的系统，改配置）
3. **API 操作人字段**（ERP 类开放接口常带 operator/userId 参数，纯调用）
4. **完全封闭**（三选一：服务账号直连且审计落机器账号 / 密码代持兜底——密码存凭据保管库 / 推动厂商改造）

### 7.3 映射表（federated\_identities）

```
platform_user_id  ↔  sor_id（哪个 SOR）  ↔  sor_user_id（在那边的账号）
                        + status + 同步时间戳
```

- **自动建**：SOR 登记后，按映射策略批量初始化（同名策略直接生成；显式对照走导入模板）
- **自动改**：IM 转岗 webhook → platform\_users/org positions 更新 → 受影响的映射行联动更新
- **自动删（失效）**：IM 离职 → platform\_users 置 disabled → 该员工全部映射行置停 + 通知各 SOR 管理员
- **只存 ID**：即使 `closed` 类 SOR，映射表也只存账号名的对应关系；密码属凭据保管库职责，永不进入本表

### 7.4 人的使用与机器调用的分野（已达成共识）

| 场景                     | 通行方式                                                     | 审计落点                                  |
| ---------------------- | -------------------------------------------------------- | ------------------------------------- |
| 员工交互使用 SOR             | 必须落到个人身份（走入口 ①②③）；真封闭才密码代持                               | 个人                                    |
| AI/backend task 调用 SOR | 认证中心机器账号（client credentials / service role，见 D5），不需要代办声明 | "云汉平台"机器账号——语义本来就成立，与老 SOR"认证授权一致"不冲突 |

***

## 8. 实施步骤

| 阶段 | 内容                                                                                       | 前置条件                          |
| -- | ---------------------------------------------------------------------------------------- | ----------------------------- |
| S1 | Casdoor PoC：部署 + 钉钉 provider 扫码登录全链路打通（验证 sub = unionId 落到 auth\_subject）                | 企业在钉钉开放平台建自建应用                |
| S2 | 三处验签点 issuer 配置化（web-console / engine / expense-sor / 员工端 TS）+ JwtAuthConverter 放宽 email | —                             |
| S3 | SSO 配置模型（provider 三选一 + 参数校验 fails loud）                                                 | S2                            |
| S4 | 员工端登录 UI OIDC 模式（授权码+PKCE 回环；Supabase 模式保留为组合①）                                          | S1/S3                         |
| S5 | 飞书 provider 验证（照抄钉钉链路）                                                                   | S1                            |
| S6 | auth\_subject 值域口径 + 行为测试/快照 + 部署手册                                                      | S2\~S4                        |

***

## 9. 风险与开放问题

| #  | 事项                                                | 状态/缓解                                          |
| -- | ------------------------------------------------- | ---------------------------------------------- |
| R1 | Casdoor 是新引入的运维件（升级/备份/可用性归企业 IT 或云汉交付）           | 缓解：单二进制轻量；部署手册给出 SLA 期望与备份要点                   |
| R2 | auth\_subject 值域差异（UUID / unionId / 客户 sub）       | 值域由部署配置决定且互斥；切换认证中心时提供一次性映射迁移脚本；过渡期双 issuer 并存 |
| R3 | 钉钉/飞书开放平台需企业侧建自建应用并登记回调域（Casdoor 域名）              | 一次性配置，写入部署手册（组合④不涉及）                           |
| R4 | 双认证中心过渡期的配置漂移                                     | 缓解：过渡期设截止日期，回归后移除旧 issuer 配置                   |
| R5 | 路径一要求客户 IdP 说标准 OIDC；SAML-only 客户不被覆盖             | 走路径二（Supabase 联邦）或将来加协议转换层；销售侧提前摸底             |
| R6 | KB Storage 仍耦合 Supabase（anon key + RLS），与认证中心切换无关 | 独立迁移项，不在本方案范围                                  |
