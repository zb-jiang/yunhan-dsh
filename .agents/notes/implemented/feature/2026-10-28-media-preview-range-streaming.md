# Agent Note: Media preview range streaming

Status: implemented

English | [中文](2026-10-28-media-preview-range-streaming.zh.md)

## Problem

The right sidebar previews most workspace file types in place, but audio and video files fall through to the unsupported-preview empty state and its open-in-app action, breaking the employee flow for meeting recordings, voice notes, and demo clips. The blocking constraint is the file route: `GET /api/file` returns the complete file only, capped by the 20 MiB whole-read limit, and HTML5 media elements need ranged requests to play files of realistic size.

## Decision

The `/api/file` route gains HTTP Range support, and the sidebar gains two renderer-mode bodies that play audio and video through it. All changes land in the official packages because every piece is a generic platform capability with no enterprise-specific logic; the merge-preserve record lives in [UPSTREAM-MERGE.md](../../../UPSTREAM-MERGE.md).

The route (`SessionMediaReferences` in `packages/api/session-controller`): every successful response advertises `Accept-Ranges: bytes`. A GET whose `Range` names one `bytes` interval stats the file and streams `206 Partial Content` with `Content-Range` in bounded windows through `readByteRange`, so a ranged read never buffers the whole file and is exempt from the 20 MiB cap — window residency bounds memory for media of any stored size. Only the first of several comma-separated intervals is served; an unsatisfiable interval returns `416` with `bytes */<size>`; a syntactically invalid header falls back to the complete response, which keeps the cap. HEAD and non-ranged GETs are unchanged. The ranged read composes the existing bounded `fs.readByteRange` primitive from [binary workspace file transfer](../architecture/2026-09-17-workspace-file-binary-transfer.md).

The bodies (`packages/client/ui-sidebar-documentpreview/src/client/media/`): two keyed registrations, `AUDIO_BODY_ID` (`mp3 wav flac ogg m4a aac opus`) and `VIDEO_BODY_ID` (`mp4 m4v webm mov mkv`), loading in `renderer` mode. Once metadata reports the Host path and version, the body mounts a native `<audio>`/`<video>` element whose `src` is the authenticated file route; `onLoadedMetadata` reports `loaded(version)`, a decode failure shows an in-body retry through `failed()`, and reload remounts the element by revision. Supporting this required three optional `DocumentBodyOwner` fields — `absolutePath`, `version`, `metadataFailed` — that `TextPreview` now passes to the document slot, since a renderer-owned load needs the Host path to construct the route.

The format boundary is the browser's own decoder set: containers without a registered renderer (`.avi`, `.flv`, `.wmv`, `.wma`) stay on the unsupported empty state, so `unviewable.ts` shrinks to exactly those. `FileTypeIcon` gains an `audio` category (8 suffixes, a distinct glyph, the violet shared with image/video), and `classifyLinkPath` maps audio into its `other` group.

## Alternatives considered

**Raise the whole-read cap for media extensions.** The resident bound would become the file size; a 500 MB recording pinned in memory per open tab is unbounded under concurrency, and 413s move instead of disappearing. The Range window keeps residency constant regardless of file size.

**Keep the open-in-app fallback.** The employee leaves the workspace, loses the conversation context, and the experience differs per installed player; nothing in the sidebar records that the file was consumed.

**Register the renderers from the enterprise layer.** The registration itself could ride an enterprise bundle, but the `DocumentBodyOwner` contract extension, the `TextPreview` slot pass-through, and the `unviewable` list all live in official code; a renderer without the path contract cannot construct its source. The capability would split across layers without removing the official-code footprint, so the split only adds merge surface.

## Consequences

Playback capability follows the application's media stack; a codec it cannot decode fails to the in-body retry, and unregistered containers keep the open-in-app fallback. Ranged reads serve the first interval only and abort with the request signal. The two package READMEs (English and Chinese) describe the new route and renderer behavior, the pairing confirmations were re-recorded, and the client slot catalog was regenerated. The stack is purely additive and suitable for an upstream PR, which would retire the deviation.
