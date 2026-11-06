/**
 * 客户端各座位共享的 PPT UI 状态:画廊开合、模板选中、预览/上传/引导对话框。
 *
 * 座位分属不同挂载点(input.left、input.dock 的两个座位),需要一份
 * 跨座位状态;插件内没有宿主注入的 store 通道,按定稿方案用模块级单例
 * store + useSyncExternalStore 桥接。生命周期跟随页面,页面刷新即重置。
 *
 * @module
 */

import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** 当前插入输入框的模板选择(不含前缀文本;前缀见 {@link PptClientState.lastPrefix})。 */
export interface PptTemplateSelection {
  id: string
  name: string
  /** 预览页 URL 的构造模板,chip 缩略图用。 */
  previewUrlTemplate: string
}

/** 客户端共享状态快照。 */
export interface PptClientState {
  /** 模板画廊面板开合。 */
  galleryOpen: boolean
  /** 当前模板 chip 对应的模板;null 表示未选。 */
  selected: PptTemplateSelection | null
  /** 上次插入输入框的 chip 前缀全文,用于换选/移除时精确剥离。 */
  lastPrefix: string | null
  /** 预览查看器打开的模板 id;null 表示关闭。 */
  viewerId: string | null
  /** 上传参考 PPT 对话框开合。 */
  uploadOpen: boolean
  /** Python 环境引导对话框开合。 */
  guideOpen: boolean
  /** 模板清单失效计数:导入/删除/手动刷新后 +1,驱动清单重新拉取。 */
  templatesRev: number
  /** 引导对话框重检通过并关闭后,画廊顶部提示一次"可重新选择"。 */
  guideReadyHint: boolean
}

const initial: PptClientState = {
  galleryOpen: false,
  selected: null,
  lastPrefix: null,
  viewerId: null,
  uploadOpen: false,
  guideOpen: false,
  templatesRev: 0,
  guideReadyHint: false,
}

/** 模块级单例 store(见模块说明)。 */
export const pptStore = createSnapshotStore<PptClientState>(initial)

const subscribePpt = (onChange: () => void): (() => void) => pptStore.subscribe(onChange)

/**
 * 订阅共享状态快照的组件 hook。
 *
 * @returns 当前状态快照。
 */
export function usePptState(): PptClientState {
  return useSyncExternalStore(
    subscribePpt,
    () => pptStore.getSnapshot(),
    () => pptStore.getSnapshot(),
  )
}

/** 开合模板画廊;关闭时顺带清掉引导就绪提示。 */
export function toggleGallery(): void {
  pptStore.update((state) => {
    state.galleryOpen = !state.galleryOpen
    if (!state.galleryOpen) state.guideReadyHint = false
  })
}

/** 关闭模板画廊。 */
export function closeGallery(): void {
  pptStore.update((state) => {
    state.galleryOpen = false
    state.guideReadyHint = false
  })
}

/**
 * 打开指定模板的预览查看器。
 *
 * @param templateId 预览的模板 id。
 */
export function openViewer(templateId: string): void {
  pptStore.update((state) => {
    state.viewerId = templateId
  })
}

/** 关闭预览查看器。 */
export function closeViewer(): void {
  pptStore.update((state) => {
    state.viewerId = null
  })
}

/** 打开上传参考 PPT 对话框。 */
export function openUpload(): void {
  pptStore.update((state) => {
    state.uploadOpen = true
  })
}

/** 关闭上传参考 PPT 对话框。 */
export function closeUpload(): void {
  pptStore.update((state) => {
    state.uploadOpen = false
  })
}

/** 打开 Python 环境引导对话框。 */
export function openGuide(): void {
  pptStore.update((state) => {
    state.guideOpen = true
  })
}

/** 关闭 Python 环境引导对话框。 */
export function closeGuide(): void {
  pptStore.update((state) => {
    state.guideOpen = false
  })
}

/** 模板清单失效:导入/删除/重试后调用,触发清单重新拉取。 */
export function bumpTemplates(): void {
  pptStore.update((state) => {
    state.templatesRev += 1
  })
}

/**
 * 记录模板选择并收起画廊与预览器。
 *
 * @param selection 选中模板(id/名称/预览页 URL 模板)。
 * @param prefix 本次插入输入框的前缀全文;未插入(剥离失败等)时传 null。
 */
export function selectTemplate(selection: PptTemplateSelection, prefix: string | null): void {
  pptStore.update((state) => {
    state.selected = selection
    state.lastPrefix = prefix
    state.galleryOpen = false
    state.viewerId = null
    state.guideReadyHint = false
  })
}

/** 清空模板选择(chip 移除时调用)。 */
export function clearSelection(): void {
  pptStore.update((state) => {
    state.selected = null
    state.lastPrefix = null
  })
}

/** 引导对话框重检通过后标记画廊提示。 */
export function markGuideReadyHint(): void {
  pptStore.update((state) => {
    state.guideReadyHint = true
  })
}
