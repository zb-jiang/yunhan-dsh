/** Global-rules settings section: edit the user-global instruction file injected into every session. */
import { useEffect, useState } from 'react'
import { Button, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GlobalInstructionsValue } from '@deepseek-ai/dsh-api-remotes/client'
import type { GlobalRulesReadOutcome, GlobalRulesWriteOutcome } from './operations.ts'
import css from './GlobalRulesSection.module.css'

/** Settings actions wired to the settings-controller remotes. */
export interface GlobalRulesSectionInjected {
  read: () => Promise<GlobalRulesReadOutcome>
  write: (content: string) => Promise<GlobalRulesWriteOutcome>
}

/** Props assembled by the settings renderer. */
export type GlobalRulesSectionProps =
  PropsRuntime<'settings.section'> &
  PropsLocale<'settings.globalRules'> &
  InjectFace<GlobalRulesSectionInjected>

/** UTF-8 byte length of `text`. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Render the editor for `~/.dsh/AGENTS.md` with its usage meter and save action.
 * @param props Remote operations and localized text.
 * @returns The global-rules settings section.
 */
export function GlobalRulesSection({ read, write, t }: GlobalRulesSectionProps) {
  const [view, setView] = useState<GlobalInstructionsValue | null>(null)
  const [text, setText] = useState('')
  const [loadMessage, setLoadMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ readonly tone: 'saved' | 'error'; readonly text: string } | null>(null)

  useEffect(() => {
    let active = true
    void read().then((outcome) => {
      if (!active) return
      if (outcome.kind === 'loaded') {
        setView(outcome.view)
        setText(outcome.view.content)
        setLoadMessage(null)
      } else {
        setLoadMessage(outcome.message)
      }
    })
    return () => { active = false }
  }, [read])

  const reload = (): void => {
    setLoadMessage(null)
    void read().then((outcome) => {
      if (outcome.kind === 'loaded') {
        setView(outcome.view)
        setText(outcome.view.content)
      } else {
        setLoadMessage(outcome.message)
      }
    })
  }

  const save = (): void => {
    setSaving(true)
    setNotice(null)
    void write(text).then((outcome) => {
      setSaving(false)
      if (outcome.kind === 'written') {
        setView(outcome.view)
        setText(outcome.view.content)
        setNotice({ tone: 'saved', text: t('saved') })
        return
      }
      setNotice({
        tone: 'error',
        text: outcome.kind === 'too-large' ? `${t('saveTooLarge')} ${outcome.message}` : `${t('saveFailed')} ${outcome.message}`,
      })
    })
  }

  const dirty = view !== null && text !== view.content
  const maxBytes = view?.maxBytes
  const usedBytes = utf8Length(text)
  const overBudget = maxBytes !== undefined && usedBytes > maxBytes
  const failed = loadMessage !== null
  return <section className={css.section}>
    <h2 className={css.title}>{t('nav')}</h2>
    <p className={css.intro}>{t('intro')}</p>
    {failed
      ? <p className={css.error} role="alert">
        {t('loadFailed')} {loadMessage}
        <Button variant="ghost" onClick={reload}>{t('reload')}</Button>
      </p>
      : null}
    {view === null
      ? null
      : <>
        <div className={css.pathRow}>
          <span className={css.pathCaption}>{t('pathLabel')}</span>
          <PathLabel path={`${view.homeDisplay}/AGENTS.md`} />
          {view.exists ? null : <span className={css.pathAbsent}>{t('notCreated')}</span>}
        </div>
        <textarea
          className={css.editor}
          aria-label={t('editorLabel')}
          placeholder={t('editorPlaceholder')}
          value={text}
          spellCheck={false}
          onChange={(event) => { setText(event.target.value); setNotice(null) }}
        />
        <div className={css.meterRow}>
          {maxBytes === undefined
            ? null
            : <span className={overBudget ? css.meterOver : css.meter} role={overBudget ? 'alert' : undefined}>
              {overBudget
                ? t('overBudget', { bytes: usedBytes, maxBytes })
                : t('usage', { bytes: usedBytes, maxBytes })}
            </span>}
        </div>
        <div className={css.footer}>
          <Button variant="primary" disabled={!dirty || saving} onClick={save}>
            {saving ? t('saving') : t('save')}
          </Button>
          {notice === null
            ? null
            : <span className={notice.tone === 'saved' ? css.saved : css.error} role={notice.tone === 'error' ? 'alert' : undefined}>
              {notice.text}
            </span>}
        </div>
      </>}
  </section>
}
