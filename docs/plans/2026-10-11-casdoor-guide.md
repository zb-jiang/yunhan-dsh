# Casdoor 部署手册

## 1. 本地 PG 建 casdoor 库

> casdoor 库已建好并在源码构建版中原样沿用（组织、用户、provider、应用全部保留），本节仅新环境重建时需要。

与 web-console、flowable-engine、New API 共用同一个本地 PG 实例，按 New API 同样的隔离思路给 Casdoor 单独建一个库。用安装 PG 时为 `postgres` 超级用户设置的密码（即 `SUPABASE_DB_PASSWORD`）连接：

```powershell
psql -U postgres -c "CREATE DATABASE casdoor;"
psql -U postgres -c "SELECT datname FROM pg_database WHERE datname = 'casdoor';"
```

✅ 检查点：第二条命令打印出 `casdoor`。

## 2. Casdoor 源码

Casdoor v4.20.0 源码在 `D:\works\casdoor-4.20.0`，含唯一一处定制——`idp/dingtalk.go` 把 provider 返回的用户锚点由 openId 改为 unionId（`Id: dtUserInfo.UnionId`），使 `sub` = unionId（定案落地，见 8.5）。

前后端构建与启动全部按 [BUILD-RUN.md](file:///D:/works/casdoor-4.20.0/BUILD-RUN.md) 执行：装 Go ≥ 1.25.8 与 yarn → `yarn build` 产出 `web\build` → `go build` 产出 `casdoor.exe`。`D:\casdoor` 官方 zip 部署目录已弃用（源码版稳定后可删除）。

✅ 检查点：`D:\works\casdoor-4.20.0\casdoor.exe` 与 `D:\works\casdoor-4.20.0\web\build\index.html` 均存在。

## 3. 启动内网穿透，拿公网域名

推荐 cpolar（免费版可用，输出 http/https 双 URL，本 PoC 用 http，与 `origin` 协议保持一致）：

1. 注册：<https://www.cpolar.com>，注册免费账号。
2. 下载 Windows 客户端并安装。
3. 绑定 authtoken（cpolar 控制台 → 验证 页复制）：
   ```powershell
   cpolar authtoken <你的authtoken>
   ```
4. 建立隧道（保持窗口开着，关掉隧道即断）：
   ```powershell
   cpolar http 8000
   ```
5. 输出里有 http/https 两条 URL，记下 http 域名即可（域名随 cpolar 重启会变，用哪个都行，后续配置保持一致），形如：
   ```
   http://xxxxxxxx.r6.cpolar.top -> http://localhost:8000
   ```

> ⚠️ **免费隧道域名会变**：cpolar 重启后随机子域名会更换。域名一旦变化，必须同步更新三处——① 钉钉回调域登记（第 6.4 步）；② `app.conf` 的 `origin`（第 4 步，改完重启 Casdoor）；③ 浏览器访问地址。PoC 期间隧道窗口尽量别关。
>
> 用 natapp 等价：`natapp -authtoken=<token>`；免费隧道同样域名随机、同样注意同步。

✅ 检查点：记下隧道域名（此时浏览器打开它还是打不开的，Casdoor 尚未启动，正常）。

## 4. 配置 conf/app.conf（已配好）

两个要点：

1. `dbName` 要写两处：`dataSourceName` 里的 `dbname=casdoor` 和顶层的 `dbName = casdoor` 都不能少，只写一处会导致建表/连库异常。
2. 隧道域名变化时：改 `origin` → 重启 casdoor.exe，并同步钉钉侧回调域登记（6.4）。

✅ 检查点：`origin` 与当前隧道域名逐字符一致（含协议）。

## 5. 启动 Casdoor

```powershell
cd D:\works\casdoor-4.20.0
.\casdoor.exe
```

**必须在源码树根目录启动**：前端按工作目录相对路径 `web/build` 解析，换了目录会 404。日志写入 `D:\works\casdoor-4.20.0\logs\casdoor.log`。

数据库沿用旧库：组织、用户、钉钉 provider、应用、管理员账号全部保留，无需重建。浏览器打开 <http://localhost:8000>，用既有管理员账号登录。

✅ 检查点：<http://localhost:8000> 能登录管理界面；浏览器打开隧道 http 域名也能看到同一个登录页（隧道通了）。

## 6. 钉钉开放平台创建自建应用

> 钉钉自建应用已建好（`DSH-SSO-PoC`），凭据已登记到 Casdoor provider，本节仅新环境重建时需要。

登录钉钉开发者后台：<https://open-dev.dingtalk.com>（用企业钉钉管理员或有开发者权限的账号扫码登录）。

### 6.1 创建应用

应用开发 → 创建应用，类型选**企业内部应用（自建应用）**，名称如 `DSH-SSO-PoC`，描述随意。

### 6.2 拿凭据

应用详情 → **凭据与基础信息**，记下：

- **Client ID**（旧称 AppKey）
- **Client Secret**（旧称 AppSecret，点"查看"复制）

这就是下一步 Casdoor provider 要填的两个值。

### 6.3 开通权限

应用详情 → **权限管理**，搜索 `Contact.User.Read`（通讯录个人信息读权限）→ 申请开通。

必须开通：Casdoor 拿 code 换 token 后要调钉钉 `/v1.0/contact/users/me` 取 unionId，缺这个权限扫码后登录会失败。

### 6.4 登记回调域

应用详情 → **开发配置 → 安全设置 → 重定向URL（回调域名）**，新增：

```
http://<隧道域名>/api/callback/dingtalk
```

（如果界面限制只能填域名级，就填 `http://<隧道域名>`。协议必须与 `origin` 一致——实测用 http。）

钉钉校验规则：授权请求的 redirect\_uri 必须与登记一致，否则报\*\*"无权限访问"\*\*。Casdoor 发起的钉钉回调地址 = `<origin>/api/callback/dingtalk`，所以登记内容必须与 `app.conf` 的 `origin` 对上。

✅ 检查点：三样东西到手——钉钉 Client ID、钉钉 Client Secret、回调域已登记（与隧道域名一致）。

## 7. Casdoor 配置钉钉 Provider 与应用

> 组织 / Provider / 应用均已建好并随旧库沿用，本节仅新环境重建时需要。

用管理员登录 Casdoor（走隧道域名或 localhost 均可，下同）。

### 7.1 建组织

Casdoor 里组织、Provider、应用三者必须同属一个组织：后端按应用所属组织解析 Provider（挂错组织，登录页直接看不到第三方图标）；源码又硬编码禁止 built-in 组织下的自动注册。所以先建组织：

**Organizations → Add** 新建：

| 字段   | 值         |
| ---- | --------- |
| Name | `dsh`（随意） |

保存后回到组织列表确认已出现。其余字段保持默认。

### 7.2 建 Provider

**Authorization → Providers → Add**：

| 字段            | 值                                  |
| ------------- | ---------------------------------- |
| Name          | `dingtalk`（随意）                     |
| Organization  | `dsh`（第 7.1 步刚建的，**不能选 built-in**） |
| Category      | `OAuth`                            |
| Type          | `DingTalk`                         |
| Client ID     | 钉钉的 Client ID（第 6.2 步）             |
| Client Secret | 钉钉的 Client Secret                  |

保存后回到编辑页，页面会显示 **Callback URL**（形如 `http://<隧道域名>/api/callback/dingtalk`）。**逐字符核对**它与钉钉登记的回调域一致——不一致说明 `app.conf` 的 `origin` 没配对，改完必须重启 casdoor.exe。

### 7.3 建应用

**Applications → Add** 新建：

| 字段            | 值                                                                |
| ------------- | ---------------------------------------------------------------- |
| Name          | `dsh-poc`                                                        |
| Organization  | `dsh`（第 7.1 步刚建的，**不能选 built-in**）                               |
| Providers     | 勾选 `dingtalk`                                                    |
| Redirect URLs | `http://localhost:8080/callback`（第 8 步 RP stub 回跳；生产环境配置清单见 7.4） |

**开「启用注册」开关**（钉钉扫码自动建账户的必要条件）：应用编辑页切到 **Authentication（认证）** 页签，打开 **Enable signup（启用注册）** 开关，保存。

> 打开该开关后 Providers 页签会多出 **Can signup（可用于注册）** 列——钉钉行的开关默认就是开的，确认一下即可。

保存后进入编辑页，记下这个应用自己的 **Client ID / Client Secret**（注意：是 Casdoor 应用的，不是钉钉的）。

✅ 检查点：组织 / Provider / 应用三者都挂在 dsh 下（非 built-in）；Authentication 页签「启用注册」已打开；应用 Providers 列表里有 dingtalk（Category 列显示 OAuth，不为空）；Redirect URLs 已填。

### 7.4 生产环境 Redirect URLs 配置清单

PoC 阶段只需 RP stub 一条（7.3 表格）；生产环境按员工端访问形态在应用的 Redirect URLs 里登记以下条目。Casdoor 对 Redirect URLs 逐字符精确匹配（协议 / 端口 / 路径都必须一致），漏登记的形态登录会被直接拒绝。

| # | Redirect URL                                              | 覆盖场景                                                                                                                 |
| - | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1 | `http://127.0.0.1:3080/api/enterprise/auth/oidc/callback` | 员工端桌面 App：Electron 形态本机 webserver 恒监听 127.0.0.1:3080，全公司 redirect\_uri 是同一条字符串，与员工电脑实际 IP 无关                         |
| 2 | `http://localhost:3080/api/enterprise/auth/oidc/callback` | 员工端本机浏览器访问；`localhost` 与 `127.0.0.1` 是两个 origin，必须各登记一条                                                              |
| 3 | `http://<web-console 基地址>/api/auth/dsh-relay/callback`    | Pocket Access 手机端登录：redirect\_uri 恒指向 web-console 的 relay 中转回调（中转基地址即员工端 `oidcRelayUrl` 配置，取 `WEB_CONSOLE_URL` 环境变量） |
| 4 | `http://<web-console 基地址>/`                               | web-console 管理面自身登录；与员工端共用同一 client 时 redirect\_uri 各自登记（ `http://localhost:8080/` ）                                 |

- **手机端为什么只需一条**：手机经局域网 / 隧道访问员工端 DSH，回调地址随设备与隧道变化、无法枚举；启用 relay 后 Casdoor 只看到 web-console 的固定地址，web-console 按 state 登记表 302 转回员工端（state 一物两用，5 分钟有效、一次性消费）。
- **relay 的两处配套**：web-console 库执行 `oauth_relay_sessions` 建表 SQL（《本地 PostgreSQL 配置手册》§3.8）；员工端配置 `oidcRelayUrl`（enterprise-app patch 从 `WEB_CONSOLE_URL` 注入，不配则 relay 不生效）。未配置 relay 时手机端登录退回根路径回调，该地址无法枚举，Casdoor 会以 redirect\_uri 不在白名单拒绝。
- **本机联调注意**：真机测 relay 时 `WEB_CONSOLE_URL` 不能填 `127.0.0.1:8080`——手机浏览器里的 127.0.0.1 指手机自身；改填开发机的局域网 IP 并把第 3 条同步登记为该 IP 形态。生产环境 web-console 在服务器上，天然满足。

✅ 检查点：四条 URL 与各部署形态的基地址逐字符一致；web-console 基地址一旦变化，第 3、4 条与员工端 `WEB_CONSOLE_URL` 同步更新。

## 8. PoC 全链路验证

### 8.1 起 RP stub（假装的"员工端"）

开一个新终端，在任意空目录：

```powershell
D:\miniconda3\python.exe -m http.server 8080
```

它把收到的每个请求（含 query）打印到终端，我们靠它截获回跳的 code。浏览器看到 404 属正常，不用管。

### 8.2 发起 OIDC 登录

```
http://<隧道域名>/login/oauth/authorize?client_id=<Casdoor应用ClientID>&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&scope=openid&state=abc123
```

登录页上点**钉钉图标** → 手机钉钉 App 扫码 → 确认登录 → 回跳 Casdoor → Casdoor 302 到 `http://localhost:8080/callback?code=...&state=abc123`。

回跳后浏览器会显示 python 的 **404 "Error response"** 页——**看到它就是成功**（stub 只收码不响应，见 8.1），code 已打印在 stub 终端，接着做 8.3。

### 8.3 截获 code

从 python stub 终端复制 `code=...` 的值。

> code 是一次性且短时效的——拿到后立刻做 8.4；过期或已用过就重走 8.2 换新 code。

### 8.4 用 code 换 token

```powershell
$resp = Invoke-RestMethod -Method Post -Uri "http://<隧道域名>/api/login/oauth/access_token" -Body @{
  grant_type    = "authorization_code"
  client_id     = "<Casdoor应用ClientID>"
  client_secret = "<Casdoor应用ClientSecret>"
  code          = "<8.3 的 code>"
  redirect_uri  = "http://localhost:8080/callback"
}
$resp.id_token
```

返回 JSON 应包含 `access_token` / `id_token` / `token_type` 等字段。

### 8.5 解码 ID Token，验证 sub

```powershell
node -e "const t=process.argv[1];const p=JSON.parse(Buffer.from(t.split('.')[1],'base64url').toString('utf8'));console.log(JSON.stringify(p,null,2))" "<8.4 的 id_token>"
```

✅ 检查点（**S1 验收标准**）：

- 打印的 payload 里 **`sub`** **== 该钉钉账号的 unionId**（`name` / `preferred_username` 也应为 unionid）；
- Casdoor 管理界面 **Users** 列表出现自动创建的用户（用户 Id = unionId，`dingtalk` 列 = unionId）。

### 8.6 登记 S2 验签需要的三个参数

浏览器打开 OIDC 发现文档并记录（S2 三处验签点配置化直接使用）：

```
http://<隧道域名>/.well-known/openid-configuration
```

| 参数                                         | 记录值                                      |
| ------------------------------------------ | ---------------------------------------- |
| issuer                                     | 以文档为准，应等于隧道域名                            |
| jwks\_uri                                  | 形如 `http://<隧道域名>/.well-known/jwks.json` |
| id\_token\_signing\_alg\_values\_supported | 应为 RS256 系                               |

> PoC 的 issuer 是隧道域名；企业部署时 Casdoor 换固定域名，issuer 随之变化——S2 之后 issuer 本来就是配置项，不受影响。

## 附录 A：飞书 provider 差异（S5 时按此骨架补全）

- 飞书开放平台（<https://open.feishu.cn>）建**企业自建应用**，拿 App ID / App Secret；
- 安全设置登记重定向 URL（同 6.4 位置）；
- Casdoor Provider Type=Feishu（S5 时确认所用 Casdoor 版本对飞书 OAuth 的支持形态）；
- 权限：union\_id 默认随 authen 响应返回，无需额外申请；user\_id 需自建应用开「获取用户 user ID」字段权限；
- sub 映射：飞书三 ID 与钉钉同构（open\_id=应用内唯一、union\_id=同一开发商内唯一、user\_id=租户内唯一），S1 的 sub 定案结论可直接平移。

> **结论**：Casdoor 对飞书与钉钉同款设计——`idp/lark.go` 中 `Id = OpenId`，sub=unionId 的 fork 位置同样是 `idp/lark.go` 改一行 `Id: ...UnionId`（与源码树钉钉定制同构）。飞书特有差异：OAuth 流内即可拿到 user\_id（钉钉 OAuth 流拿不到 userid），但仅自建应用可得，且被删除用户的 user\_id 可能被后续新增用户占用——user\_id 在飞书语境下更不可靠。
