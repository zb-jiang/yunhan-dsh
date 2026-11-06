---
description: "Independently distributable installable plugins, each declaring its own dsh.bundle.patch layer."
kind: "package-group"
---

# plugins/ — 可安装插件

[English](README.md) | 中文

## 摘要

本分组存放不编入任何内置 profile 的插件。每个包在 manifest 中声明 `dsh.bundle.patch`,插件管理器据此把它识别为 profile 层:用户在「添加插件」对话框输入本地目录或 tgz 路径完成安装,之后可停用/卸载,不影响基础 profile。本分组包的运行时 `dependencies` 必须在客户机上可解析——内部 `@deepseek-ai/*` 依赖在构建期 bundle 进 `lib/`,不以 workspace 链接形态分发。

## 目录

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`ppt-core`](ppt-core/README.zh.md) | AI 生成 PPT 宿主:模板库、RPC 端点、ppt-master skill、Python 检测、生图配置 | mounts `/api/ppt` routes |
| [`ppt-client`](ppt-client/README.zh.md) | PPT 客户端 UI:画廊、模板 chip、预览器、设置卡片、Python 引导 | mounts conversation and settings slots |

<a id="related-documentation"></a>
## Related documentation

- [Plugin manager](../boot/plugin-manager/README.zh.md) — 安装来源解析与 `dsh.bundle.patch` 的 profile 层判定。
- [app-boot](../boot/app-boot/README.zh.md) — bundle 层如何组合成 profile。

<a id="dev-note"></a>
## Dev Note

None.
