# Enterprise platform

English | [中文](enterprise.zh.md)

The enterprise profile mounts three services: the platform-user governance seam (`ctx.platformUsers`), the latest verified employee identity on this DSH instance (`ctx.currentUser`), and enterprise skill sync (`ctx.skillSync`). The package READMEs own the behavioral contracts: [platform-user](../../packages/enterprise/platform-user/README.md), [user-identity-context](../../packages/enterprise/user-identity-context/README.md), and [skill-sync](../../packages/enterprise/skill-sync/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcurrentuser--currentuserservice"></a>

### `ctx.currentUser` — `CurrentUserService`

In-process store of the latest verified platform user. The `platform-user/verified` event (emitted on every verified `GET /api/enterprise/auth/me`) feeds CurrentUserService.observe; `platform-user/signout` feeds CurrentUserService.clear; the identity context listener reads the store at each turn's first step. State lives in memory only: a restarted webserver learns the identity at the client's next `/me` call, and a token expiring mid-session leaves the last verified identity in place until the next touchpoint (a same-human staleness window is benign). The raw access token is kept next to the identity with two consumers: enterprise background services (skill-sync) call server-side APIs as the signed-in employee, and the identity block renders it so the assistant can call enterprise internal systems (Supabase SSO bearer auth) as that employee.

```ts cordis-catalog
/**
 * Record one verified platform user as the current identity.
 * @param user - platform user resolved from a JWT-verified access token.
 * @param accessToken - the verified bearer token; omitted keeps any previous
 * token (callers that re-verify only the user).
 */
observe(user: PlatformUser, accessToken?: string): void

/** Forget the current identity (employee signed out). */
clear(): void

/**
 * Read the latest verified identity.
 * @returns the latest verified identity, or undefined when nobody is logged in.
 */
get(): PlatformUser | undefined

/**
 * Read the latest verified bearer token.
 * @returns the latest verified bearer token, or undefined when nobody has
 * signed in; may be stale after token expiry — callers treat a 401 as
 * "signed out" and retry after the next verified `/me`.
 */
getToken(): string | undefined
```

Source: [`packages/enterprise/user-identity-context/src/index.ts`](../../packages/enterprise/user-identity-context/src/index.ts)

<a id="ctxplatformusers--platformuserservice"></a>

### `ctx.platformUsers` — `PlatformUserService`

`ctx.platformUsers`: one active provider plus the read entry point.

```ts cordis-catalog
/**
 * Register the active provider. Only one provider may be mounted.
 * @param provider - provider implementation.
 * @returns disposer that unregisters it.
 */
registerProvider(provider: PlatformUserProvider): () => void

/**
 * Resolve a platform user from a Supabase Auth access token.
 * @param accessToken - Supabase Auth access token (Bearer).
 * @returns the platform user record.
 */
getUserByToken(accessToken: string): Promise<PlatformUser>
```

Source: [`packages/enterprise/platform-user/src/index.ts`](../../packages/enterprise/platform-user/src/index.ts)

<a id="ctxpocketaccess--pocketaccessservice"></a>

### `ctx.pocketAccess` — `PocketAccessService`

手机访问代理服务：持有配对/身份/握手/LAN 探测与代理生命周期， 供管理路由与宿主消费（`ctx.pocketAccess`）。

```ts cordis-catalog
/** 启动代理（已运行则幂等返回）。 */
async enable(): Promise<void>

/** 停止代理（未运行则幂等返回）；总开关关闭同时手动停隧道（删自动恢复标记）。 */
async disable(): Promise<void>

/**
 * 启停到目标状态并持久化总开关（volatile 热更新由 settings 域完成）。
 * 持久化先于启停：写失败（非 volatile 字段污染等）保持原状不产生半启停态。
 * @param value - 目标总开关状态；true 启动代理，false 停止代理并同时停隧道。
 */
async setEnabled(value: boolean): Promise<void>

/**
 * 更新局域网接入开关（volatile 持久化）。关闭时立即踢掉全部活跃隧道：
 * 已建立的 WS 不再经过请求入口的开关检查，不踢则手机端对关闭无感知；
 * 手机端 WS 断开后由失效探测器经闸门 403 渲染「局域网访问已关闭」失效页。
 * @param value - 局域网接入目标状态；false 立即断开全部活跃 WS 隧道。
 */
async setLanEnabled(value: boolean): Promise<void>

/** 更新手动局域网地址覆盖（volatile 持久化；'' 恢复自动探测）。
 * @param ip - 手动指定的局域网地址（原样持久化，不校验格式）；'' 表示清除覆盖、恢复自动探测。
 */
async setLanOverride(ip: string): Promise<void>

/**
 * 启动公网隧道：同步校验（抛 TunnelRequestError → 路由 400）后 fire-and-forget 启动。
 * 就绪等待（含 cloudflared 解析与子进程启动）可能长达数十秒，不阻塞路由——快照先回
 * state=starting，UI 轮询观察 running/error。开关意愿 tunnelEnabled 置 true 持久化；
 * 启动失败保持 true + state=error，UI 可重试。
 * @param disclaimer - 用户已确认隧道免责声明；false 时同步校验失败，不启动。
 */
startTunnel(disclaimer: boolean): void

/** 停止公网隧道：先撤开关意愿再停进程并删自动恢复标记。 */
async stopTunnel(): Promise<void>

/**
 * 更新隧道模式与命名地址（volatile 持久化；只影响下次启动）。
 * hostname 非空时经归一化校验后存归一化值；空串清空。
 * @param options - 待更新字段；mode 非法或 hostname 无法归一化抛 TunnelRequestError，两字段均缺省同样抛错。
 */
async setTunnelConfig(options: { mode?: string | undefined; hostname?: string | undefined }): Promise<void>

/** 设置命名隧道 Token（'' 清除；否则写入 tunnel-token.json 0600）。
 * @param token - 命名隧道的 Cloudflare access token；'' 表示清除已存 token。
 */
async setTunnelToken(token: string): Promise<void>

/** 随宿主卸载的隧道清理：终止进程但保留自动恢复标记（下次启动自动拉起）。 */
async disposeTunnel(): Promise<void>

/** 状态快照（二维码按内容缓存，生成失败为 null 不阻塞快照）。
 * @returns 设置页轮询用的完整状态快照；LAN/配对二维码字段生成失败或无地址为 null。
 */
async snapshot(): Promise<PocketAccessSnapshot>

/** 生成新配对码（作废旧码），返回码与过期时间。
 * @returns 新配对码及其过期时刻（epoch 毫秒）；同时使此前的活跃配对码失效。
 */
createPairingCode(): { code: string; expiresAt: number }

/** 吊销设备并立即断开该设备活跃 WS 隧道；设备不存在返回 false。
 * @param deviceId - 待吊销的已配对设备 id。
 * @returns 设备存在且吊销成功为 true；设备不存在为 false（不断开任何连接）。
 */
async revokeDevice(deviceId: string): Promise<boolean>

/** 员工登出联动：清空全部已配对设备并断开全部活跃 WS 隧道。 */
async clearAllDevices(): Promise<void>
```

Source: [`packages/enterprise/pocket-access/src/index.ts`](../../packages/enterprise/pocket-access/src/index.ts)

<a id="ctxskillsync--skillsyncservice"></a>

### `ctx.skillSync` — `SkillSyncService`

员工端 skill 分发服务:周期同步 + 即时安装入口(工作项 3 的对接面)。

<p>daemon 只在有人登录时干活:未登录(token 缺失)或 token 过期(401)的 一轮直接跳过,下轮重试;单 skill 下载失败记 warn 不中断同轮其他 skill。

```ts cordis-catalog
/**
 * 启动服务:缓存目录不存在时创建,随后立即跑一轮同步(不等第一个 interval)。
 * 本服务由 apply() 内普通构造挂载(非 class 插件),cordis 不会自动调用
 * `[Service.init]`,故由 apply 显式调用本方法。
 */
async start(): Promise<void>

/**
 * 执行一轮同步:拉取当前用户所需清单,下载缺失/过期的 skill 到缓存目录,
 * 有安装动作后失效 skill 注册表缓存。错误记日志不上抛(daemon 语义)。
 * 已有一轮在跑时合并等待,不重复出站。
 */
async sync(): Promise<void>

/**
 * 确保指定 skill 已安装;缺失时立即执行一轮同步再复查。
 *
 * @param names - 需要就绪的 skill 裸名(待办 dshMeta.skillRefs)。
 * @returns 仍缺失的 skill 名(同步后依旧不可用,调用方走降级提示)。
 */
async ensureInstalled(names: readonly string[]): Promise<readonly string[]>
```

Source: [`packages/enterprise/skill-sync/src/index.ts`](../../packages/enterprise/skill-sync/src/index.ts)

<a id="platform-user-events"></a>

### `platform-user/*` events

<a id="platform-usersignout--emit"></a>

#### `platform-user/signout` — emit

The employee signed out on this DSH instance (emitted by `platform-user-api` on the signout touchpoint). Listeners holding a latest-verified-identity cache must forget it. Carries no payload: the touchpoint does not prove which identity signed out.

```ts cordis-catalog
/**
 * The employee signed out on this DSH instance (emitted by
 * `platform-user-api` on the signout touchpoint). Listeners holding a
 * latest-verified-identity cache must forget it. Carries no payload:
 * the touchpoint does not prove which identity signed out.
 * @mode emit
 */
'platform-user/signout'(): void
```

Source: [`packages/enterprise/platform-user/src/index.ts`](../../packages/enterprise/platform-user/src/index.ts)

<a id="platform-userverified--emit"></a>

#### `platform-user/verified` — emit

A platform user identity was verified through an auth touchpoint (emitted by `platform-user-api` after `getUserByToken` resolves). Listeners typically maintain a latest-verified-identity cache.

```ts cordis-catalog
/**
 * A platform user identity was verified through an auth touchpoint
 * (emitted by `platform-user-api` after `getUserByToken` resolves).
 * Listeners typically maintain a latest-verified-identity cache.
 * @param user - the verified platform user record.
 * @param accessToken - the verified bearer token, re-carried so enterprise
 *   consumers (e.g. skill-sync) can call server-side APIs as the signed-in
 *   employee.
 * @mode emit
 */
'platform-user/verified'(user: PlatformUser, accessToken: string): void
```

Source: [`packages/enterprise/platform-user/src/index.ts`](../../packages/enterprise/platform-user/src/index.ts)
<!-- END GENERATED cordis-surface -->
