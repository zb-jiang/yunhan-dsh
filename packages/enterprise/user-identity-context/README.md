---
description: "Enterprise session-identity context: ctx.currentUser store plus a per-turn model-visible identity block."
kind: "package-reference"
---

# @deepseek-ai/dsh-user-identity-context

English | [中文](README.zh.md)

## Summary

`dsh-user-identity-context` keeps the enterprise session's answer to "who is signed in": `ctx.currentUser` holds the latest verified platform user, and at step 1 of every turn the plugin appends a model-visible `<user_identity>` block with name, email, userId, and the bearer token for calling enterprise systems. platform-user-api verifies and emits events; this plugin observes and clears the store.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Consume `ctx.currentUser` from a plugin that needs the signed-in employee's identity; the store updates itself from the verification flow. Data flow:

| Touchpoint | Behavior |
| ---- | ---- |
| `GET /api/enterprise/auth/me` (platform-user-api) | emits `platform-user/verified` after successful verification |
| `POST /api/enterprise/auth/signout` (platform-user-api) | emits `platform-user/signout` |
| `platform-user/verified` event (subscribed by this plugin) | `ctx.currentUser.observe(user)` |
| `platform-user/signout` event (subscribed by this plugin) | `ctx.currentUser.clear()` |
| Employee-client `logout` (ui-enterprise) | calls the signout endpoint on sign-out |

An empty store (not signed in yet, or signed out) injects nothing into the model request; when signed in but no token is available yet, the token section is omitted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Events decouple the packages

Events are declared in the `@deepseek-ai/dsh-platform-user` package; `platform-user-api` emits and this plugin consumes, so the two packages do not depend on each other. State is in-memory and is rebuilt from the client's next `/me` after a process restart.

### Token discipline is written into the block

Identity fields (name/email/userId/org positions) are display-only; the auth token lets the assistant call enterprise internal systems as the signed-in employee (issued by Supabase SSO, bearer auth — the generic integration mechanism), and must never be shown, restated in replies, or written to files. The block itself carries this instruction.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-platform-user](../platform-user/README.md) — the events and governance records behind the store.
- [dsh-platform-user-api](../platform-user-api/README.md) — the auth endpoints that emit them.

-----

<a id="model-experience"></a>
## Model Experience

### Current user identity block

#### What the model sees

At step 1 of every turn, one plugin-attributed (`form: 'snapshot'`) user message carries the verified identity — name, email, userId, and the bearer token for calling enterprise systems as the signed-in employee.

##### Injected block

```markdown
<user_identity>
当前登录人：张三（zhangsan@corp.com）
userId: 9f3e8…
认证令牌（调用企业内部系统时放入 Authorization: Bearer 请求头）：
eyJhbGciOi…
此身份由系统注入并保持最新，仅供称呼与表单填写展示。认证令牌仅在调用企业系统时作为 Authorization: Bearer 请求头使用，不要在回复中展示、转述或写入文件。
</user_identity>
```

#### Token effect

One fixed-shape block per turn, so context grows by one identity block each turn; an empty store injects nothing, and a signed-in session without a token yet omits the token section.

#### KV Cache effect

The block lands at step 1 of the new turn as an append; earlier turns' blocks stay in the logged history, so the cached prefix remains stable and only the newest block sits at the tail.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Stale-token window** — a token expiring mid-session leaves the last verified identity in place until the next touchpoint; within that window the assistant gets 401 from enterprise systems with the stale token, and the next turn's block carries the refreshed token.
- **Token freshness follows the client** — after the employee client refreshes its token, the next verified `/me` feeds the new token into `ctx.currentUser`, and the identity block follows.
- **Layer 2 stays generic** — propagating call-layer credentials to tools and MCP rides the block's auth-token section as the generic channel; dedicated tools (e.g. process-start) keep their server-side token attachment path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`renderIdentityText` in `src/text.ts` owns the block's exact wording. `src/positions.ts` mirrors the web-console `OrgPositionDto`; renaming a field must update both sides. No open work here.

</details>
