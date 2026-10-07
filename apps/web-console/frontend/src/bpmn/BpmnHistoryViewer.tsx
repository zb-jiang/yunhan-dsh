/**
 * bpmn-js NavigatedViewer 的 React 封装(实例历史活动路径图)。
 *
 * <p>只读、可平移缩放;根据历史活动数据高亮执行路径(经典 BPM 审计视图样式):
 * 已完成节点绿色、进行中节点蓝色、已走过的 sequenceFlow 连线绿色加粗。
 * 高亮通过 canvas.addMarker 挂 CSS 类实现,样式见 bpmn-history-viewer.css。
 *
 * <p>流程日志联动(双向):
 * <ul>
 *   <li>画布 → 日志表:onElementClick 回调抛出被点击元素的 id(含空白处点击落到
 *       process 根元素,id 不会命中任何日志条目,由父层当作"清除高亮"处理)。</li>
 *   <li>日志表 → 画布:flashElementId 变化时对应节点挂 dsh-log-flash marker
 *       短暂闪亮(约 1.6 秒后摘除),供反向定位节点。</li>
 * </ul>
 */
import { useEffect, useRef, useState } from 'react'
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer'
import { Alert, Spin } from 'antd'
import type { HistoricActivityDto } from '../api/process-instances'
import { dshModdleDescriptor, flowableModdleDescriptor } from './dsh-moddle'
import BpmnZoomControls, { type BpmnCanvasLike } from './BpmnZoomControls'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css'
import './bpmn-history-viewer.css'

interface BpmnHistoryViewerProps {
  /** 实例部署版 BPMN XML。 */
  xml: string
  /** 历史活动列表(驱动高亮;含 sequenceFlow 连线记录)。 */
  activities: HistoricActivityDto[]
  /** 点击画布元素的回调(参数为元素 id);未传则不订阅点击事件。 */
  onElementClick?: (elementId: string) => void
  /** 需要闪亮的元素 id(日志表反向定位);null/undefined 表示无。 */
  flashElementId?: string | null
  /** 闪亮触发序号:每次点击日志行自增,同一元素重复点击也能重新触发。 */
  flashSeq?: number
}

interface BpmnViewerInstance {
  importXML: (xml: string) => Promise<unknown>
  destroy: () => void
  get: (name: string) => unknown
}

interface CanvasLike {
  addMarker: (elementId: string, marker: string) => void
  removeMarker: (elementId: string, marker: string) => void
}

interface EventBusLike {
  on: (event: string, callback: (event: { element: { id: string } }) => void) => void
  off: (event: string, callback: (event: { element: { id: string } }) => void) => void
}

/** 闪亮 marker 挂载时长(毫秒),超时自动摘除。 */
const FLASH_DURATION_MS = 1600

/**
 * 按活动记录给画布元素挂高亮 marker。
 *
 * sequenceFlow 记录给连线挂绿色;其余节点 endTime 有值为已完成(绿),
 * 无值为进行中(蓝)。同一 activityId 出现多条记录(多实例/并行)时
 * 任一条仍在进行即按进行中处理,完成后以绿色覆盖。
 */
function applyHistoryMarkers(viewer: BpmnViewerInstance, activities: HistoricActivityDto[]) {
  const canvas = viewer.get('canvas') as CanvasLike
  const runningIds = new Set<string>()
  for (const act of activities) {
    if (act.activityType === 'sequenceFlow') continue
    if (!act.endTime) runningIds.add(act.activityId)
  }
  for (const act of activities) {
    const marker =
      act.activityType === 'sequenceFlow' || act.endTime
        ? 'dsh-hist-completed'
        : 'dsh-hist-running'
    // 进行中节点不叠加绿色(多实例并行分支:一条完成一条进行 → 蓝)
    if (marker === 'dsh-hist-completed' && runningIds.has(act.activityId)) continue
    try {
      canvas.addMarker(act.activityId, marker)
    } catch {
      // 部署版图上找不到该元素(如并行网关拆分出的内部活动)时跳过
    }
  }
}

export default function BpmnHistoryViewer({ xml, activities, onElementClick, flashElementId, flashSeq }: BpmnHistoryViewerProps) {
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

  // xml / activities 变化 → 重新导入并高亮
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
        applyHistoryMarkers(viewer, activities)
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
  }, [xml, activities])

  // 画布点击 → 抛出元素 id(空白处点击落到 process 根元素,由父层按"无日志"处理)
  const clickHandlerRef = useRef(onElementClick)
  clickHandlerRef.current = onElementClick
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !onElementClick) return
    const eventBus = viewer.get('eventBus') as EventBusLike
    const handler = (event: { element: { id: string } }) => {
      clickHandlerRef.current?.(event.element.id)
    }
    eventBus.on('element.click', handler)
    return () => {
      eventBus.off('element.click', handler)
    }
  }, [onElementClick])

  // 日志表反向定位:flashElementId 变化 → 对应节点闪亮后摘除;
  // flashSeq 递增使同一节点连续点击也能重新触发
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !flashElementId) return
    const canvas = viewer.get('canvas') as CanvasLike
    try {
      canvas.addMarker(flashElementId, 'dsh-log-flash')
    } catch {
      return
    }
    const timer = setTimeout(() => {
      try {
        canvas.removeMarker(flashElementId, 'dsh-log-flash')
      } catch {
        // 元素已被重新导入移除时忽略
      }
    }, FLASH_DURATION_MS)
    return () => {
      clearTimeout(timer)
      try {
        canvas.removeMarker(flashElementId, 'dsh-log-flash')
      } catch {
        // 同上
      }
    }
  }, [flashElementId, flashSeq])

  return (
    <div
      className="dsh-history-viewer"
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
    </div>
  )
}
