/** Audio and video documents played from the authenticated HTTP file route. */
import { useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileMediaUrl, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { hostFileOf } from '../rpc.ts'
import type {} from './locales.ts'
import css from './MediaBody.module.css'

/** Which media element one registration renders. */
export interface MediaBodyInjected {
  readonly kind: 'audio' | 'video'
}

/** Standard document props plus the media renderer's dictionary and element kind. */
export type MediaBodyProps = DocumentPreviewProps & PropsLocale<'sidebarMedia'> & MediaBodyInjected

/** One revision's settled outcome; a stale revision's recorded state never applies. */
interface MediaState {
  readonly revision: number
  readonly status: 'ready' | 'failed'
}

/**
 * Present one audio or video file with the browser's native controls. The
 * element loads through the file route with Range requests, so playback and
 * seeking never buffer the whole file in this pane.
 * @param props - renderer loading request, file metadata, and locale.
 * @returns the playing element, or the reason it is not showing.
 */
export function MediaBody(props: MediaBodyProps): ReactNode {
  const { content, absolutePath, version, metadataFailed, kind, t } = props
  const [state, setState] = useState<MediaState>()
  const request = content.kind === 'renderer' ? content : undefined
  const { name } = pathPartsOf(hostFileOf(props.resourceAddress).path)
  const label = kind === 'audio' ? t('label.audio', { name }) : t('label.video', { name })
  if (request === undefined) return <p className={css.status} role="alert">{t('unsupported')}</p>
  if (metadataFailed === true) return <p className={css.status} role="alert" data-media-failed>{t('failed')}</p>
  if (absolutePath === undefined || version === undefined) {
    return <div className={css.frame} data-media-preview={kind}><LoadingIndicator label={t('loading')} /></div>
  }
  const url = fileMediaUrl(document.baseURI, absolutePath)
  if (url === undefined) return <p className={css.status} role="alert">{t('unsupported')}</p>
  // A revision change re-keys the element, so its fresh load always starts as
  // loading; the recorded state only settles the revision it was recorded for.
  const settled = state?.revision === request.revision ? state : undefined
  if (settled?.status === 'failed') {
    return (
      <div className={css.frame} data-media-preview={kind} data-media-failed>
        <div className={css.failed}>
          <p className={css.failedLine} role="alert">{t('failed')}</p>
          <Button size="sm" onClick={request.reload}>{t('retry')}</Button>
        </div>
      </div>
    )
  }
  const settle = (status: MediaState['status']): void => {
    setState({ revision: request.revision, status })
    if (status === 'ready') request.loaded(version)
    else request.failed()
  }
  const element = kind === 'video'
    ? <video key={request.revision} className={css.media} src={url} controls preload="metadata"
      aria-label={label} onLoadedMetadata={() => { settle('ready') }} onError={() => { settle('failed') }} />
    : <audio key={request.revision} className={css.media} src={url} controls preload="metadata"
      aria-label={label} onLoadedMetadata={() => { settle('ready') }} onError={() => { settle('failed') }} />
  return (
    <div className={css.frame} data-media-preview={kind}>
      {settled === undefined && <LoadingIndicator label={t('loading')} />}
      {element}
    </div>
  )
}
