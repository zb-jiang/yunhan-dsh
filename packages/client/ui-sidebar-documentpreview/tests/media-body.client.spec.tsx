// @vitest-environment jsdom
/** Media bodies play through the file route and report load outcomes through the renderer content. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import { TextPreview, type TextPreviewProps } from '../src/client/TextPreview.tsx'
import { MediaBody, type MediaBodyProps } from '../src/client/media/MediaBody.tsx'
import { ABSOLUTE_PATH, harness, t, TAB_ID } from './fixtures.client.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const definition: DocumentPreviewDefinition = {
  id: 'media-viewer', extensions: ['md'], binaryExtensions: ['md'], title: () => 'Media', loading: 'renderer',
}

/** The media body occupying the document seat for one element kind. */
function mediaSlots(kind: 'audio' | 'video', h: ReturnType<typeof harness>): Pick<TextPreviewProps, 'renderSlot' | 'useDocumentPreviews'> {
  const renderSlot: TextPreviewProps['renderSlot'] = (name: string, input: unknown) => {
    if (name !== 'sidebar.right.tab.document') return null
    const owner = input as OwnerOf<'sidebar.right.tab.document'>
    // The component fixture supplies the standard seats; the real slot binding is exercised by the browser scenario.
    const props = { ...h.props(), ...owner, kind, t } as MediaBodyProps
    return <MediaBody {...props} />
  }
  const useDocumentPreviews: TextPreviewProps['useDocumentPreviews'] = selector => selector([definition])
  return { renderSlot, useDocumentPreviews }
}

/** Render the preview with the media body of one element kind. */
function mountMedia(kind: 'audio' | 'video', h: ReturnType<typeof harness>) {
  return render(<TextPreview {...h.props()} {...mediaSlots(kind, h)} />)
}

function fireMediaEvent(element: Element, type: 'loadedmetadata' | 'error'): void {
  act(() => { element.dispatchEvent(new Event(type)) })
}

function fileRouteUrl(): string {
  return new URL(`api/file?path=${encodeURIComponent(ABSOLUTE_PATH)}`, document.baseURI).href
}

it('plays a live file through the file route and reports its version', () => {
  const h = harness()
  const view = mountMedia('video', h)
  const element = view.container.querySelector('video')
  expect(element).not.toBeNull()
  expect(element?.getAttribute('src')).toBe(fileRouteUrl())
  fireMediaEvent(element!, 'loadedmetadata')
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v1')
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.loading).toBe(false)
  expect(view.container.querySelector('[data-document-loading]')).toBeNull()
})

it('plays an audio file with the same route contract', () => {
  const h = harness()
  const view = mountMedia('audio', h)
  const element = view.container.querySelector('audio')
  expect(element).not.toBeNull()
  expect(element?.getAttribute('src')).toBe(fileRouteUrl())
  fireMediaEvent(element!, 'loadedmetadata')
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v1')
})

it('waits for the file metadata before creating the element', () => {
  const h = harness()
  h.setVersion(undefined)
  const view = mountMedia('video', h)
  expect(view.container.querySelector('video')).toBeNull()
  expect(view.container.querySelector('[data-document-loading]')).not.toBeNull()
})

it('reports the metadata failure instead of loading', () => {
  const h = harness()
  h.setFailure({ code: 'workspace-file/not-found', message: 'gone' } as never)
  const view = mountMedia('video', h)
  expect(view.container.querySelector('video')).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe('failed')
})

it('shows the failure line and retries when the element cannot load', () => {
  const h = harness()
  const view = mountMedia('audio', h)
  const element = view.container.querySelector('audio')
  fireMediaEvent(element!, 'error')
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.loading).toBe(false)
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBeUndefined()
  expect(screen.getByRole('alert').textContent).toBe('failed')
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  // The reload replaced the content revision, so a fresh element mounts in loading state.
  const next = view.container.querySelector('audio')
  expect(next).not.toBeNull()
  expect(view.container.querySelector('[data-document-loading]')).not.toBeNull()
  fireMediaEvent(next!, 'loadedmetadata')
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v1')
})

it('re-keys the element for a changed file, so the new version loads fresh', async () => {
  const h = harness()
  const view = mountMedia('video', h)
  const first = view.container.querySelector('video')
  fireMediaEvent(first!, 'loadedmetadata')
  // Automatic refresh would consume the change silently; turn it off to exercise the reload button.
  await act(async () => { h.instance.actions.toggledAutoRefresh(TAB_ID) })
  h.setVersion('v2')
  view.rerender(<TextPreview {...h.props()} {...mediaSlots('video', h)} />)
  fireEvent.click(screen.getByRole('button', { name: 'reloadNow' }))
  const second = view.container.querySelector('video')
  expect(second).not.toBe(first)
  fireMediaEvent(second!, 'loadedmetadata')
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v2')
})
