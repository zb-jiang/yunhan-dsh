/** Media metadata, keyed slots, dictionary, and disposal registration. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { MediaBody } from '../src/client/media/MediaBody.tsx'
import {
  apply, AUDIO_BODY_ID, mediaBodyDefinition, MEDIA_AUDIO_EXTENSIONS, MEDIA_VIDEO_EXTENSIONS, VIDEO_BODY_ID,
} from '../src/client/media/index.ts'
import { en, zh } from '../src/client/media/locales.ts'

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined })

describe('media registration', () => {
  it('claims audio and video suffixes as builtin renderer-mode bodies without wrap', () => {
    const audio = mediaBodyDefinition(AUDIO_BODY_ID, MEDIA_AUDIO_EXTENSIONS, () => 'localized audio')
    expect(audio).toMatchObject({
      id: AUDIO_BODY_ID,
      extensions: MEDIA_AUDIO_EXTENSIONS,
      binaryExtensions: MEDIA_AUDIO_EXTENSIONS,
      priority: 'builtin',
      loading: 'renderer',
      wrap: false,
    })
    expect(audio.title()).toBe('localized audio')
    const video = mediaBodyDefinition(VIDEO_BODY_ID, MEDIA_VIDEO_EXTENSIONS, () => 'localized video')
    expect(video).toMatchObject({ id: VIDEO_BODY_ID, extensions: MEDIA_VIDEO_EXTENSIONS, loading: 'renderer' })
  })

  it('registers both metadata entries and keyed bodies, then removes every contribution', async () => {
    const ctx = new Context()
    const registry = new DocumentPreviewRegistry()
    const dictionaries = new Map<string, unknown>()
    const bodies = new Map<string, unknown>()
    const entries: { readonly name: string; readonly key: string; readonly locale: string; readonly inject: () => { kind: string } }[] = []
    const register = vi.fn((options: {
      readonly name: string
      readonly key: string
      readonly locale: string
      readonly inject: () => { kind: string }
    }, body: unknown) => {
      bodies.set(options.key, body)
      entries.push(options)
      return () => { bodies.delete(options.key); entries.splice(entries.indexOf(options), 1) }
    })
    ctx.provide('documentPreviews', registry)
    ctx.provide('slots', { inject: (_key: string, callback: () => () => void) => callback(), register } as never)
    ctx.provide('locale', {
      bind: () => (key: string) => key,
      register: (name: string, value: unknown) => {
        dictionaries.set(name, value)
        return () => { dictionaries.delete(name) }
      },
    } as never)
    const fiber = ctx.plugin({ apply })
    dispose = async () => { await fiber.dispose() }
    await fiber.await()
    for (const extension of MEDIA_AUDIO_EXTENSIONS) {
      expect(registry.candidates(`SONG.${extension}`).map(entry => entry.id)).toEqual([AUDIO_BODY_ID])
    }
    for (const extension of MEDIA_VIDEO_EXTENSIONS) {
      expect(registry.candidates(`CLIP.${extension}`).map(entry => entry.id)).toEqual([VIDEO_BODY_ID])
    }
    expect(dictionaries.get('sidebarMedia')).toEqual({ zh, en })
    expect(bodies.get(AUDIO_BODY_ID)).toBe(MediaBody)
    expect(bodies.get(VIDEO_BODY_ID)).toBe(MediaBody)
    expect(entries.map(entry => [entry.key, entry.locale])).toEqual([
      [AUDIO_BODY_ID, 'sidebarMedia'],
      [VIDEO_BODY_ID, 'sidebarMedia'],
    ])
    expect(entries[0]?.inject().kind).toBe('audio')
    expect(entries[1]?.inject().kind).toBe('video')
    await dispose()
    expect(registry.getSnapshot()).toEqual([])
    expect(bodies.size).toBe(0)
    expect(dictionaries.size).toBe(0)
  })
})
