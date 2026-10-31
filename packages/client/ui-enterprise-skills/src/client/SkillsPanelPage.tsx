/**
 * Skill governance panel: an installed/market two-tab workbench. The installed
 * tab groups process-required, local (zip-uploaded and hand-copied into the
 * drawer), and market-installed skills; the market tab browses the single
 * enterprise-vetted SkillHub namespace (the server's marketNamespace, seeded
 * from SKILL_MKTPLAC_NAMESPACE) with install actions. Data comes from the
 * skill-sync governance endpoints on the local webserver; every write reloads
 * the catalog afterwards. Anonymous browsing hides the process-required
 * group; installing, importing, and uninstalling work without sign-in.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  getSkillsCatalog, installSkillhubSkill, importSkillZip, uninstallSkill,
  type CatalogSkill, type SkillCatalog, type SkillSource,
} from './skills-api.ts'
import type { SkillsPanelLocaleKey } from './locales.ts'
import css from './SkillsPanelPage.module.css'

/** Full component props assembled by the main slot renderer. */
export type SkillsPanelPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'enterpriseSkills'>

type Translate = (key: SkillsPanelLocaleKey, params?: Record<string, string>) => string

/** One list row after the local and market halves merge into uniform cards. */
type SkillCard = {
  name: string
  summary: string | null
  version: string | null
  source: SkillSource
  namespace: string | null
  /** Market rows that are not installed yet offer the install action. */
  installable: boolean
}

/** Reads into a page-visible notice; a kind drives the banner's tone. */
type Notice = { kind: 'success' | 'error'; text: string }

/** The two top-level views of the panel. */
type TabKey = 'installed' | 'market'

/** Source → its locale tag key. */
const SOURCE_TAG: Record<SkillSource, SkillsPanelLocaleKey> = {
  required: 'sourceRequired',
  upload: 'sourceUpload',
  skillhub: 'sourceSkillhub',
  manual: 'sourceManual',
}

/** Merges the catalog's local entries and the market namespace into uniform cards, per group. */
function groupCards(catalog: SkillCatalog, query: string): {
  required: SkillCard[]
  local: SkillCard[]
  skillhub: SkillCard[]
  market: SkillCard[]
} {
  const needle = query.trim().toLowerCase()
  const matches = (text: string): boolean => needle === '' || text.toLowerCase().includes(needle)
  const localCard = (entry: SkillCatalog['local'][number]): SkillCard => ({
    name: entry.name,
    summary: entry.description ?? null,
    version: null,
    source: entry.source,
    namespace: null,
    installable: false,
  })
  const marketCard = (item: CatalogSkill): SkillCard => ({
    name: item.slug,
    summary: item.summary ?? null,
    version: item.version ?? null,
    source: item.installed ? item.source ?? 'skillhub' : 'skillhub',
    namespace: item.namespace,
    installable: !item.installed,
  })
  const market = catalog.namespaces.flatMap(group => group.skills).map(marketCard)
  return {
    required: catalog.local.filter(entry => entry.source === 'required' && matches(entry.name)).map(localCard),
    // 本地技能组 = zip 上传 + 手工放入抽屉目录,两组来源 tag 在卡片上区分
    local: catalog.local
      .filter(entry => (entry.source === 'upload' || entry.source === 'manual') && matches(entry.name))
      .map(localCard),
    skillhub: catalog.local.filter(entry => entry.source === 'skillhub' && matches(entry.name)).map(localCard),
    market: market.filter(card => matches(`${card.namespace} ${card.name} ${card.summary ?? ''}`))
      .sort((a, b) => Number(a.installable) - Number(b.installable) || a.name.localeCompare(b.name)),
  }
}

/** One skill card: name, source tag, summary, version, and its action button. */
function SkillRow({ card, t, actionBusy, style, onInstall, onUninstall }: {
  readonly card: SkillCard
  readonly t: Translate
  readonly actionBusy: boolean
  /** 卡片入场 stagger 的 CSS 变量载体(--i)。 */
  readonly style?: CSSProperties
  readonly onInstall: (namespace: string, slug: string) => void
  readonly onUninstall: (name: string) => void
}): ReactNode {
  return (
    <li className={css.card} style={style}>
      <div className={css.cardHead}>
        <span className={css.cardName}>{card.name}</span>
        <span className={`${css.tag} ${css[`source_${card.source}`]}`}>{t(SOURCE_TAG[card.source])}</span>
      </div>
      <p className={css.cardSummary}>{card.summary ?? t('noSummary')}</p>
      <div className={css.cardFoot}>
        {card.version !== null && <span className={css.cardVersion}>{t('versionLabel', { version: card.version })}</span>}
        {card.namespace !== null && <span className={css.cardNamespace}>{card.namespace}</span>}
        {!card.installable && card.source === 'skillhub' && <span className={css.installedTag}>{t('installedTag')}</span>}
        {card.installable
          ? (
            <Button variant="primary" size="sm" disabled={actionBusy}
              aria-label={`${t('install')} ${card.name}`}
              onClick={() => {
                // oxlint-disable-next-line typescript/no-non-null-assertion -- installable 仅对市场条目为真,namespace 为其所属命名空间
                onInstall(card.namespace!, card.name)
              }}>
              {t('install')}
            </Button>
          )
          : card.source !== 'required' && (
            <Button variant="outline" size="sm" disabled={actionBusy}
              aria-label={`${t('uninstall')} ${card.name}`}
              onClick={() => { onUninstall(card.name) }}>
              {t('uninstall')}
            </Button>
          )}
      </div>
    </li>
  )
}

/** The page slot renderer for the Skills panel. */
export function SkillsPanelPage({ t }: SkillsPanelPageProps): ReactNode {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [tab, setTab] = useState<TabKey>('installed')
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** Maps an endpoint failure to user-facing copy naming the reason. */
  const actionErrorText = (error: unknown): string =>
    t('actionFailed', { reason: error instanceof Error ? error.message : String(error) })

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setCatalog(await getSkillsCatalog())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const install = async (namespace: string, slug: string): Promise<void> => {
    setActionBusy(true)
    try {
      await installSkillhubSkill(namespace, slug)
      setNotice({ kind: 'success', text: t('noticeInstalled', { name: slug }) })
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: actionErrorText(error) })
    } finally {
      setActionBusy(false)
    }
  }

  const uninstall = async (name: string): Promise<void> => {
    setActionBusy(true)
    try {
      await uninstallSkill(name)
      setNotice({ kind: 'success', text: t('noticeUninstalled', { name }) })
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: actionErrorText(error) })
    } finally {
      setActionBusy(false)
      setConfirmTarget(null)
    }
  }

  const runImport = async (): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 确认按钮 disabled={importFile === null} 保证导入触发时文件已选
    const file = importFile!
    setImporting(true)
    try {
      const name = await importSkillZip(new Uint8Array(await file.arrayBuffer()))
      setNotice({ kind: 'success', text: t('importSuccess', { name }) })
      setImportOpen(false)
      setImportFile(null)
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: actionErrorText(error) })
    } finally {
      setImporting(false)
    }
  }

  const onFileChosen = (files: FileList | null): void => {
    const file = files?.[0]
    if (file !== undefined) setImportFile(file)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragOver(false)
    onFileChosen(event.dataTransfer.files)
  }

  const groups = useMemo(
    () => catalog === null ? null : groupCards(catalog, query),
    [catalog, query],
  )

  /** 市场条目的安装动作;三组共用同一引用(required/local 卡片无安装按钮)。 */
  const handleInstall = (namespace: string, slug: string): void => {
    void install(namespace, slug)
  }

  const openImport = (): void => {
    setImportFile(null)
    setImportOpen(true)
  }

  /** 渲染一组卡片列表;market 组的 key 带 namespace,其余组用裸名。 */
  const renderSkillCards = (cards: readonly SkillCard[], keyOf: (card: SkillCard) => string): ReactNode => (
    <ul className={css.cards}>
      {cards.map((card, index) => (
        <SkillRow key={keyOf(card)} card={card} t={t} actionBusy={actionBusy}
          style={{ '--i': index } as CSSProperties}
          onInstall={handleInstall}
          onUninstall={setConfirmTarget} />
      ))}
    </ul>
  )

  const authenticated = catalog?.authenticated !== false
  const anonymous = catalog !== null && !catalog.authenticated
  // 匿名视图不含流程要求组(后端已过滤,前端隐藏),计数同步排除
  const installedCount = (authenticated ? groups?.required.length ?? 0 : 0)
    + (groups?.local.length ?? 0) + (groups?.skillhub.length ?? 0)
  // 单一市场 namespace:第一组的 error(404 提示检查配置,其余透传)即市场 tab 级错误
  const marketError = catalog?.namespaces[0]?.error
  const marketCards = groups?.market ?? []

  return (
    <div className={css.page}>
      <header className={css.header}>
        <div>
          <h1 className={css.title}>{t('title')}</h1>
          <p className={css.intro}>{t('intro')}</p>
        </div>
        <div className={css.headerActions}>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => { void load() }}>{t('refresh')}</Button>
          <Button variant="primary" size="sm" onClick={openImport}>{t('importSkill')}</Button>
        </div>
      </header>

      {anonymous && (
        <div className={css.anonymousNotice} role="status">
          <span className={css.anonymousDot} aria-hidden="true" />
          <span>{t('anonymousNotice')}</span>
        </div>
      )}

      {notice !== null && (
        <div className={`${css.notice} ${notice.kind === 'success' ? css.noticeSuccess : css.noticeError}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className={css.noticeDismiss} aria-label={t('close')} onClick={() => { setNotice(null) }}>×</button>
        </div>
      )}

      <div className={css.tabBar} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'installed'}
          className={`${css.tab} ${tab === 'installed' ? css.tabActive : ''}`}
          onClick={() => { setTab('installed') }}>
          {t('tabInstalled')}
          <span className={css.tabCount}>{installedCount}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'market'}
          className={`${css.tab} ${tab === 'market' ? css.tabActive : ''}`}
          onClick={() => { setTab('market') }}>
          {t('tabMarket')}
          <span className={css.tabCount}>{groups?.market.length ?? 0}</span>
        </button>
      </div>

      <Input type="search" className={css.search as string} placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')} value={query}
        onChange={(event) => { setQuery(event.target.value) }} />

      {loading && catalog === null && <p className={css.stateText}>{t('loading')}</p>}
      {loadError !== null && (
        <div className={css.stateBox}>
          <p className={css.stateText}>{t('loadError')}</p>
          <p className={css.stateDetail}>{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => { void load() }}>{t('retry')}</Button>
        </div>
      )}

      {groups !== null && tab === 'installed' && (
        <div className={css.groups} role="tabpanel">
          {authenticated && (
            <section className={css.group} aria-label={t('groupRequired')}>
              <h2 className={css.groupTitle}>{t('groupRequired')}<span className={css.groupCount}>{groups.required.length}</span></h2>
              <p className={css.groupHint}>{t('groupRequiredHint')}</p>
              {groups.required.length === 0
                ? <p className={css.groupEmpty}>{query.trim() === '' ? t('groupRequiredEmpty') : t('emptySearch', { query })}</p>
                : renderSkillCards(groups.required, card => card.name)}
            </section>
          )}

          <section className={css.group} aria-label={t('groupLocal')}>
            <h2 className={css.groupTitle}>{t('groupLocal')}<span className={css.groupCount}>{groups.local.length}</span></h2>
            {groups.local.length === 0
              ? <p className={css.groupEmpty}>{query.trim() === '' ? t('groupLocalEmpty') : t('emptySearch', { query })}</p>
              : renderSkillCards(groups.local, card => card.name)}
          </section>

          <section className={css.group} aria-label={t('groupSkillhub')}>
            <h2 className={css.groupTitle}>{t('groupSkillhub')}<span className={css.groupCount}>{groups.skillhub.length}</span></h2>
            {groups.skillhub.length === 0
              ? <p className={css.groupEmpty}>{query.trim() === '' ? t('groupSkillhubEmpty') : t('emptySearch', { query })}</p>
              : renderSkillCards(groups.skillhub, card => card.name)}
          </section>
        </div>
      )}

      {groups !== null && tab === 'market' && (
        <div className={css.groups} role="tabpanel">
          {!catalog?.catalogOpen
            ? (
              <div className={css.emptyState}>
                <span className={css.emptyGlyph} aria-hidden="true" />
                <p className={css.groupEmpty}>{t('catalogClosed')}</p>
              </div>
            )
            : (
              <>
                {marketError !== undefined && <p className={css.stateText}>{marketError}</p>}
                {marketCards.length === 0 && marketError === undefined
                  ? (
                    <div className={css.emptyState}>
                      <span className={css.emptyGlyph} aria-hidden="true" />
                      <p className={css.groupEmpty}>{query.trim() === '' ? t('marketEmpty') : t('emptySearch', { query })}</p>
                    </div>
                  )
                  : renderSkillCards(marketCards, card => `${card.namespace}:${card.name}`)}
              </>
            )}
        </div>
      )}

      <Modal open={importOpen} onClose={() => { if (!importing) setImportOpen(false) }}
        title={t('importTitle')} closeLabel={t('close')} description={t('importDescription')}
        className={css.importDialog as string}
        footer={importing ? undefined : (
          <>
            <Button variant="outline" onClick={() => { setImportOpen(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={importFile === null} onClick={() => { void runImport() }}>{t('importConfirm')}</Button>
          </>
        )}>
        <div className={`${css.dropZone} ${dragOver ? css.dropActive : ''}`}
          onClick={() => { fileInputRef.current?.click() }}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
          onDragLeave={() => { setDragOver(false) }}
          onDrop={onDrop}
          role="button" tabIndex={0}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click() }}>
          <input ref={fileInputRef} type="file" accept=".zip,application/zip" className={css.fileInput}
            aria-label={t('importChoose')} onChange={(event) => { onFileChosen(event.target.files) }} />
          <p>{importFile === null ? t('importChoose') : t('importSelected', { name: importFile.name })}</p>
          <p className={css.dropHint}>{t('importDropHint')}</p>
        </div>
        {importing && <p className={css.stateText}>{t('importConfirming')}</p>}
      </Modal>

      <Modal open={confirmTarget !== null}
        onClose={() => { if (!actionBusy) setConfirmTarget(null) }}
        title={t('confirmUninstallTitle', { name: confirmTarget ?? '' })}
        closeLabel={t('close')}
        description={t('confirmUninstallDescription')}
        footer={actionBusy ? undefined : (
          <>
            <Button variant="outline" onClick={() => { setConfirmTarget(null) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => {
              // oxlint-disable-next-line typescript/no-non-null-assertion -- 对话框 open={confirmTarget !== null},确认按钮仅在打开时渲染
              void uninstall(confirmTarget!)
            }}>{t('confirmUninstallConfirm')}</Button>
          </>
        )} />
    </div>
  )
}
