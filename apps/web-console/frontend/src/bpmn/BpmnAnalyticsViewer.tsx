/**
 * bpmn-js NavigatedViewer 的 React 封装(定义级节点时长热力图,分析看板业务 tab)。
 *
 * <p>复用 BpmnHistoryViewer 已验证的模式(NavigatedViewer + canvas.addMarker + CSS):
 * 按 activity-stats 的节点平均时长分三桶挂 marker(阈值按该流程内节点时长的
 * P33/P66 分位自动分桶);sequenceFlow 连线按频次淡化低频路径;节点 hover 经
 * bpmn-js overlays 挂角标显示 count/avg/max。样式见 bpmn-analytics-viewer.css。
 */
import { useEffect, useRef, useState } from 'react'
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer'
import { Alert, Spin, Typography } from 'antd'
import type { ActivityStat } from '../api/analytics'
import { dshModdleDescriptor, flowableModdleDescriptor } from './dsh-moddle'
import BpmnZoomControls, { type BpmnCanvasLike } from './BpmnZoomControls'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css'
import './bpmn-analytics-viewer.css'

interface BpmnAnalyticsViewerProps {
  /** 部署版 BPMN XML(经引擎 /dsh/history/bpmn-xml 取,与实例路径图同源)。 */
  xml: string
  /** 节点活动统计(activity-stats 响应,含 sequenceFlow 连线行)。 */
  stats: ActivityStat[]
}

interface BpmnViewerInstance {
  importXML: (xml: string) => Promise<unknown>
  destroy: () => void
  get: (name: string) => unknown
}

interface CanvasLike {
  addMarker: (elementId: string, marker: string) => void
  scrollToElement: (elementId: string) => void
}

interface OverlaysLike {
  add: (elementId: string, config: { position: { top: number; left: number }; html: HTMLElement }) => string
  remove: (overlayId: string) => void
}

interface EventBusLike {
  on: (event: string, callback: (event: { element: { id: string } }) => void) => void
}

/** 分位数(线性插值;空数组返回 0)。 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** 时长格式化为业务可读中文(数值自带单位):不到1秒 / 45秒 / 3分20秒 / 2小时15分 / 3天2小时。 */
function formatMs(ms: number | null): string {
  if (ms == null) return '-'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 1) return '不到1秒'
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`
  if (minutes > 0) return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`
  return `${seconds}秒`
}

/** 按节点平均时长 P33/P66 分桶决定 marker 类名。 */
function nodeMarker(avg: number, p33: number, p66: number): string {
  if (avg <= p33) return 'dsh-ana-low'
  if (avg <= p66) return 'dsh-ana-mid'
  return 'dsh-ana-high'
}

export default function BpmnAnalyticsViewer({ xml, stats }: BpmnAnalyticsViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<BpmnViewerInstance | null>(null)
  const [importing, setImporting] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 缩放控件取 canvas 服务(点击时 viewer 已初始化)
  const getCanvas = (): BpmnCanvasLike | undefined => {
    const viewer = viewerRef.current
    return viewer ? (viewer.get('canvas') as BpmnCanvasLike) : undefined
  }

  // 初始化 viewer(仅一次)
  useEffect(() => {
    if (!containerRef.current) return
    const viewer = new NavigatedViewer({
      container: containerRef.current,
      moddleExtensions: {
        dsh: dshModdleDescriptor,
        flowable: flowableModdleDescriptor,
      },
    }) as unknown as BpmnViewerInstance
    viewerRef.current = viewer
    return () => {
      viewer.destroy()
      viewerRef.current = null
    }
  }, [])

  // xml / stats 变化 → 重新导入并挂热力 marker + hover 角标
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !xml) return
    let cancelled = false
    setImporting(true)
    setError(null)
    void viewer
      .importXML(xml)
      .then(() => {
        if (cancelled) return
        const canvas = viewer.get('canvas') as CanvasLike
        const overlays = viewer.get('overlays') as OverlaysLike
        const eventBus = viewer.get('eventBus') as EventBusLike

        const nodeStats = stats.filter(s => s.activityType !== 'sequenceFlow')
        const flowStats = stats.filter(s => s.activityType === 'sequenceFlow')
        const avgSorted = nodeStats
          .map(s => s.avgDurationMs ?? 0)
          .sort((a, b) => a - b)
        const p33 = percentile(avgSorted, 0.33)
        const p66 = percentile(avgSorted, 0.66)
        const flowCountSorted = flowStats.map(s => s.count).sort((a, b) => a - b)
        const flowMedian = percentile(flowCountSorted, 0.5)

        const statById = new Map(stats.map(s => [s.activityId, s]))
        for (const [activityId, stat] of statById) {
          try {
            if (stat.activityType === 'sequenceFlow') {
              if (stat.count < flowMedian) {
                canvas.addMarker(activityId, 'dsh-ana-flow-faint')
              }
            } else {
              canvas.addMarker(activityId, nodeMarker(stat.avgDurationMs ?? 0, p33, p66))
            }
          } catch {
            // 部署版图上找不到该元素(流程版本演进后节点更名)时跳过
          }
        }

        // hover 角标:进入挂 overlay 显示 count/avg/max,移出删
        let currentOverlay: string | null = null
        eventBus.on('element.hover', ({ element }) => {
          const stat = statById.get(element.id)
          if (!stat || currentOverlay) return
          const html = document.createElement('div')
          html.className = 'dsh-ana-tip'
          const lines = [`执行 ${stat.count} 次`]
          if (stat.activityType !== 'sequenceFlow') {
            lines.push(`平均 ${formatMs(stat.avgDurationMs)}`)
            lines.push(`最长 ${formatMs(stat.maxDurationMs)}`)
          }
          html.innerHTML = `<strong>${stat.activityName ?? element.id}</strong><br/>${lines.join('<br/>')}`
          currentOverlay = overlays.add(element.id, {
            position: { top: 0, left: 0 },
            html,
          })
        })
        eventBus.on('element.out', () => {
          if (currentOverlay) {
            overlays.remove(currentOverlay)
            currentOverlay = null
          }
        })
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'BPMN 图渲染失败')
      })
      .finally(() => {
        if (!cancelled) setImporting(false)
      })
    return () => {
      cancelled = true
    }
  }, [xml, stats])

  return (
    <div
      className="dsh-ana-viewer"
      style={{
        position: 'relative',
        height: 480,
        border: '1px solid #d9d9d9',
        borderRadius: 6,
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <BpmnZoomControls getCanvas={getCanvas} />
      {importing && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.6)' }}>
          <Spin />
        </div>
      )}
      {error && (
        <Alert type="error" showIcon message="BPMN 图渲染失败" description={error} style={{ margin: 8 }} />
      )}
      <div className="dsh-ana-legend">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          节点平均耗时:
        </Typography.Text>
        <span><span className="dsh-ana-legend-swatch" style={{ background: '#d9f7be', border: '1px solid #52c41a' }} />快</span>
        <span><span className="dsh-ana-legend-swatch" style={{ background: '#fff1b8', border: '1px solid #faad14' }} />中</span>
        <span><span className="dsh-ana-legend-swatch" style={{ background: '#ffd6d6', border: '1px solid #ff4d4f' }} />慢</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          (与本流程内其他节点相比自动分成快/中/慢三档;连线颜色越淡,走这条路完成的任务越少)
        </Typography.Text>
      </div>
    </div>
  )
}

/** 导出给侧栏 TOP 列表定位用(与组件内同源)。 */
export { formatMs }
