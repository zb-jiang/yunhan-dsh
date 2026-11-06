/**
 * 模板清单拉取 hook 与 Python 就绪探测。
 *
 * 清单以 {@link pptStore} 的 templatesRev 为失效信号:导入/删除/重试后
 * 计数变化即重新拉取。fetch 路径沿用宿主 webserver 的相对前缀
 * (无前导斜杠),与设置卡片一致。
 *
 * @module
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { pptStore } from './pptState.ts'

/** 模板分类(与宿主 listTemplates 的 category 枚举一致)。 */
export type PptTemplateCategory = 'business' | 'marketing' | 'consulting' | 'academic' | 'work' | 'personal'

/** 模板清单项(与宿主 GET api/ppt/templates 的响应项一致)。 */
export interface PptTemplateItem {
  /** style_id,出厂与用户新增全域唯一。 */
  id: string
  name: string
  category: PptTemplateCategory
  /** 出厂(随包分发)或用户新增;画廊同为「内置」语义,仅新增可删除。 */
  origin: 'factory' | 'added'
  pageCount: number
  description?: string
  /** 预览页 URL 的构造模板,`{page}` 替换为从 1 开始的页号。 */
  previewUrlTemplate: string
}

/** 清单 hook 的加载状态。 */
export interface TemplatesState {
  loading: boolean
  error: boolean
  templates: PptTemplateItem[]
  maxCustomTemplates: number
}

interface TemplateListPayload {
  templates: PptTemplateItem[]
  maxCustomTemplates: number
}

const subscribeTemplatesRev = (onChange: () => void): (() => void) => pptStore.subscribe(onChange)

/**
 * 拉取模板清单,templatesRev 变化时重新拉取。
 *
 * @returns 清单加载状态;加载中沿用上一次的 templates/maxCustomTemplates。
 */
export function useTemplates(): TemplatesState {
  const rev = useSyncExternalStore(
    subscribeTemplatesRev,
    () => pptStore.getSnapshot().templatesRev,
    () => pptStore.getSnapshot().templatesRev,
  )
  const [state, setState] = useState<TemplatesState>({ loading: true, error: false, templates: [], maxCustomTemplates: 10 })
  useEffect(() => {
    let live = true
    setState(prev => ({ ...prev, loading: true, error: false }))
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('api/ppt/templates')
        if (!response.ok) throw new Error(`templates list status ${String(response.status)}`)
        const payload = (await response.json()) as TemplateListPayload
        if (live) setState({ loading: false, error: false, templates: payload.templates, maxCustomTemplates: payload.maxCustomTemplates })
      } catch {
        if (live) setState(prev => ({ ...prev, loading: false, error: true }))
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [rev])
  return state
}

/**
 * 按预览 URL 模板构造第 page 页(从 1 开始)的图片地址。
 *
 * @param item 含预览 URL 模板的清单项(或其片段)。
 * @param page 页号,从 1 开始。
 * @returns 图片 URL。
 */
export function previewPageUrl(item: Pick<PptTemplateItem, 'previewUrlTemplate'>, page: number): string {
  return item.previewUrlTemplate.replace('{page}', String(page))
}

/**
 * 探测提炼用的 Python 环境是否就绪;请求失败一律视为未就绪(引导对话框
 * 里会再次探测并展示具体失败态)。
 *
 * @returns 就绪则 true。
 */
export async function fetchPythonReady(): Promise<boolean> {
  try {
    const response = await fetch('api/ppt/python-status')
    if (!response.ok) return false
    const payload = (await response.json()) as { ready: boolean }
    return  payload.ready
  } catch {
    return false
  }
}

/** 画廊/预览器文案所需的最小 t 形态(便于纯展示子组件的类型标注)。 */
export type PptTranslate = TranslateNS<'settings.ppt'>
