// @vitest-environment jsdom
/** Global-rules section rendering: load, save, failure recovery, and the injection-budget meter. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalInstructionsValue } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { GlobalRulesSection } from '../src/client/GlobalRulesSection.tsx'
import type { GlobalRulesReadOutcome, GlobalRulesSectionProps, GlobalRulesWriteOutcome } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
type Read = () => Promise<GlobalRulesReadOutcome>
type Write = (content: string) => Promise<GlobalRulesWriteOutcome>

afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** One Host view of the user-global instructions file; `maxBytes` is present only when a budget is configured. */
function makeView(options: {
  readonly content?: string
  readonly exists?: boolean
  readonly maxBytes?: number
} = {}): GlobalInstructionsValue {
  const view: GlobalInstructionsValue = {
    path: '/home/user/.dsh/AGENTS.md',
    homeDisplay: '~/.dsh',
    exists: options.exists ?? true,
    content: options.content ?? '# Standing rules\n',
  }
  if (options.maxBytes !== undefined) return { ...view, maxBytes: options.maxBytes }
  return view
}

/** Render the section with the framework-standard props stubbed. */
function renderSection(read: Read, write: Write): void {
  const props: GlobalRulesSectionProps = {
    ...({} as GlobalStandardProps),
    close: () => {},
    read,
    write,
    t,
  }
  render(<GlobalRulesSection {...props} />)
}

it('renders an empty editor for a not-yet-created file', async () => {
  renderSection(
    vi.fn<Read>().mockResolvedValue({ kind: 'loaded', view: makeView({ exists: false, content: '' }) }),
    vi.fn<Write>(),
  )
  const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: t('editorLabel') })
  expect(editor.value).toBe('')
  expect(screen.getByText(t('notCreated'))).toBeTruthy()
  expect(screen.getByTitle('~/.dsh/AGENTS.md')).toBeTruthy()
  expect(screen.getByText('AGENTS.md')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: t('save') }).disabled).toBe(true)
})

it('saves edited content, reports success, and resets the dirty baseline', async () => {
  const write = vi.fn<Write>().mockResolvedValue({ kind: 'written', view: makeView({ content: '# Changed\n' }) })
  renderSection(vi.fn<Read>().mockResolvedValue({ kind: 'loaded', view: makeView() }), write)
  const save = await screen.findByRole<HTMLButtonElement>('button', { name: t('save') })
  expect(save.disabled).toBe(true)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: t('editorLabel') })
  fireEvent.change(editor, { target: { value: '# Changed\n' } })
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  await screen.findByText(t('saved'))
  expect(write).toHaveBeenCalledExactlyOnceWith('# Changed\n')
  // The saved view becomes the new baseline, so the editor reads as clean again.
  expect(save.disabled).toBe(true)
})

it('reports a failed load and recovers through Reload', async () => {
  const read = vi.fn<Read>()
    .mockResolvedValueOnce({ kind: 'failed', message: 'offline' })
    .mockResolvedValue({ kind: 'loaded', view: makeView() })
  renderSection(read, vi.fn<Write>())
  const alert = await screen.findByRole('alert')
  // The failure paragraph embeds the Reload button, so its text runs past the message.
  expect(alert.textContent).toContain(`${t('loadFailed')} offline`)
  fireEvent.click(screen.getByRole('button', { name: t('reload') }))
  const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: t('editorLabel') })
  expect(editor.value).toBe('# Standing rules\n')
  expect(read).toHaveBeenCalledTimes(2)
})

it('reports an over-ceiling write as too large', async () => {
  const write = vi.fn<Write>().mockResolvedValue({ kind: 'too-large', message: 'too large' })
  renderSection(vi.fn<Read>().mockResolvedValue({ kind: 'loaded', view: makeView() }), write)
  const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: t('editorLabel') })
  fireEvent.change(editor, { target: { value: '# Changed\n' } })
  fireEvent.click(screen.getByRole('button', { name: t('save') }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe(`${t('saveTooLarge')} too large`)
})

it('warns when the editor exceeds the injection budget but keeps saving allowed', async () => {
  renderSection(
    vi.fn<Read>().mockResolvedValue({ kind: 'loaded', view: makeView({ exists: false, content: '', maxBytes: 4 }) }),
    vi.fn<Write>(),
  )
  await screen.findByText(t('usage', { bytes: 0, maxBytes: 4 }))
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: t('editorLabel') })
  fireEvent.change(editor, { target: { value: '12345' } })
  expect(screen.getByRole('alert').textContent).toBe(t('overBudget', { bytes: 5, maxBytes: 4 }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: t('save') }).disabled).toBe(false)
})
