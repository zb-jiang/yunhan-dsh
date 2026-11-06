/**
 * PPT 设置卡片的 locale 字典(`settings.ppt` 命名空间)。
 *
 * @module
 */

/** 设置卡片与画廊/chip/预览器/上传/引导的全部文案键。 */
export type PptSettingsKey =
  | 'nav'
  | 'sectionIntro'
  | 'backend'
  | 'backendHint'
  | 'backendUnset'
  | 'apiKey'
  | 'apiKeyHint'
  | 'apiKeyKeepPlaceholder'
  | 'baseUrl'
  | 'baseUrlHint'
  | 'model'
  | 'modelHint'
  | 'save'
  | 'saving'
  | 'saved'
  | 'loadError'
  | 'saveError'
  | 'configuredYes'
  | 'configuredNo'
  | 'openGallery'
  | 'chipPrefix'
  | 'chipRemove'
  | 'galleryLoading'
  | 'galleryEmpty'
  | 'galleryLoadError'
  | 'galleryRetry'
  | 'tabAll'
  | 'catBusiness'
  | 'catMarketing'
  | 'catConsulting'
  | 'catAcademic'
  | 'catWork'
  | 'catPersonal'
  | 'originBuiltIn'
  | 'pageCountLabel'
  | 'previewLabel'
  | 'deleteLabel'
  | 'deleteConfirm'
  | 'deleteYes'
  | 'deleteCancel'
  | 'deleteError'
  | 'uploadCard'
  | 'close'
  | 'viewerPrev'
  | 'viewerNext'
  | 'viewerPage'
  | 'viewerUse'
  | 'viewerImageAlt'
  | 'viewerLoadError'
  | 'uploadTitle'
  | 'uploadHint'
  | 'uploadPick'
  | 'slugLabel'
  | 'slugHint'
  | 'nameLabel'
  | 'categoryLabel'
  | 'slugInvalid'
  | 'slugTaken'
  | 'nameRequired'
  | 'fileNotSupported'
  | 'fileTooLarge'
  | 'uploadAction'
  | 'uploading'
  | 'uploadError'
  | 'uploadDone'
  | 'importHint'
  | 'importWorkspacePlaceholder'
  | 'importAction'
  | 'importing'
  | 'importOk'
  | 'importInvalid'
  | 'importConflict'
  | 'importLimit'
  | 'importError'
  | 'guideTitle'
  | 'guideChecking'
  | 'guideCheckError'
  | 'guideReady'
  | 'guideReadyHint'
  | 'guideMissingPython'
  | 'guideBadVersion'
  | 'guideMissingDeps'
  | 'guideDepsHint'
  | 'guideWin'
  | 'guideMac'
  | 'guideCopyPip'
  | 'guideCopied'
  | 'guideRecheck'

/** 英文文案。 */
export const en: Record<PptSettingsKey, string> = {
  nav: 'PPT generation',
  sectionIntro: 'Configure the image backend used by ppt-master when it renders slides. The key is stored on this machine only.',
  backend: 'Image backend',
  backendHint: 'Provider of text-to-image generation; leave unset to let ppt-master fall back to web image search.',
  backendUnset: 'Not configured',
  apiKey: 'API key',
  apiKeyHint: 'Stored locally in the DSH home directory; never sent back to the browser.',
  apiKeyKeepPlaceholder: 'Leave blank to keep the saved key',
  baseUrl: 'Base URL',
  baseUrlHint: 'Optional custom API endpoint (for a proxy or self-hosted gateway).',
  model: 'Model',
  modelHint: 'Image model name the provider expects.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  loadError: 'Failed to load PPT settings',
  saveError: 'Failed to save PPT settings',
  configuredYes: 'Configured',
  configuredNo: 'Not configured',
  openGallery: 'PPT templates',
  chipPrefix: '[Template directive] Use the ppt-master skill and produce every page following the design spec of template "{name}" ({ref}).',
  chipRemove: 'Remove template {name}',
  galleryLoading: 'Loading templates…',
  galleryEmpty: 'No templates yet',
  galleryLoadError: 'Failed to load the template list',
  galleryRetry: 'Retry',
  tabAll: 'All',
  catBusiness: 'Business',
  catMarketing: 'Marketing',
  catConsulting: 'Consulting',
  catAcademic: 'Academic',
  catWork: 'Work',
  catPersonal: 'Personal',
  originBuiltIn: 'Built-in',
  pageCountLabel: '{count} pages',
  previewLabel: 'Preview {name}',
  deleteLabel: 'Delete {name}',
  deleteConfirm: 'Delete for sure?',
  deleteYes: 'Yes, delete',
  deleteCancel: 'Cancel',
  deleteError: 'Failed to delete the template',
  uploadCard: 'Add template',
  close: 'Close',
  viewerPrev: 'Previous page',
  viewerNext: 'Next page',
  viewerPage: '{current} / {total}',
  viewerUse: 'Use this template',
  viewerImageAlt: 'Preview page of {name}',
  viewerLoadError: 'Preview image failed to load',
  uploadTitle: 'Add a template from a reference PPT',
  uploadHint: 'The AI distills the reference into a new style following the ppt-master style contract. Pick a .pptx or .pdf (≤50MB), set the style slug, display name and category.',
  uploadPick: 'Choose file',
  slugLabel: 'Style slug',
  slugHint: 'Lowercase letters, digits and hyphens; starts with a letter, 3–64 characters. Becomes the style_id.',
  nameLabel: 'Display name',
  categoryLabel: 'Category',
  slugInvalid: 'The slug must be 3–64 characters of lowercase letters, digits and hyphens, starting with a letter',
  slugTaken: 'This slug is already used by another template',
  nameRequired: 'Enter a display name',
  fileNotSupported: 'Only .pptx and .pdf files are supported',
  fileTooLarge: 'The file exceeds the 50MB limit',
  uploadAction: 'Upload and build the extraction prompt',
  uploading: 'Uploading…',
  uploadError: 'Upload failed',
  uploadDone: 'The extraction prompt is in the input box. Close this dialog, send that message to let the AI distill, then reopen this dialog (Add template card) to register.',
  importHint: 'After distilling, paste the workspace path that contains the ppt-template/ output to register the style.',
  importWorkspacePlaceholder: 'Paste the workspace path',
  importAction: 'Register template',
  importing: 'Registering…',
  importOk: 'Registered — the style is now in the gallery.',
  importInvalid: 'No valid style output in that workspace (a contract-conformant design_spec.md is required)',
  importConflict: 'That style slug already exists — pick another one',
  importLimit: 'Added templates are limited to 10 — delete one first',
  importError: 'Registration failed',
  guideTitle: 'Python environment setup',
  guideChecking: 'Checking the Python environment…',
  guideCheckError: 'The Python check failed',
  guideReady: 'The Python environment is ready — select a template again.',
  guideReadyHint: 'The Python environment is ready — selecting a template now works.',
  guideMissingPython: 'No Python 3.10–3.14 interpreter was found.',
  guideBadVersion: 'Found {version}, outside the supported 3.10–3.14 range.',
  guideMissingDeps: 'Missing packages: {packages}',
  guideDepsHint: 'Run the command below to install the missing packages, then re-check:',
  guideWin: 'Windows: install Python 3.10–3.14 from python.org with "Add python.exe to PATH" checked, then come back and re-check.',
  guideMac: 'macOS: install Python 3.10–3.14 (e.g. brew install python@3.12), then come back and re-check.',
  guideCopyPip: 'Copy pip command',
  guideCopied: 'Copied',
  guideRecheck: 'Installed — re-check',
}

/** 中文文案。 */
export const zh: Record<PptSettingsKey, string> = {
  nav: 'PPT 生成',
  sectionIntro: '配置 ppt-master 渲染幻灯片时使用的生图后端。API Key 只保存在本机。',
  backend: '生图后端',
  backendHint: '文生图服务提供商;不配置时 ppt-master 走自带的网络图搜/无图降级。',
  backendUnset: '未配置',
  apiKey: 'API Key',
  apiKeyHint: '保存在 DSH 主目录,任何页面都不会回显明文。',
  apiKeyKeepPlaceholder: '留空保持已保存的 Key',
  baseUrl: 'Base URL',
  baseUrlHint: '可选的自定义 API 端点(代理或自建网关)。',
  model: '模型',
  modelHint: '生图后端使用的模型名。',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  loadError: 'PPT 设置读取失败',
  saveError: 'PPT 设置保存失败',
  configuredYes: '已配置',
  configuredNo: '未配置',
  openGallery: 'PPT模板库',
  chipPrefix: '【模板指令】使用 ppt-master 技能,按模板「{name}」({ref})的设计规格制作全部页面。',
  chipRemove: '移除模板 {name}',
  galleryLoading: '正在加载模板…',
  galleryEmpty: '还没有模板',
  galleryLoadError: '模板清单读取失败',
  galleryRetry: '重试',
  tabAll: '全部',
  catBusiness: '商务',
  catMarketing: '市场',
  catConsulting: '咨询',
  catAcademic: '学术',
  catWork: '工作',
  catPersonal: '个人',
  originBuiltIn: '内置',
  pageCountLabel: '{count} 页',
  previewLabel: '预览 {name}',
  deleteLabel: '删除 {name}',
  deleteConfirm: '确认删除?',
  deleteYes: '确认',
  deleteCancel: '取消',
  deleteError: '模板删除失败',
  uploadCard: '新增模板',
  close: '关闭',
  viewerPrev: '上一页',
  viewerNext: '下一页',
  viewerPage: '{current} / {total}',
  viewerUse: '用这个模板生成',
  viewerImageAlt: '{name} 的预览页',
  viewerLoadError: '预览图加载失败',
  uploadTitle: '从参考 PPT 新增模板',
  uploadHint: 'AI 会按 ppt-master 的 style 契约把参考文件提炼成一套新 style。选择 .pptx 或 .pdf(≤50MB),并填写 style slug、显示名与分类。',
  uploadPick: '选择文件',
  slugLabel: 'Style slug',
  slugHint: '小写字母、数字和中划线,字母开头,3–64 个字符;将作为 style_id。',
  nameLabel: '显示名',
  categoryLabel: '分类',
  slugInvalid: 'slug 只能是 3–64 个小写字母、数字和中划线,且以字母开头',
  slugTaken: '该 slug 已被其他模板使用',
  nameRequired: '请填写显示名',
  fileNotSupported: '只支持 .pptx 和 .pdf 文件',
  fileTooLarge: '文件超过 50MB 上限',
  uploadAction: '上传并生成提炼指令',
  uploading: '上传中…',
  uploadError: '上传失败',
  uploadDone: '提炼指令已写入输入框。请关闭对话框并发送该消息让 AI 提炼;完成后点「新增模板」卡片重新打开本对话框完成登记。',
  importHint: '提炼完成后,把产出 ppt-template/ 目录的工作空间路径粘贴到这里完成登记。',
  importWorkspacePlaceholder: '粘贴工作空间路径',
  importAction: '登记模板',
  importing: '登记中…',
  importOk: '登记成功,新 style 已进入模板库。',
  importInvalid: '该工作空间没有合法的 style 产物(需要符合契约的 design_spec.md)',
  importConflict: '该 slug 已存在,请换一个',
  importLimit: '新增模板已达 10 套上限,请先删除',
  importError: '登记失败',
  guideTitle: 'Python 环境配置',
  guideChecking: '正在检测 Python 环境…',
  guideCheckError: 'Python 环境检测失败',
  guideReady: 'Python 环境就绪,可以重新选择模板。',
  guideReadyHint: 'Python 环境已就绪,重新选择模板即可使用。',
  guideMissingPython: '未检测到 Python 3.10–3.14 解释器。',
  guideBadVersion: '检测到 {version},超出支持的 3.10–3.14 区间。',
  guideMissingDeps: '缺少依赖:{packages}',
  guideDepsHint: '运行下方命令安装缺失的依赖,完成后重新检测:',
  guideWin: 'Windows:从 python.org 安装 Python 3.10–3.14,勾选「Add python.exe to PATH」,装完后回来重新检测。',
  guideMac: 'macOS:安装 Python 3.10–3.14(如 brew install python@3.12),装完后回来重新检测。',
  guideCopyPip: '复制 pip 命令',
  guideCopied: '已复制',
  guideRecheck: '我已装完,重新检测',
}
