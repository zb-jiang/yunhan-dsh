/**
 * PPT 生图配置卡片:settings.section 座位的正式表单。
 *
 * <p>数据源是宿主本地 webserver 的 `/api/ppt/settings`(GET 摘要不含明文
 * Key,PUT 全量写入;空 Key 语义为「保留已保存值」,见 ppt-core rpc)。
 * 保存成功后后端会同步重写 skill 副本的 `.env`,无需其他操作。
 */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PptSettingsCard.module.css'

/** GET/PUT `/api/ppt/settings` 的响应体(ppt-core `publicView`)。 */
interface PptSettingsPayload {
  configured: boolean
  imageBackend: string
  imageBaseUrl: string
  imageModel: string
  knownBackends: string[]
}

/** Props assembled by the settings renderer. */
export type PptSettingsCardProps = PropsLocale<'settings.ppt'>

/** Render the image-backend settings form.
 * @param props Localized text.
 * @returns The PPT settings section.
 */
export function PptSettingsCard({ t }: PptSettingsCardProps) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [backends, setBackends] = useState<readonly string[]>([])
  const [configured, setConfigured] = useState(false)
  const [backend, setBackend] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('api/ppt/settings')
        if (!response.ok) throw new Error(`status ${String(response.status)}`)
        const payload = await response.json() as PptSettingsPayload
        if (!live) return
        setBackends(payload.knownBackends)
        setConfigured(payload.configured)
        setBackend(payload.imageBackend)
        setBaseUrl(payload.imageBaseUrl)
        setModel(payload.imageModel)
      } catch {
        if (live) setLoadError(true)
      } finally {
        if (live) setLoading(false)
      }
    }
    void load()
    return () => { live = false }
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaved(false)
    setSaveError(false)
    try {
      const response = await fetch('api/ppt/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBackend: backend, imageApiKey: apiKey, imageBaseUrl: baseUrl, imageModel: model }),
      })
      if (!response.ok) throw new Error(`status ${String(response.status)}`)
      const payload = await response.json() as PptSettingsPayload
      setConfigured(payload.configured)
      setApiKey('')
      setSaved(true)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <section className={css.page}><p className={css.hint}>{t('sectionIntro')}</p></section>
  if (loadError) {
    return <section className={css.page}>
      <p className={css.error} role="alert">{t('loadError')}</p>
    </section>
  }
  return <section className={css.page}>
    <p className={css.hint}>{t('sectionIntro')}</p>
    <p className={configured ? css.stateOk : css.stateOff}>{configured ? t('configuredYes') : t('configuredNo')}</p>
    <div className={css.field}>
      <label className={css.label} htmlFor="ppt-backend">{t('backend')}</label>
      <select id="ppt-backend" className={css.select} value={backend} onChange={(event) => { setSaved(false); setBackend(event.target.value) }}>
        <option value="">{t('backendUnset')}</option>
        {backends.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <span className={css.hint}>{t('backendHint')}</span>
    </div>
    <div className={css.field}>
      <label className={css.label} htmlFor="ppt-api-key">{t('apiKey')}</label>
      <input id="ppt-api-key" className={css.input} type="password" autoComplete="off"
        placeholder={t('apiKeyKeepPlaceholder')} value={apiKey}
        onChange={(event) => { setSaved(false); setApiKey(event.target.value) }} />
      <span className={css.hint}>{t('apiKeyHint')}</span>
    </div>
    <div className={css.field}>
      <label className={css.label} htmlFor="ppt-base-url">{t('baseUrl')}</label>
      <input id="ppt-base-url" className={css.input} type="text" value={baseUrl}
        onChange={(event) => { setSaved(false); setBaseUrl(event.target.value) }} />
      <span className={css.hint}>{t('baseUrlHint')}</span>
    </div>
    <div className={css.field}>
      <label className={css.label} htmlFor="ppt-model">{t('model')}</label>
      <input id="ppt-model" className={css.input} type="text" value={model}
        onChange={(event) => { setSaved(false); setModel(event.target.value) }} />
      <span className={css.hint}>{t('modelHint')}</span>
    </div>
    <div className={css.actions}>
      {saveError ? <span className={css.error} role="alert">{t('saveError')}</span>
        : saved ? <span className={css.saved}>{t('saved')}</span> : null}
      <Button variant="primary" disabled={saving} onClick={() => { void save() }}>
        {saving ? t('saving') : t('save')}
      </Button>
    </div>
  </section>
}
