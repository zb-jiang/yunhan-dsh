// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { SkillsPanelPage, type SkillsPanelPageProps } from '../src/client/SkillsPanelPage.tsx'
import { en, type SkillsPanelLocaleKey } from '../src/client/locales.ts'
import type { SkillCatalog } from '../src/client/skills-api.ts'

usePinnedBrowserLanguages('en')
afterEach(cleanup)

/** 与 PropsLocale 同签名的英文字典翻译。 */
const t: SkillsPanelPageProps['t'] = ((key: SkillsPanelLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as SkillsPanelPageProps['t']

/** 构造 JSON Response。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 目录快照:流程要求 1、本地技能 3(上传 2 含无描述条目 + 手工放入 1)、市场安装
 * (skillhub 来源)1、市场已装 2(含无 summary/source 与无 version 条目)+ 未装 2。
 * 空缺字段用于覆盖卡片渲染的空值回退分支。
 */
function catalogFixture(overrides: Partial<SkillCatalog> = {}): SkillCatalog {
  return {
    authenticated: true,
    catalogOpen: true,
    namespaces: [{
      namespace: 'dsh-demo',
      skills: [
        { namespace: 'dsh-demo', slug: 'hub-installed', fingerprint: 'f1', downloadUrl: '/d1', version: '1.0.0', summary: 'Market summary', installed: true, source: 'skillhub' },
        { namespace: 'dsh-demo', slug: 'hub-legacy', fingerprint: 'f3', downloadUrl: '/d3', version: '0.9.0', installed: true },
        { namespace: 'dsh-demo', slug: 'hub-open', fingerprint: 'f2', downloadUrl: '/d2', version: '2.0.0', summary: 'Open summary', installed: false },
        { namespace: 'dsh-demo', slug: 'hub-alpha', fingerprint: 'f4', downloadUrl: '/d4', summary: 'Alpha summary', installed: false },
      ],
    }],
    local: [
      { name: 'flow-report', source: 'required', namespace: 'dsh-demo', description: 'Required description' },
      { name: 'my-skill', source: 'upload', description: 'Uploaded description' },
      { name: 'bare-skill', source: 'upload' },
      { name: 'hand-made', source: 'manual', description: 'Hand-copied description' },
      { name: 'hub-installed', source: 'skillhub', namespace: 'dsh-demo' },
    ],
    ...overrides,
  }
}

/** 渲染页面 props 只取 t(组件不解构其余 slot share)。 */
function renderPage() {
  return render(<SkillsPanelPage {...({ t } as SkillsPanelPageProps)} />)
}

/** 切到市场目录 tab(tab 可访问名含计数徽标文本,用正则前缀匹配)。 */
const openMarketTab = (): void => {
  fireEvent.click(screen.getByRole('tab', { name: /Market catalog/ }))
}

/** 切回已安装 tab。 */
const openInstalledTab = (): void => {
  fireEvent.click(screen.getByRole('tab', { name: /Installed/ }))
}

describe('SkillsPanelPage', () => {
  const fetchMock = vi.fn<(input: URL | string, init?: RequestInit) => Promise<Response>>()

  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('加载后渲染双 tab:已安装 tab 三分组(流程要求无操作/本地与市场安装可卸载),市场 tab 已装可卸载/未装可安装', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    expect(await screen.findByText('Required description')).toBeTruthy()
    expect(screen.getByText('Uploaded description')).toBeTruthy()
    // 手工放入的抽屉技能与本地上传同组展示,tag 区分来源,同样可卸载
    expect(screen.getByText('Hand-copied description')).toBeTruthy()
    expect(screen.getByText('Hand-copied')).toBeTruthy()
    // 市场卡片在另一个 tab,未切换时不可见
    expect(screen.queryByText('Market summary')).toBeNull()
    // 版本与来源标签(installed tab:required tag + 无描述回退:上传 bare-skill 与 skillhub 组 hub-installed)
    expect(screen.getAllByText('Process-required').length).toBeGreaterThan(0)
    // 流程要求卡片没有卸载按钮(卸载按钮带 aria-label);本地与市场安装组可卸载
    expect(screen.queryByLabelText('Uninstall flow-report')).toBeNull()
    expect(screen.getByLabelText('Uninstall my-skill')).toBeTruthy()
    expect(screen.getByLabelText('Uninstall bare-skill')).toBeTruthy()
    expect(screen.getByLabelText('Uninstall hand-made')).toBeTruthy()
    expect(screen.getByLabelText('Uninstall hub-installed')).toBeTruthy()
    expect(screen.getAllByText('No description').length).toBe(2)
    // 切到市场目录 tab:已装可卸载、未装可安装、空值回退
    openMarketTab()
    expect(screen.getByText('Market summary')).toBeTruthy()
    expect(screen.getByText('Open summary')).toBeTruthy()
    expect(screen.getByText('Version 1.0.0')).toBeTruthy()
    expect(screen.getByText('Version 0.9.0')).toBeTruthy()
    expect(screen.getByLabelText('Uninstall hub-installed')).toBeTruthy()
    expect(screen.getByLabelText('Uninstall hub-legacy')).toBeTruthy()
    expect(screen.getByLabelText('Install hub-open')).toBeTruthy()
    expect(screen.getByLabelText('Install hub-alpha')).toBeTruthy()
    expect(screen.getAllByText('No description').length).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('加载失败显示错误与重试,重试成功后恢复列表', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    renderPage()
    expect(await screen.findByText('Unable to load the skill list')).toBeTruthy()
    expect(screen.getByText('offline')).toBeTruthy()
    // 非 Error 拒绝以 String 化结果展示
    fetchMock.mockRejectedValueOnce('boom')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('boom')).toBeTruthy()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogFixture()))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Required description')).toBeTruthy()
  })

  it('搜索过滤当前 tab 的分组并显示未匹配空态', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    const search = screen.getByLabelText('Search skills')
    fireEvent.change(search, { target: { value: 'flow' } })
    expect(screen.getByText('flow-report')).toBeTruthy()
    expect(screen.queryByText('my-skill')).toBeNull()
    // 市场目录 tab 同一搜索框:'flow' 无匹配 → 市场空态
    openMarketTab()
    expect(screen.getByText('No skills match "flow"')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'nope' } })
    // 已安装 tab 三组(required/local/skillhub)各一个空态 + 市场目录一个空态
    openInstalledTab()
    expect(screen.getAllByText('No skills match "nope"').length).toBe(3)
    openMarketTab()
    expect(screen.getAllByText('No skills match "nope"').length).toBe(1)
  })

  it('市场未开放时在市场 tab 显示说明文案', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture({ catalogOpen: false, namespaces: [] })))
    renderPage()
    await screen.findByText('Required description')
    openMarketTab()
    expect(await screen.findByText(/The market is not enabled/)).toBeTruthy()
  })

  it('匿名目录:显示未登录横幅,隐藏流程要求组,本地/市场安装照常可卸载', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture({ authenticated: false })))
    renderPage()
    expect(await screen.findByText('Not signed in: process-required skills are hidden; other skills can be browsed, installed, and uninstalled')).toBeTruthy()
    // required 条目与分组都不渲染;本地与市场安装组照常
    expect(screen.queryByText('Required description')).toBeNull()
    expect(screen.queryByText('Process-required')).toBeNull()
    expect(screen.getByText('Uploaded description')).toBeTruthy()
    expect(screen.getByLabelText('Uninstall my-skill')).toBeTruthy()
    expect(screen.getByLabelText('Uninstall hand-made')).toBeTruthy()
    expect(screen.getByLabelText('Uninstall hub-installed')).toBeTruthy()
    // 市场照常可浏览,安装按钮可用(端点匿名可装)
    openMarketTab()
    expect(screen.getByText('Open summary')).toBeTruthy()
    expect(screen.getByLabelText('Install hub-open')).toBeTruthy()
  })

  it('卸载流程:确认对话框 → 端点调用 → 成功提示并刷新', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    fireEvent.click(screen.getByLabelText('Uninstall my-skill'))
    expect(screen.getByText('Uninstall "my-skill"?')).toBeTruthy()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogFixture()))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    await screen.findByText('Uninstalled skill my-skill')
    const calls = fetchMock.mock.calls.filter(([input]) => input === 'api/enterprise/skills/uninstall')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]?.body).toBe(JSON.stringify({ slug: 'my-skill' }))
  })

  it('卸载失败在横幅显示原因', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    fireEvent.click(screen.getByLabelText('Uninstall my-skill'))
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'engine down' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    await screen.findByText('Operation failed: engine down')
    // 403 失败照常显示原因(端点 error 字段被提取为原因)
    fireEvent.click(screen.getByLabelText('Uninstall my-skill'))
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'process-required' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    await screen.findByText('Operation failed: process-required')
    // 非 Error 拒绝同样以 String 化结果展示
    fireEvent.click(screen.getByLabelText('Uninstall my-skill'))
    fetchMock.mockRejectedValueOnce('boom')
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    await screen.findByText('Operation failed: boom')
  })

  it('安装流程:市场 tab 点击未装条目 → 端点调用 → 成功提示并刷新', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    openMarketTab()
    expect(screen.getByText('Open summary')).toBeTruthy()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { alreadyInstalled: false }))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogFixture()))
    fireEvent.click(screen.getByLabelText('Install hub-open'))
    await screen.findByText('Installed skill hub-open')
    const calls = fetchMock.mock.calls.filter(([input]) => input === 'api/enterprise/skills/install')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]?.body).toBe(JSON.stringify({ namespace: 'dsh-demo', slug: 'hub-open' }))
  })

  it('安装失败在横幅显示原因', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    openMarketTab()
    expect(screen.getByText('Open summary')).toBeTruthy()
    fetchMock.mockRejectedValueOnce(new Error('install down'))
    fireEvent.click(screen.getByLabelText('Install hub-open'))
    await screen.findByText('Operation failed: install down')
    // 非 Error 拒绝以 String 化结果展示
    fetchMock.mockRejectedValueOnce('boom')
    fireEvent.click(screen.getByLabelText('Install hub-alpha'))
    await screen.findByText('Operation failed: boom')
  })

  it('市场 tab:namespace 不存在时显示检查配置错误,存在但为空时显示空态', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture({
      namespaces: [
        { namespace: 'ghost-ns', error: "命名空间 'ghost-ns' 在 SkillHub 上不存在,请检查 SKILL_MKTPLAC_NAMESPACE 配置", skills: [] },
      ],
    })))
    renderPage()
    await screen.findByText('Required description')
    openMarketTab()
    // 404 错误显示组级错误,不显示空态
    expect(await screen.findByText(/SkillHub 上不存在/)).toBeTruthy()
    expect(screen.queryByText('No published skills in this namespace yet')).toBeNull()
    // 命名空间存在但清单为空 → 空态
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogFixture({
      namespaces: [{ namespace: 'dsh-demo', skills: [] }],
    })))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('No published skills in this namespace yet')).toBeTruthy()
  })

  it('导入流程:打开对话框 → 选择文件 → 导入成功后关闭并刷新', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    fireEvent.click(screen.getByRole('button', { name: 'Import skill' }))
    expect(await screen.findByText('Upload a skill zip package')).toBeTruthy()
    // 拖拽与选择两条路径都写入文件
    const dropZone = screen.getByText('Choose a zip file').closest('div')!
    const file = new File(['PK'], 'skill.zip', { type: 'application/zip' })
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })
    expect(screen.getByText('Selected: skill.zip')).toBeTruthy()
    // 拖拽高亮分支
    fireEvent.dragOver(dropZone)
    fireEvent.dragLeave(dropZone)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'my-skill' }))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogFixture()))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText('Imported skill my-skill')
    expect(fetchMock.mock.calls.some(([input]) => input === 'api/enterprise/skills/import')).toBe(true)
    await waitFor(() => { expect(screen.queryByText('Upload a skill zip package')).toBeNull() })
  })

  it('导入失败在横幅显示原因,对话框保持打开', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    fireEvent.click(screen.getByRole('button', { name: 'Import skill' }))
    await screen.findByText('Upload a skill zip package')
    const dropZone = screen.getByText('Choose a zip file').closest('div')!
    const file = new File(['PK'], 'skill.zip', { type: 'application/zip' })
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'duplicate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText('Operation failed: duplicate')
    expect(screen.getByText('Upload a skill zip package')).toBeTruthy()
    // 非 Error 拒绝同样以 String 化结果展示,文件仍保持已选
    fetchMock.mockRejectedValueOnce('boom')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText('Operation failed: boom')
    expect(screen.getByText('Upload a skill zip package')).toBeTruthy()
  })

  it('横幅可关闭;键盘 Enter 打开文件选择;刷新按钮重新拉取', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    fireEvent.click(screen.getByLabelText('Uninstall my-skill'))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogFixture()))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    await screen.findByText('Uninstalled skill my-skill')
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByText('Uninstalled skill my-skill')).toBeNull()
    // 键盘 Enter 走 dropZone 的 keydown 分支(不打开系统选择器,只验证不抛错)
    const dropZoneButton = screen.getByText('Import skill')
    fireEvent.click(dropZoneButton)
    await screen.findByText('Upload a skill zip package')
    const dropZone = screen.getByText('Choose a zip file').closest('div')!
    fireEvent.keyDown(dropZone, { key: 'Enter' })
    fireEvent.keyDown(dropZone, { key: 'Escape' })
    // 刷新按钮重新拉取目录
    fetchMock.mockResolvedValueOnce(jsonResponse(200, catalogFixture()))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(fetchMock.mock.calls.filter(([input]) => input === 'api/enterprise/skills/catalog').length).toBeGreaterThanOrEqual(2) })
  })

  it('目录为空时:已安装 tab 三组空态,市场 tab 空态', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture({ local: [], namespaces: [] })))
    renderPage()
    expect(await screen.findByText('No process-required skills yet')).toBeTruthy()
    expect(screen.getByText('No local skills yet. Click "Import skill" to upload a zip package, or copy a skill folder into DSH_HOME/skills')).toBeTruthy()
    expect(screen.getByText('No market-installed skills yet')).toBeTruthy()
    openMarketTab()
    expect(screen.getByText('No published skills in this namespace yet')).toBeTruthy()
  })

  it('导入对话框:空拖拽不写入,input 选择写入,空闲可关,导入中阻止关闭', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    fireEvent.click(screen.getByRole('button', { name: 'Import skill' }))
    expect(await screen.findByText('Upload a skill zip package')).toBeTruthy()
    const dropZone = screen.getByText('Choose a zip file').closest('div')!
    // 空文件列表 drop 不改状态
    fireEvent.drop(dropZone, { dataTransfer: { files: [] } })
    expect(screen.queryByText(/Selected:/)).toBeNull()
    // 文件选择 input 的 onChange 路径写入文件
    fireEvent.change(screen.getByLabelText('Choose a zip file'), {
      target: { files: [new File(['PK'], 'picked.zip', { type: 'application/zip' })] },
    })
    expect(screen.getByText('Selected: picked.zip')).toBeTruthy()
    // 空闲时 header Close 关闭
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => { expect(screen.queryByText('Upload a skill zip package')).toBeNull() })
    // 重开后 Cancel 按钮关闭
    fireEvent.click(screen.getByRole('button', { name: 'Import skill' }))
    await screen.findByText('Upload a skill zip package')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => { expect(screen.queryByText('Upload a skill zip package')).toBeNull() })
    // 再开后导入进行中:footer 消失,header Close 不关闭
    fireEvent.click(screen.getByRole('button', { name: 'Import skill' }))
    await screen.findByText('Upload a skill zip package')
    const dropZone2 = screen.getByText('Choose a zip file').closest('div')!
    fireEvent.drop(dropZone2, { dataTransfer: { files: [new File(['PK'], 'late.zip', { type: 'application/zip' })] } })
    let resolveImport!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveImport = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('Importing…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByText('Upload a skill zip package')).toBeTruthy()
    resolveImport(jsonResponse(200, { name: 'late' }))
    await screen.findByText('Imported skill late')
  })

  it('卸载对话框:Cancel 与空闲 Close 关闭,busy 中 Close 阻止关闭', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, catalogFixture()))
    renderPage()
    await screen.findByText('Required description')
    fireEvent.click(screen.getByLabelText('Uninstall my-skill'))
    expect(screen.getByText('Uninstall "my-skill"?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => { expect(screen.queryByText('Uninstall "my-skill"?')).toBeNull() })
    // 空闲时 header Close 关闭
    fireEvent.click(screen.getByLabelText('Uninstall my-skill'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => { expect(screen.queryByText('Uninstall "my-skill"?')).toBeNull() })
    // busy 中:footer 消失,header Close 不关闭
    fireEvent.click(screen.getByLabelText('Uninstall my-skill'))
    let resolveUninstall!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveUninstall = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByText('Uninstall "my-skill"?')).toBeTruthy()
    resolveUninstall(jsonResponse(200, {}))
    await screen.findByText('Uninstalled skill my-skill')
  })
})
