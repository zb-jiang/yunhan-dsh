# 本地 PostgreSQL 配置手册:企业级应用平台

## 1. 安装 PostgreSQL(Windows)

1. 下载 PostgreSQL 17 或更高版本的 Windows 安装包:<https://www.postgresql.org/download/windows/>(EDB 安装器)
2. 运行安装器,组件保持默认;安装过程中为超级用户 `postgres` 设置密码并记住(后续填入 `SUPABASE_DB_PASSWORD`);端口保持默认 `5432`
3. 验证 psql 可用:安装器默认不把 psql 加入 PATH,用开始菜单的 **SQL Shell (psql)**,或把安装目录的 `bin` 子目录(如 `D:\Program Files\PostgreSQL\18\bin`)加入 PATH 后打开新终端执行:

```powershell
psql -U postgres -c "SELECT version();"
```

能打印版本号即安装成功。

## 2. 建库与用户

### 2.1 通用数据库与用户

- 使用安装时自带的 `postgres` 数据库,无需新建数据库(服务端 Spring 配置连接 `jdbc:postgresql://<host>:5432/postgres`)。
- 用户默认用超级用户 `postgres`(与 `SUPABASE_DB_USER=postgres` 对齐),权限满足建表与 Flowable 自动建表。
- 如需专用用户,用 psql 连接本地实例执行:

```sql
CREATE ROLE dsh_app LOGIN PASSWORD '<密码>';
GRANT CONNECT ON DATABASE postgres TO dsh_app;
-- 允许创建 §3.0 的 flowable schema
GRANT CREATE ON DATABASE postgres TO dsh_app;
-- PostgreSQL 15+ 的 public schema 默认不放行 CREATE,需显式授权
GRANT USAGE, CREATE ON SCHEMA public TO dsh_app;
```

- 专用用户建好后,第 3 节的建表 SQL 与两个服务都以该用户执行(表归其所有,无需再授权)。
- 若建表 SQL 已用 `postgres` 执行、服务改用专用用户,再补执行:

```sql
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO dsh_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO dsh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO dsh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO dsh_app;
```

### 2.2 New API 专用数据库与用户

New API(企业统一 LLM 网关)和 `web-console`、`flowable-engine` 可以共用同一个 PostgreSQL 实例,但建议使用**独立数据库 + 独立账号**。业务含义很简单:

- `postgres` 库继续承载 `web-console` 和 `flowable-engine` 的业务表。
- New API 自己的用户、渠道、令牌、调用日志等内部表单独放到 `newapi` 库。
- 这样既复用一套 PostgreSQL 实例,又能把 New API 内部表和业务表隔离开,后续排障、迁移、备份都更清晰。

用 `postgres` 超级用户连接实例后执行:

```sql
-- New API 专用登录用户
CREATE ROLE newapi_user LOGIN PASSWORD '<New API 数据库密码>';

-- New API 专用数据库;owner 直接设为 newapi_user,后续 New API 自动建表不需要额外授权
CREATE DATABASE newapi OWNER newapi_user;
```

创建完成后,建议再验证一下连接:

```powershell
psql -h localhost -U newapi_user -d newapi -c "SELECT current_database(), current_user;"
```

如果返回 `newapi` 和 `newapi_user`,说明 New API 的数据库与账号已经准备好。

New API 运行时使用的连接串通过环境变量 `SQL_DSN` 提供,格式如下:

```env
SQL_DSN=postgresql://newapi_user:<New API 数据库密码>@<host>:5432/newapi
```

注意:
- 第 3 节的建表 SQL 全部执行在 `postgres` 业务库中,不要切到 `newapi` 库执行。
- `newapi` 库不需要手工执行本手册里的业务 DDL;New API 首次启动后会通过 GORM auto-migrate 在自己的数据库里自动创建所需表结构。

## 3. 执行全量建表 SQL

用 psql(或 pgAdmin)连接本地实例,对 `postgres` 库按 3.0 → 3.7 顺序执行以下 SQL。

### 3.0 建 flowable schema

```sql
-- Flowable ACT_* 表的专用 schema;引擎只在 schema 内建表,不自动建 schema
CREATE SCHEMA IF NOT EXISTS flowable;
```

### 3.1 平台用户治理表

```sql
-- 平台用户治理表
CREATE TABLE public.platform_users (
    -- 主键,UUID,默认自动生成
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 认证主体标识,对应 Supabase Auth 的 user.id
    auth_subject TEXT NOT NULL,

    -- 平台登录名,唯一
    login_name TEXT NOT NULL,

    -- 显示名称
    display_name TEXT NOT NULL,

    -- 邮箱,唯一;可空(认证中心不下发 email 时存 NULL,如钉钉 unionId 登录;
    -- PG 的 UNIQUE 约束允许多个 NULL)
    email TEXT,

    -- 用户状态:pending_approval / active / disabled / locked
    status TEXT NOT NULL DEFAULT 'pending_approval'
        CHECK (status IN ('pending_approval', 'active', 'disabled', 'locked')),

    -- 平台角色数组:system_admin / app_admin / normal_user
    platform_roles TEXT[] NOT NULL DEFAULT '{}',

    -- 创建记录
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,

    -- 审批记录
    approved_at TIMESTAMPTZ,
    approved_by UUID,

    -- 禁用记录
    disabled_at TIMESTAMPTZ,
    disabled_by UUID,
    disabled_reason TEXT,

    -- 锁定记录
    locked_at TIMESTAMPTZ,
    locked_by UUID,
    locked_reason TEXT
);

-- 唯一约束
ALTER TABLE public.platform_users
    ADD CONSTRAINT uq_platform_users_auth_subject
    UNIQUE (auth_subject);

ALTER TABLE public.platform_users
    ADD CONSTRAINT uq_platform_users_login_name
    UNIQUE (login_name);

ALTER TABLE public.platform_users
    ADD CONSTRAINT uq_platform_users_email
    UNIQUE (email);

-- 查询索引
CREATE INDEX idx_platform_users_status ON public.platform_users (status);
CREATE INDEX idx_platform_users_platform_roles ON public.platform_users USING GIN (platform_roles);

-- 审计日志表
CREATE TABLE public.audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    target_user_id UUID,
    operator_id UUID,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_created_at ON public.audit_events (created_at DESC);
CREATE INDEX idx_audit_events_target_user_id ON public.audit_events (target_user_id);
```

### 3.2 企业治理元数据表

```sql
-- 应用表
CREATE TABLE public.applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    -- 图标 base64 数据 URL(可空;Web Console 后端未传时自动填充默认图标)
    icon TEXT,
    -- 状态:draft / active / suspended / archived(archived 为终态)
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'suspended', 'archived')),
    -- 应用管理员列表,引用 platform_users.id,至少一个
    app_admin_user_ids UUID[] NOT NULL DEFAULT '{}',
    -- SkillHub 命名空间;应用下流程的 skillRefs 仅可引用该命名空间下已发布 skill
    skillhub_namespace TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    archived_at TIMESTAMPTZ,
    archived_by UUID
);

COMMENT ON COLUMN public.applications.skillhub_namespace IS 'SkillHub 命名空间;应用下流程的 skillRefs 仅可引用该命名空间下已发布 skill';

CREATE INDEX idx_applications_status ON public.applications (status);

-- 应用角色表
-- parent_role_id 指向父角色,上级继承下级权限并可处理下级待办
CREATE TABLE public.app_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.applications(id),
    -- 应用内角色名唯一
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    -- 父角色 id,nullable 表示顶级角色;上级继承下级权限
    -- 必须指向同一应用内的角色(应用层校验 app_id 一致);不允许循环引用(应用层校验)
    parent_role_id UUID REFERENCES public.app_roles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    UNIQUE (app_id, name),
    -- 防止自引用
    CHECK (parent_role_id IS NULL OR parent_role_id <> id)
);

CREATE INDEX idx_app_roles_app_id ON public.app_roles (app_id);
CREATE INDEX idx_app_roles_parent ON public.app_roles (parent_role_id);

-- 应用成员表
CREATE TABLE public.app_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.applications(id),
    user_id UUID NOT NULL REFERENCES public.platform_users(id),
    -- 绑定的角色 id 数组,引用 app_roles.id,应用层校验完整性
    role_ids UUID[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by UUID,
    -- 同一用户同一应用只有一条有效记录
    UNIQUE (app_id, user_id)
);

CREATE INDEX idx_app_memberships_app_id ON public.app_memberships (app_id);
CREATE INDEX idx_app_memberships_user_id ON public.app_memberships (user_id);

-- 流程定义表
CREATE TABLE public.workflow_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.applications(id),
    name TEXT NOT NULL,
    description TEXT,
    -- 状态:draft(草稿编辑) / published(已发布到 Flowable) / disabled(停用) / archived(归档,终态)
    -- disabled 和 archived 都不允许新实例启动
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'published', 'disabled', 'archived')),
    -- 草稿 BPMN XML(未发布时在 Web Console 编辑;发布后可保留作回退参考)
    draft_bpmn_xml TEXT,
    -- 发布后指向 Flowable 的 deployment 与 procdef ID
    published_deployment_id VARCHAR(64),
    published_procdef_id VARCHAR(64),
    -- BPMN 流程定义 key
    bpmn_process_key TEXT,
    -- 发布版 BPMN XML 快照:发布成功时写入,skill 归属聚合只认这份(不解析草稿)
    published_bpmn_xml TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ,
    updated_by UUID
);

CREATE INDEX idx_workflow_definitions_app_id ON public.workflow_definitions (app_id);
CREATE INDEX idx_workflow_definitions_status ON public.workflow_definitions (status);
```

### 3.3 知识库表

```sql
-- ============================================================
-- 表1 knowledge_bases:知识库登记表。一个应用有且只有一个知识库。
-- ============================================================
create table if not exists public.knowledge_bases (
  id             uuid primary key default gen_random_uuid(),  -- 知识库 id
  application_id uuid not null unique references public.applications(id) on delete cascade,
                 -- 所属应用;unique 保证一应用一库;应用删除时级联删掉知识库
  name           text not null,        -- 显示名(web-console 后端自动取「{应用名} 知识库」)
  storage_bucket text not null,        -- Storage 桶名;全部知识库共用公共桶 'kb-documents'(Supabase 侧一次性手工预建),应用间以对象路径 {appId}/ 段隔离
  created_at     timestamptz not null default now()
);

-- ============================================================
-- 表2 kb_folders:文件夹。树形结构靠 parent_id 自引用,支持多级目录。
-- ============================================================
create table if not exists public.kb_folders (
  id         uuid primary key default gen_random_uuid(),  -- 文件夹 id
  kb_id      uuid not null references public.knowledge_bases(id) on delete cascade,
             -- 所属知识库
  parent_id  uuid references public.kb_folders(id) on delete cascade,
             -- 父文件夹 id;为 NULL 表示顶层(根)文件夹;删父文件夹会级联删子文件夹
  name       text not null,        -- 文件夹名(同级不能重名,见下方唯一索引)
  path       text not null,        -- 物化路径:根下的文件夹是 '/财务',它的子级是 '/财务/报销';
             -- 把整条祖先链冗余存一份,"列某文件夹下全部文档(含子文件夹)"就不用递归查询了
  created_at timestamptz not null default now()
);

-- ============================================================
-- 表3 kb_documents:文档登记表。文件本体在 Supabase Storage 桶里,这张表是元数据和可检索文本。
-- ============================================================
create table if not exists public.kb_documents (
  id           uuid primary key,     -- 文档 id(web-console 后端生成,用作桶内对象路径中段)
  kb_id        uuid not null references public.knowledge_bases(id) on delete cascade,
               -- 所属知识库
  folder_id    uuid references public.kb_folders(id) on delete cascade,
               -- 所在文件夹;为 NULL 表示在根目录
  name         text not null,        -- 文档名(如 '报价单.pdf',同级不能重名)
  content_type text not null,        -- MIME 类型(如 application/pdf)
  size_bytes   bigint not null,      -- 文件大小(字节)
  storage_path text not null,        -- 文件在公共桶内的对象路径:'{appId}/{docId}/document{ext}'(应用分段隔离;对象名不含用户输入的中文)
  text_content text,                 -- 从文件抽取出的纯文本(pdf/office 用 Tika 抽,图片用 OCR),
               -- 只用于关键字检索和 AI 阅读,不是文件本体;未解析完成时为 NULL
  parse_status text not null default 'pending' check (parse_status in ('pending','ready','failed')),
               -- 解析状态:pending 待解析 / ready 已就绪(可检索) / failed 解析失败
  parse_error  text,                 -- 解析失败原因(仅 failed 时有值)
  uploaded_by  text not null,        -- 上传者(Supabase Auth 的 user.id,即 JWT 的 sub)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()   -- 解析完成回写文本时会刷新
);

-- 索引:按知识库列文件夹树 / 按路径前缀找子树
create index if not exists idx_kb_folders_kb on public.kb_folders (kb_id, path);
-- 索引:按知识库 + 文件夹列文档
create index if not exists idx_kb_documents_kb_folder on public.kb_documents (kb_id, folder_id);

-- 同名唯一:parent_id/folder_id 可空,Postgres 唯一约束视 NULL 互异,用 coalesce 表达式索引
-- (NULL 与 NULL 本来不算重复,coalesce 把 NULL 统一换成全零 uuid 后,"根目录下同名"也能被唯一索引拦住)
create unique index if not exists uk_kb_folders_sibling
  on public.kb_folders (kb_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
create unique index if not exists uk_kb_documents_sibling
  on public.kb_documents (kb_id, coalesce(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- 关键字检索提速与相关性排序:pg_trgm 扩展 + name/text_content 的 GIN trgm 索引。
-- web-console 列文档带 kw 时按 similarity(name/text_content, kw) 相关性降序,
-- 未装扩展时检索直接报错,故扩展与索引必须执行(与本节其他 SQL 一并跑)。
create extension if not exists pg_trgm;
create index if not exists idx_kb_documents_trgm on public.kb_documents
  using gin ((name) gin_trgm_ops, (text_content) gin_trgm_ops);
```

### 3.3.1 全文检索与向量检索准备(pg_jieba + pgvector)

§3.3 只有 pg_trgm 关键字检索(子串命中 + 字符相似度排序),搜不到语义相关但字面不同的内容;本节为后续「全文检索(中文分词)+ 向量语义检索」打好数据库侧地基:安装两个扩展、预建 tsvector 生成列与向量分块表。应用侧的分块写入、embedding 调用、混合排序在检索功能落地时另行实现,本节只做一次性环境准备,可现在执行,执行后对现有功能零影响。与 §3 相同,以下 SQL 均为手工执行,无 migration 文件。

前置条件:

- PostgreSQL 18,安装在 `D:\Program Files\PostgreSQL\18`(EDB 安装器,§1 已装;版本或盘符不同时,按下文路径样式替换)
- Visual Studio 2022 Build Tools:官网下载,勾选「使用 C++ 的桌面开发」工作负载与「适用于 Windows 的 C++ CMake 工具」组件(两个扩展的编译器与 CMake)
- Git(克隆源码;pg_jieba 的分词词典 cppjieba 经 git 子模块拉取,必须 `--recursive`)
- 扩展安装会写进 PostgreSQL 安装目录(如 `D:\Program Files\PostgreSQL\18`),以下编译安装命令一律在**管理员**终端执行

#### 第 1 步 安装 pg_jieba(中文分词)

PostgreSQL 内置分词器只按空格切词,整段中文会变成一个词元,全文检索对中文基本不可用;pg_jieba 提供名为 `jiebacfg` 的分词配置,把中文按词典切成词,是 Windows 上最容易编译的中文分词扩展(zhparser 依赖 SCWS 库,Windows 编译麻烦,不推荐)。管理员 PowerShell 执行:

```powershell
git clone --recursive https://github.com/jaiminpan/pg_jieba.git D:\pg-build\pg_jieba
cd D:\pg-build\pg_jieba
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DPostgreSQL_ROOT="D:\Program Files\PostgreSQL\18" -DPG_CONFIG_EXECUTABLE="D:\Program Files\PostgreSQL\18\bin\pg_config.exe"

# PG 服务端头文件引用少量 POSIX 头(netinet/in.h 等),Windows 没有这些文件,官方构建用
# include\server\port\win32 与 win32_msvc 下的垫片头文件顶替;EDB 安装包已装好垫片,但扩展
# 编译不会自动搜索它们,须用 cl 的 CL 环境变量追加 /I 搜索路径(经 msbuild 编译时,INCLUDE
# 环境变量会被工程体系整体覆盖,不生效;CL 变量由 cl 原样拼进命令行,不受影响)。
# 不加则编译报「无法打开包括文件: netinet/in.h」(路径版本号按实际安装调整)。
# /std:c++20 必须带:jieba_token.h 用 C++20 指定初始化器,MSVC 默认 C++14 报 C7555;
# 编译 .c 文件时该选项会报「忽略未知选项」警告,无害
$env:CL = '/I"D:\Program Files\PostgreSQL\18\include\server\port\win32" /I"D:\Program Files\PostgreSQL\18\include\server\port\win32_msvc" /std:c++20'

cmake --build build --config Release
cmake --install build
```

- 路径按实际安装盘符与版本调整;`cmake --install` 把 DLL 与 SQL 控制文件拷进 PostgreSQL 的 lib/share 目录,Program Files 下需要管理员权限
- 源码必须 `git clone --recursive` 获取(zip 压缩包不带子模块,libjieba 为空目录,编译报「无法打开包括文件: cppjieba/Jieba.hpp」);若已中招,在源码目录补执行 `git clone --recursive https://github.com/yanyiwu/cppjieba.git libjieba` 即可,无需重新 clone 整个 pg_jieba
- 上游 CMakeLists.txt 在 MSVC 下缺链接配置,编译全过后链接期报 `LNK2019: 无法解析的外部符号`(palloc/errstart/errmsg 等 20 余个 PG 服务端符号):在 CMakeLists.txt 的 `if(WIN32 AND MSVC)` 块(`PREFIX "lib"` 所在块)末尾补 `target_link_libraries("${PG_JIEBA_LIBRARY_NAME}" "${PostgreSQL_LIBRARY_DIRS}/postgres.lib")`,保存后重新 `cmake --build` 即可(CMake 检测到 CMakeLists 变化会自动重新生成工程)。Windows 扩展 DLL 必须链接 postgres 导入库才能解析服务端符号;Linux 上这些符号由 postgres 进程加载时提供,链接反而失败,故该补丁仅限 Windows
- `create extension pg_jieba` 报 `58P01 无法访问文件 "pg_jieba"`:control 与 SQL 已装好,但 DLL 因 CMakeLists 的 `PREFIX "lib"` 装成了 `libpg_jieba.dll`,而扩展按 `module_pathname = '$libdir/pg_jieba'` 找 `pg_jieba.dll`,加载器不会自动补 lib 前缀——在 `lib` 目录补 `copy libpg_jieba.dll pg_jieba.dll` 后重跑 create extension 即可
- 若 cmake 阶段报找不到 PostgreSQL,检查安装时是否勾选了 Command Line Tools;重装扩展的新 DLL 覆盖旧 DLL 前需先停止 PostgreSQL 服务(Windows 锁定已加载的 DLL),首次安装无此问题

#### 第 2 步 安装 pgvector(向量类型)

pgvector 提供 vector 类型、距离运算符与 HNSW 近似最近邻索引,是 PG 向量检索的事实标准;EDB 安装器不带它,按官方 Windows 步骤用 MSVC 编译安装。编译必须在 **x64** MSVC 环境下进行:开始菜单搜索打开「x64 Native Tools Command Prompt for VS 2022」(**管理员**身份,该终端已自动加载 x64 编译环境),执行:

```bat
git clone https://github.com/pgvector/pgvector.git D:\works\pgvector
cd /d D:\works\pgvector
git checkout v0.8.7
set "PGROOT=D:\Program Files\PostgreSQL\18"
nmake /F Makefile.win clean
nmake /F Makefile.win
nmake /F Makefile.win install
```

- checkout 的 tag 以 GitHub Releases 页的最新 release 为准(示例 v0.8.7 仅为时点示意);**PG17/18 必须用 v0.8.0 之后发布的版本**——v0.8.0 及更早因上游 API 变更明确不支持 PG17+,在 PG18 上无法使用

#### 第 3 步 创建扩展并验证

用 psql 以超级用户连接 postgres 库(扩展安装需要超级用户权限),执行:

```sql
create extension if not exists pg_jieba;
create extension if not exists vector;

-- 验证分词:应把「员工差旅费用报销流程」切成多个词元,而不是一整段
select to_tsvector('jiebacfg', '员工差旅费用报销流程与标准');

-- 验证向量类型:应输出 [1,2,3]
select '[1,2,3]'::vector(3);
```

#### 第 4 步 预建全文检索列与索引

tsvector 生成列在行写入时自动分词,标题命中权重 A、正文权重 B,检索时标题命中的文档排前;生成列由数据库自动维护,应用侧只需构造 tsquery 查询。执行前确认第 3 步的 pg_jieba 已创建,否则报「text search configuration "jiebacfg" does not exist」。加列会重算 kb_documents 已有行,当前量级下秒级完成:

```sql
alter table public.kb_documents
  add column if not exists fts tsvector
  generated always as (
    setweight(to_tsvector('jiebacfg', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('jiebacfg', coalesce(text_content, '')), 'B')
  ) stored;
create index if not exists idx_kb_documents_fts on public.kb_documents using gin (fts);
```

#### 第 5 步 预建向量分块表与 HNSW 索引

向量检索以「块」为单位:解析管线把 text_content 切成若干 chunk,每块调 embedding 模型转成定长向量存入 kb_chunks。**维度必须与所选 embedding 模型一致**(Qwen3-Embedding-4B 原生 2560 维;请求体 `dimensions` 参数钉死,应用配置 `KB_EMBEDDING_DIMENSIONS=2560` 与本节保持同步),换模型时同步替换 `halfvec(2560)`。列类型用 halfvec(fp16)而非 vector:同样维度下内存减半,fp16 精度损失对余弦检索可忽略。2560 维在 HNSW 索引上限内(`vector` 索引上限 2000 维、`halfvec` 4000 维),建近似索引加速余弦检索;m=16、ef_construction=64 与维度无关,为标准取值:

```sql
create table if not exists public.kb_chunks (
  id          uuid primary key,     -- chunk id(web-console 后端生成)
  doc_id      uuid not null references public.kb_documents(id) on delete cascade,
              -- 所属文档;文档删除时级联清块
  kb_id       uuid not null references public.knowledge_bases(id) on delete cascade,
              -- 冗余知识库 id:按知识库过滤向量时无需 join
  chunk_index integer not null,      -- 块在文档内的序号,从 0 递增
  chunk_text  text not null,         -- 块文本(引用展示与重排用)
  embedding   halfvec(2560) not null, -- 维度必须与 embedding 模型一致(见上)
  created_at  timestamptz not null default now(),
  unique (doc_id, chunk_index)
);
create index if not exists idx_kb_chunks_doc on public.kb_chunks (doc_id, chunk_index);
-- HNSW 近似索引(2560 维在 halfvec 4000 维上限内;vector 类型上限 2000 维,4096 维
-- 模型建索引会报「column cannot have more than 4000 dimensions for hnsw index」):
create index if not exists idx_kb_chunks_hnsw on public.kb_chunks
  using hnsw (embedding halfvec_cosine_ops) with (m = 16, ef_construction = 64);
-- 检索 SQL(应用侧同写法,按 kb_id 过滤后取余弦距离最近,自动走 HNSW 索引):
-- select chunk_text from public.kb_chunks
--   where kb_id = '<kb id>'
--   order by embedding <=> '[...]'::halfvec(2560)
--   limit 5;
```

执行完本节,数据库侧三路检索能力齐备:pg_trgm 关键字(§3.3)+ jiebacfg 全文 + pgvector 语义。应用侧混合检索已落地:web-console 的 `GET /api/kb/{kbId}/search`(员工端)与 `GET /api/backend/kb/{kbId}/search`(服务密钥端)把三路候选按 RRF(k=60)融合为文档级命中(同文档只出现一条,snippet 取最优命中摘录),员工端 kb_search 工具即消费该端点;算法与契约见 [2026-10-02-kb-hybrid-search-design.md](./2026-10-02-kb-hybrid-search-design.md)。

#### 第 6 步 kb_documents 加 chunk 参数列

文档解析管线(web-console)拆 chunk 时使用,参数随上传/重新解析请求写入行内,重新解析时预填:

```sql
alter table public.kb_documents
  add column if not exists chunk_max_size integer not null default 1000,   -- 单 chunk 最大字符数
  add column if not exists chunk_overlap integer not null default 150,     -- 相邻 chunk 重叠字符数
  add column if not exists chunk_separator text not null default E'\n\n';  -- 优先切分的分隔符
```

### 3.4 DSH backend profile 注册表

```sql
-- DSH backend profile 实例注册表:按 url 唯一,实例重启/换址都按 url upsert。
-- active 判定 = last_heartbeat_at 在 5 分钟内(注册心跳周期 60s 的冗余),不维护状态列。
CREATE TABLE public.backend_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 实例展示名(设计器下拉显示)
    name TEXT NOT NULL,
    -- 实例对外可达的调用 URL(flowable delegate 按此提交任务)
    url TEXT NOT NULL UNIQUE,
    -- 当前默认 LLM 标签(实例注册时上报,展示用)
    llm_label TEXT,
    -- 工作空间标签(展示用)
    workspace_label TEXT,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_backend_profiles_url ON public.backend_profiles (url);
```

### 3.5 组织树

```sql
-- ============================================================
-- 组织树:节点=部门,parent_id 自引用构成行政线。
-- head_user_id 是部门负责人,虚拟角色"上一级"等运行时取这一列。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.org_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 部门名称
    name TEXT NOT NULL,
    -- 父部门 id;NULL=根节点。循环引用由应用层校验(同 app_roles 惯例)
    parent_id UUID REFERENCES public.org_units(id),
    -- 部门负责人,引用 platform_users.id
    head_user_id UUID REFERENCES public.platform_users(id),
    -- 同级排序
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引:按父部门列子部门;按负责人反查
CREATE INDEX IF NOT EXISTS idx_org_units_parent ON public.org_units (parent_id);
CREATE INDEX IF NOT EXISTS idx_org_units_head ON public.org_units (head_user_id);

-- 同级同名唯一:parent_id 可空,Postgres 唯一约束视 NULL 互异,
-- 用 coalesce 表达式索引让"根下同名"也能被唯一索引拦住(同 kb_folders 惯例)
CREATE UNIQUE INDEX IF NOT EXISTS uk_org_units_sibling
  ON public.org_units (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- ============================================================
-- 员工×部门多对多映射:员工可属 0..N 个部门(兼岗/跨部门任职)。
-- 审批路由成员判定(sameLine/fixedUnit)与发起身份选择都按此表。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.org_unit_members (
    org_unit_id UUID NOT NULL REFERENCES public.org_units(id),
    user_id UUID NOT NULL REFERENCES public.platform_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_unit_id, user_id)
);

-- 索引:按员工反查其全部部门(发起身份选择/超时升级锚点回退)
CREATE INDEX IF NOT EXISTS idx_org_unit_members_user ON public.org_unit_members (user_id);
```

### 3.6 企业统一 LLM 接入与额度治理表

下面的 SQL 直接在当前业务库执行，统一落在 `public` schema。

```sql
-- ============================================================
-- 企业统一 LLM 接入与额度治理表。
-- 业务归属:全部属于 web-console 后台数据库,不是 New API 自己的表。
-- 设计目标:
-- 1) 保存对外暴露的逻辑模型目录
-- 2) 按部门/个人配置“按模型、按月”的 token 额度
-- 3) 为“用户 + 模型”定义有顺序的额度池路由链,支持顺位回退
-- 4) 把每次调用真实入账到 append-only 主账本,供审计与热力图统计
-- ============================================================

-- 企业逻辑模型目录表。
-- 业务含义:这里定义的是“员工端能看到的企业模型”,不是上游厂商原始模型名。
-- New API 渠道在 New API 控制台手工创建维护(设计 2026-09-27 §8.6),本表不含渠道同步字段;
-- 上游凭据只存在于 New API 渠道中,本库不存储。
-- 算法含义:reservation_tokens 是流式请求的预留量,硬拦截先按这个值做额度预检,
-- 等 New API 返回最终 usage 后再按真实 token 结算。
CREATE TABLE IF NOT EXISTS public.llm_enterprise_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT NOT NULL,
    gateway_model_name TEXT NOT NULL,
    model_params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    reservation_tokens INTEGER NOT NULL CHECK (reservation_tokens > 0),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.llm_enterprise_models
    ADD CONSTRAINT uq_llm_enterprise_models_gateway_name
    UNIQUE (gateway_model_name);

-- 月度额度授权表。
-- 业务含义:一条记录代表“某个个人或某个部门,在某个模型上,某个生效区间内”的月额度。
-- monthly_limit_tokens:-1 表示不限量,0 表示当月不可用,正数为月度 token 上限。
-- subject_type + subject_id 做多态归属:
-- - user     -> platform_users.id
-- - org_unit -> org_units.id
-- 这里不做数据库级外键,因为同一列要同时指向两张表,由应用层按 subject_type 校验目标存在。
CREATE TABLE IF NOT EXISTS public.llm_quota_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'org_unit')),
    subject_id UUID NOT NULL,
    model_id UUID NOT NULL REFERENCES public.llm_enterprise_models(id),
    monthly_limit_tokens BIGINT NOT NULL CHECK (monthly_limit_tokens >= -1),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    effective_from DATE NOT NULL,
    effective_to DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- 用户模型路由头表。
-- 一条记录对应“一个用户对一个模型”的总路由规则。
-- exhaust_action 是所有池子都不够后的最终处理:
-- - block         : 直接拦截
-- - allow_overage : 允许继续,超额记到兜底来源
CREATE TABLE IF NOT EXISTS public.llm_user_model_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.platform_users(id),
    model_id UUID NOT NULL REFERENCES public.llm_enterprise_models(id),
    exhaust_action TEXT NOT NULL
        CHECK (exhaust_action IN ('block', 'allow_overage')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.llm_user_model_routes
    ADD CONSTRAINT uq_llm_user_model_routes_user_model
    UNIQUE (user_id, model_id);

-- 用户模型路由顺位项。
-- 业务含义:为一个“用户 + 模型”定义顺序额度池,例如:
--   1) 用户个人额度
--   2) A 部门额度
--   3) B 部门额度
-- 算法含义:请求进入时按 priority 升序依次检查可用池,第一个能覆盖预留量的池即命中。
-- 若所有池都不足,再执行 llm_user_model_routes.exhaust_action。
CREATE TABLE IF NOT EXISTS public.llm_user_model_route_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id UUID NOT NULL REFERENCES public.llm_user_model_routes(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL CHECK (priority > 0),
    source_type TEXT NOT NULL CHECK (source_type IN ('user', 'org_unit')),
    source_id UUID NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.llm_user_model_route_items
    ADD CONSTRAINT uq_llm_user_model_route_items_route_priority
    UNIQUE (route_id, priority);

ALTER TABLE public.llm_user_model_route_items
    ADD CONSTRAINT uq_llm_user_model_route_items_route_source
    UNIQUE (route_id, source_type, source_id);

-- append-only 用量主账本。
-- 业务含义:每次请求最终都在这里留痕,它是企业审计、统计和热力图的真相源。
-- 算法含义:
-- - status=reserved  表示已占用预留量,等待最终 usage
-- - status=completed 表示已拿到最终 usage 并完成实扣
-- - status=blocked   表示所有池都不足且策略为硬拦截
-- - status=failed/cancelled 表示调用失败或中断,需要释放预留
CREATE TABLE IF NOT EXISTS public.llm_usage_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id TEXT NOT NULL,
    usage_month CHAR(7) NOT NULL,
    user_id UUID NOT NULL REFERENCES public.platform_users(id),
    route_id UUID REFERENCES public.llm_user_model_routes(id),
    route_item_id UUID REFERENCES public.llm_user_model_route_items(id) ON DELETE SET NULL,
    selected_priority INTEGER,
    org_unit_id UUID REFERENCES public.org_units(id),
    source_type TEXT NOT NULL CHECK (source_type IN ('user', 'org_unit')),
    source_id UUID NOT NULL,
    model_id UUID NOT NULL REFERENCES public.llm_enterprise_models(id),
    session_id TEXT,
    gateway_request_id TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('reserved', 'completed', 'blocked', 'failed', 'cancelled')),
    reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
    prompt_tokens BIGINT NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    completion_tokens BIGINT NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
    total_tokens BIGINT NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
    overage_tokens BIGINT NOT NULL DEFAULT 0 CHECK (overage_tokens >= 0),
    estimated_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    -- 名称快照:写入时定格,用户/模型/扣费来源之后被改名或删除,历史账本的展示与筛选不受影响
    user_name_snapshot TEXT,
    model_name_snapshot TEXT,
    source_name_snapshot TEXT,
    CHECK (usage_month ~ '^\d{4}-\d{2}$')
);

ALTER TABLE public.llm_usage_ledger
    ADD CONSTRAINT uq_llm_usage_ledger_request_id
    UNIQUE (request_id);

-- 月度余额快照表。
-- 业务含义:避免每次都从主账本全量求和,把“某来源在某月某模型上的当前余额状态”缓存下来。
-- 算法含义:
-- - reserved_tokens = 已预留、尚未结算的量
-- - consumed_tokens = 已完成实扣的量
-- - overage_tokens  = 超出月额度上限的量
-- 运行时做额度判断时,必须在事务里锁这一行(SELECT ... FOR UPDATE)。
CREATE TABLE IF NOT EXISTS public.llm_monthly_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usage_month CHAR(7) NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('user', 'org_unit')),
    source_id UUID NOT NULL,
    model_id UUID NOT NULL REFERENCES public.llm_enterprise_models(id),
    limit_tokens BIGINT NOT NULL CHECK (limit_tokens >= -1),
    reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
    consumed_tokens BIGINT NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0),
    overage_tokens BIGINT NOT NULL DEFAULT 0 CHECK (overage_tokens >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (usage_month ~ '^\d{4}-\d{2}$')
);

ALTER TABLE public.llm_monthly_balances
    ADD CONSTRAINT uq_llm_monthly_balances_key
    UNIQUE (usage_month, source_type, source_id, model_id);

-- 索引:额度授权查询。
-- 业务解释:管理员保存后,运行时需要按“来源 + 模型 + 生效区间”快速找 grant。
CREATE INDEX IF NOT EXISTS idx_llm_quota_grants_subject_model_effective
  ON public.llm_quota_grants (subject_type, subject_id, model_id, effective_from, effective_to, enabled);

-- 索引:路由头查询。
-- 业务解释:员工发起调用时,先按“用户 + 模型”找到这一条总路由。
CREATE INDEX IF NOT EXISTS idx_llm_user_model_routes_user_model_enabled
  ON public.llm_user_model_routes (user_id, model_id, enabled);

-- 索引:顺位项查询。
-- 业务解释:路由解析需要按 priority 升序读取顺位池。
CREATE INDEX IF NOT EXISTS idx_llm_user_model_route_items_route_priority_enabled
  ON public.llm_user_model_route_items (route_id, priority, enabled);

-- 索引:反查某个来源被哪些路由项引用。
-- 业务解释:管理员调整部门/用户额度时,可快速判断影响范围。
CREATE INDEX IF NOT EXISTS idx_llm_user_model_route_items_source_enabled
  ON public.llm_user_model_route_items (source_type, source_id, enabled);

-- 索引:按月份查某个用户的调用明细。
CREATE INDEX IF NOT EXISTS idx_llm_usage_ledger_usage_month_user
  ON public.llm_usage_ledger (usage_month, user_id);

-- 索引:按月份查某个来源的总消耗。
CREATE INDEX IF NOT EXISTS idx_llm_usage_ledger_usage_month_source
  ON public.llm_usage_ledger (usage_month, source_type, source_id);

-- 索引:按月份查某个模型的消耗。
CREATE INDEX IF NOT EXISTS idx_llm_usage_ledger_usage_month_model
  ON public.llm_usage_ledger (usage_month, model_id);

-- 索引:按时间倒序拉最近请求,方便审计列表和排障。
CREATE INDEX IF NOT EXISTS idx_llm_usage_ledger_created_at
  ON public.llm_usage_ledger (created_at DESC);
```

### 3.7 分析看板指标表

web-console 定时轮询 flowable-engine `/actuator/metrics` 落库的运维指标采样表:

```sql
CREATE TABLE IF NOT EXISTS public.dsh_metrics_sample (
    id BIGSERIAL PRIMARY KEY,
    metric TEXT NOT NULL,          -- 指标名,如 dsh.flowable.jobs.async;
                                   -- 带 tag 指标形如 dsh.backend.task{outcome=success}
    statistic TEXT NOT NULL,       -- VALUE / COUNT / TOTAL_TIME / MAX
    value DOUBLE PRECISION NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dsh_metrics_sample_metric_ts
  ON public.dsh_metrics_sample (metric, ts DESC);
```

可选(数据量增长后按需执行):引擎历史表按"定义 + 发起时间"聚合查询的组合索引:

```sql
CREATE INDEX IF NOT EXISTS idx_hi_actinst_procdef_start
  ON flowable.act_hi_actinst (proc_def_id_, start_time_);
```

### 3.8 OAuth relay 中转会话表

DSH 员工端 Pocket Access 手机端登录的中转登记(web-console `OauthRelayController`):手机端回调地址(LAN IP/隧道域名)无法在认证中心枚举登记,redirect_uri 恒指向 web-console 固定的 `/api/auth/dsh-relay/callback`;发起登录时按 state(兼作包裹号)登记回跳地址,认证中心 302 回落点按 state 取回并一次性消费。会话行只有回跳地址,不含授权码/令牌/用户信息(PKCE verifier 只在手机端,泄密面为零);过期行由登记时顺手清理,无独立清理任务。

```sql
-- ============================================================
-- OAuth relay 中转会话:state 兼作包裹号,5 分钟 TTL,一次性消费。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.oauth_relay_sessions (
    -- authorize state(前端生成的随机串,兼作 relay 会话号)
    state TEXT PRIMARY KEY,
    -- 发起登录的端点 origin(手机端 LAN IP/隧道域名),302 转交目标基地址
    return_origin TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```