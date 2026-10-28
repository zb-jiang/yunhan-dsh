# Agent Note: 媒体预览范围流式

Status: implemented

[English](2026-10-28-media-preview-range-streaming.md) | 中文

## Problem

右侧 Sidebar 可以就地预览大多数工作区文件类型，但音频与视频文件落入不支持预览的空态和应用内打开操作，会议录制、语音备忘、演示片段的员工流程被打断。阻塞点是文件路由：`GET /api/file` 只返回完整文件，受 20 MiB 整读上限约束，而 HTML5 媒体元素需要范围请求才能播放现实大小的文件。

## Decision

`/api/file` 路由增加 HTTP Range 支持，Sidebar 增加两个渲染器模式的 body 经由它播放音频与视频。全部改动落在官方包，因为每一块都是不含企业特有逻辑的通用平台能力；merge-preserve 记录见 [UPSTREAM-MERGE.md](../../../UPSTREAM-MERGE.md)。

路由侧（`packages/api/session-controller` 的 `SessionMediaReferences`）：每个成功响应声明 `Accept-Ranges: bytes`。`Range` 指明一个 `bytes` 区间的 GET 先 stat 文件，再经 `readByteRange` 以有界窗口流式返回 `206 Partial Content` 与 `Content-Range`，范围读取不缓冲整文件，且豁免 20 MiB 上限——窗口驻留即为任意大小媒体的内存界。逗号分隔的多个区间只服务第一个；不可满足的区间返回 `416` 及 `bytes */<size>`；语法无效的头部回落到完整响应（保持上限）。HEAD 与非范围 GET 不变。范围读取复用[二进制工作区文件传输](../architecture/2026-09-17-workspace-file-binary-transfer.zh.md)已有的有界 `fs.readByteRange` 原语。

Body 侧（`packages/client/ui-sidebar-documentpreview/src/client/media/`）：两个 keyed 注册，`AUDIO_BODY_ID`（`mp3 wav flac ogg m4a aac opus`）与 `VIDEO_BODY_ID`（`mp4 m4v webm mov mkv`），以 `renderer` 模式加载。元数据报出 Host 路径和版本后，body 挂载原生 `<audio>`/`<video>` 元素，`src` 指向已鉴权的文件路由；`onLoadedMetadata` 上报 `loaded(version)`，解码失败经 `failed()` 在正文内显示重试，重新载入按 revision 重新挂载元素。为此 `DocumentBodyOwner` 契约增加三个可选字段——`absolutePath`、`version`、`metadataFailed`——由 `TextPreview` 传给 document slot，渲染器自持的加载需要 Host 路径才能构造路由。

格式边界是浏览器自身的解码器集合：未注册渲染器的容器（`.avi`、`.flv`、`.wmv`、`.wma`）保持在不受支持的空态，`unviewable.ts` 缩减到恰好这几个。`FileTypeIcon` 增加 `audio` 分类（8 个后缀、独立 glyph、与 image/video 同族的 violet），`classifyLinkPath` 把 audio 归入其 `other` 组。

## Alternatives considered

**为媒体扩展名提高整读上限。** 驻留上限变成文件大小；并发下一个 500 MB 录制的常驻内存不可控，413 只是挪走而非消失。Range 窗口使驻留与文件大小无关。

**保持应用内打开兜底。** 员工离开工作区、丢失会话上下文，且体验随安装的播放器而异；Sidebar 中没有任何记录表明文件已被消费。

**从企业层注册渲染器。** 注册本身可以走 enterprise bundle，但 `DocumentBodyOwner` 契约扩展、`TextPreview` 的 slot 传参、`unviewable` 列表都在官方代码里；没有路径契约的渲染器无法构造 `src`。能力被拆到多层却不减少官方代码足迹，只会增加合并面。

## Consequences

播放能力随应用的媒体栈；无法解码的编码在正文内提示重试，未注册容器保留应用内打开兜底。范围读取只服务第一个区间，随请求信号中止。两个包的 README（英文与中文）已描述新的路由与渲染器行为，配对确认已重新记录，客户端 slot catalog 已重新生成。整套改动是纯增量、适合 upstream PR，回馈后即可消解该 deviation。
