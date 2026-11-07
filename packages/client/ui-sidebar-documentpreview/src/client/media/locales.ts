/** Locale-owned audio and video renderer labels and status text. */
export const zh = {
  'title.audio': '音频',
  'title.video': '视频',
  'label.audio': '音频播放器：{name}',
  'label.video': '视频播放器：{name}',
  loading: '文档渲染中...',
  failed: '无法播放这个文件',
  'failed.tooLarge': '文件超过预览大小上限，无法整段加载',
  'failed.missing': '文件不存在或已被移动',
  'failed.forbidden': '没有访问这个文件的权限',
  unsupported: '媒体预览需要文件的 Host 路径',
  retry: '重试',
} satisfies Record<string, string>

/** Media renderer dictionary keys. */
export type MediaPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  'title.audio': 'Audio',
  'title.video': 'Video',
  'label.audio': 'Audio player: {name}',
  'label.video': 'Video player: {name}',
  loading: 'Rendering document...',
  failed: 'This file could not be played.',
  'failed.tooLarge': 'This file exceeds the preview size limit and cannot be loaded whole.',
  'failed.missing': 'This file does not exist or has been moved.',
  'failed.forbidden': 'Access to this file is not permitted.',
  unsupported: 'Media preview requires the file\'s Host path.',
  retry: 'Retry',
} satisfies Record<MediaPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Audio and video preview selection, accessible name, and status text. */
    sidebarMedia: MediaPreviewKey
  }
}
