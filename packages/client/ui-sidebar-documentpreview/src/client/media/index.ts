/** Builtin audio and video metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { MediaBody } from './MediaBody.tsx'
import type { MediaBodyInjected } from './MediaBody.tsx'
import { en, zh } from './locales.ts'

/** Audio implementation identity, shared by metadata and the keyed slot. */
export const AUDIO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/audio'

/** Video implementation identity, shared by metadata and the keyed slot. */
export const VIDEO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/video'

/** File suffixes the builtin audio body plays; the Chromium codecs decode each of them. */
export const MEDIA_AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'] as const

/** File suffixes the builtin video body plays; the Chromium codecs decode each of them. */
export const MEDIA_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'mkv'] as const

/**
 * Describe one builtin media renderer independently from its keyed body slot.
 * @param id - implementation identity, also the document slot key.
 * @param extensions - played file suffixes.
 * @param title - locale-owned implementation name.
 * @returns metadata for streamed media files.
 */
export function mediaBodyDefinition(id: string, extensions: readonly string[], title: () => string): DocumentPreviewDefinition {
  return { id, extensions, binaryExtensions: extensions, priority: 'builtin', title, loading: 'renderer', wrap: false }
}

/**
 * Register the media dictionary and both the audio and the video metadata and
 * body with reversible effects; the two registrations share one body component.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarMedia')
  ctx.effect(() => ctx.locale.register('sidebarMedia', { zh, en }), 'document-media: dictionaries')
  const register = (id: string, extensions: readonly string[], titleKey: 'title.audio' | 'title.video', kind: 'audio' | 'video') => {
    ctx.effect(() => ctx.documentPreviews.register(mediaBodyDefinition(id, extensions, () => t(titleKey))), `document-media: ${kind} metadata`)
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
      name: 'sidebar.right.tab.document', key: id, locale: 'sidebarMedia',
      inject: (): MediaBodyInjected => ({ kind }),
    }, MediaBody)), `document-media: ${kind} body`)
  }
  register(AUDIO_BODY_ID, MEDIA_AUDIO_EXTENSIONS, 'title.audio', 'audio')
  register(VIDEO_BODY_ID, MEDIA_VIDEO_EXTENSIONS, 'title.video', 'video')
}
