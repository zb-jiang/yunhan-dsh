# Supabase 配置手册:企业级应用平台

## 1. 创建 Supabase 项目

1. 访问 <https://supabase.com>,注册或登录
2. 点击 **New Project**,填写项目名称(如 `dsh-enterprise`)
3. 设置数据库密码,选择区域(建议选离用户最近的区域)
4. 等待项目初始化完成(约 2 分钟)

## 2. 获取项目凭据

进入 **Project Settings → API**,记录以下信息:

| 凭据        | 字段名     | 获取方式                                                                                                       |
| --------- | ------- | -------------------------------------------------------------------------------------------------------- |
| Project URL | `url`   | 页面顶部完整地址,形如 `https://<project-ref>.supabase.co`(`.co` 结尾;`<project-ref>` 是约 20 位随机字母数字 ID) |
| anon key  | `anonKey` | **Project API keys** 区域 `anon` / `public` 行,点 **Reveal** 复制;前端直连 Supabase Auth(注册/登录)需要此 key            |

### 2.1 JWT 验证

后端自动通过 JWKS 公钥验证 Supabase JWT,无需获取或配置 JWT Secret。各组件配置中的 `jwt-issuer` 填 `${SUPABASE_URL}/auth/v1`。

## 3. 配置 Supabase Auth

### 3.1 认证提供方配置

进入 **Authentication → Providers**,按需启用:

| 提供方    | 配置项                            |
| ------ | ------------------------------ |
| Email  | 默认启用,可配置确认邮件模板                 |
| GitHub | OAuth App 的 Client ID / Secret |
| Google | OAuth 2.0 Client ID / Secret   |

### 3.2 关闭公开注册(可选)

如果只允许管理员创建用户,进入 **Authentication → Settings**:

- 关闭 **Allow new users to sign up**
- 改为管理员在 Supabase Dashboard 手动创建用户(**Authentication -> Users -> Add user**)

## 5. 环境变量

管理员需要配置的 Supabase 环境变量:

| 变量                  | 值              |
| ------------------- | -------------- |
| `SUPABASE_URL`      | 第 2 节的 Project URL |
| `SUPABASE_ANON_KEY` | 第 2 节的 anon key    |

- `SUPABASE_URL` 用作各组件的 JWT issuer(`${SUPABASE_URL}/auth/v1`);`SUPABASE_ANON_KEY` 用作 Auth 登录。知识库文档存本地文件系统,不再使用 Supabase Storage。
- 数据库连接三变量 `SUPABASE_DB_HOST` / `SUPABASE_DB_USER` / `SUPABASE_DB_PASSWORD` 变量名沿用历史命名,现指向本地 PostgreSQL(`SUPABASE_DB_HOST` 填 `localhost`),配置方法见 `docs/plans/2026-09-21-local-pg-setup-guide.md`。
