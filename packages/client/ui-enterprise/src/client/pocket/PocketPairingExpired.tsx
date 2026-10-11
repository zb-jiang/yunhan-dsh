/**
 * 手机配对失效页:shell.overlay 全屏占据者(order 60,晚于认证遮罩)。
 *
 * <p>连接断开后经 PairingExpiryWatcher 探测代理闸门,得到失效结论时盖住整帧,
 * 显示退出原因与重新扫码指引;未失效时渲染 null 不占 DOM。样式复用认证遮罩
 * 的页面骨架(authPageRoot/authPageCard),单卡片布局内联收窄宽度。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
import { PairingExpiryWatcher, probePairingViaGate, type PairingExpiry } from './pocket-pairing-expiry.ts'
import css from '../EnterpriseUi.module.css'

/** kind → 失效页标题。 */
const EXPIRY_TITLES: Record<PairingExpiry['kind'], string> = {
  revoked: '配对已撤销',
  unpaired: '配对已失效',
  blocked: '手机访问已关闭',
  unreachable: '手机访问连接已断开',
}

export interface PocketPairingExpiredInjected {
  connectionState: ConnectionStateSource
}

/** 手机配对失效页组件:注入连接状态源,内部自持探测器与结论状态。 */
export function PocketPairingExpired({ connectionState }: PocketPairingExpiredInjected): ReactNode {
  const [expiry, setExpiry] = useState<PairingExpiry | null>(null)
  useEffect(() => {
    const watcher = new PairingExpiryWatcher({
      connectionState,
      // no-store:失效探测绝不能吃浏览器缓存——缓存 200 会被当成配对有效,失效页延迟到缓存过期才出现
      probe: () => probePairingViaGate(() => fetch('api/enterprise/auth/config', { cache: 'no-store' })),
    })
    const unsubscribe = watcher.subscribe(() => { setExpiry(watcher.getExpiry()) })
    return () => {
      unsubscribe()
      watcher.dispose()
    }
  }, [connectionState])
  if (expiry === null) return null
  return (
    <div className={css.authPageRoot} style={{ zIndex: 40 }}>
      <div className={css.authPageCard} style={{ maxWidth: 440 }}>
        <div className={css.authCardTitle}>{EXPIRY_TITLES[expiry.kind]}</div>
        <div className={css.authCardSubtitle}>{expiry.message}</div>
        <div className={css.authBlockedActions}>
          <button type='button' className={css.authSecondaryButton} onClick={() => { location.reload() }}>
            重新加载
          </button>
        </div>
        <div className={css.hint}>请在电脑端打开 DSH，进入「设置 → 手机访问」重新扫码配对。</div>
      </div>
    </div>
  )
}
