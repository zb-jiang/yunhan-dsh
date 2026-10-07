/**
 * bpmn-js 画布右下角的缩放控件(放大/缩小/适应画布)。
 *
 * <p>通过 getCanvas 惰性获取 diagram-js canvas 服务:控件仅在点击时调用,
 * viewer/modeler 未初始化或已销毁时点击无效果。宿主容器需为 relative 定位。
 */
import type { CSSProperties } from 'react'

/** diagram-js canvas 服务:zoom 无参返回当前缩放,数字为绝对缩放,'fit-viewport' 适应视口。 */
export interface BpmnCanvasLike {
  zoom: (target?: string | number, center?: string) => number
}

/** 缩放步进系数(每档放大 1.2 倍 / 缩小 1/1.2)。 */
const ZOOM_STEP = 1.2

/** 画布角落按钮的共用样式。 */
const buttonStyle: CSSProperties = {
  width: 30,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#fff',
  border: '1px solid #d9d9d9',
  borderRadius: 4,
  boxShadow: '0 1px 4px rgba(0, 0, 0, 0.1)',
  cursor: 'pointer',
  color: '#595959',
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
}

interface BpmnZoomControlsProps {
  /** 返回当前画布的 canvas 服务;未初始化时返回 undefined(点击无效果)。 */
  getCanvas: () => BpmnCanvasLike | undefined
}

export default function BpmnZoomControls({ getCanvas }: BpmnZoomControlsProps) {
  const zoomIn = () => {
    const canvas = getCanvas()
    if (canvas) canvas.zoom(canvas.zoom() * ZOOM_STEP)
  }

  const zoomOut = () => {
    const canvas = getCanvas()
    if (canvas) canvas.zoom(canvas.zoom() / ZOOM_STEP)
  }

  const zoomFit = () => {
    getCanvas()?.zoom('fit-viewport', 'auto')
  }

  return (
    <div
      style={{
        position: 'absolute',
        right: 12,
        bottom: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        zIndex: 10,
      }}
    >
      <button type="button" title="放大" onClick={zoomIn} style={buttonStyle}>
        ＋
      </button>
      <button type="button" title="缩小" onClick={zoomOut} style={buttonStyle}>
        －
      </button>
      <button type="button" title="适应画布" onClick={zoomFit} style={buttonStyle}>
        ⛶
      </button>
    </div>
  )
}
