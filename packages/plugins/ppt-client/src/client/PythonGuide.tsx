/**
 * Python 环境引导对话框:展示 python-status 的失败原因并给安装指引。
 *
 * 「重新检测」通过后关闭对话框并在画廊顶部提示可重新选择模板;就绪状态
 * 下打开(竞态/手动)时仅展示就绪文案。
 *
 * @module
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, IconCopyOutlineMedium, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { closeGuide, markGuideReadyHint } from './pptState.ts'
import type { PptTranslate } from './useTemplates.ts'
import css from './PptGallery.module.css'

/** 与宿主 python.ts 的 PptPythonStatus 对齐的响应形状(只取展示所需字段)。 */
interface PythonStatusPayload {
  python: { available: boolean; version?: string; versionOk: boolean; pythonCmd?: string }
  dependencies: { name: string; installed: boolean }[]
  ready: boolean
}

type GuidePhase =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ok'; payload: PythonStatusPayload }

/**
 * 依赖未装齐时按缺失包动态生成安装命令(pip install 按包名安装与目录无关,
 * 比要求用户找到 requirements.txt 所在目录更可执行)。
 *
 * @param payload 就绪检测结果。
 * @returns 安装命令;解释器本身不可用时返回 null(此时只给装 Python 指引)。
 */
function buildInstallCommand(payload: PythonStatusPayload): string | null {
  if (!payload.python.available) return null
  const missing = payload.dependencies.filter(dep => !dep.installed).map(dep => dep.name)
  if (missing.length === 0) return null
  return `${payload.python.pythonCmd ?? 'python'} -m pip install ${missing.join(' ')}`
}

/** 引导对话框组件属性。 */
export interface PythonGuideProps {
  /** 设置命名空间文案。 */
  t: PptTranslate
  /** 关闭对话框(用户主动关闭时用;重检通过走内部关闭+提示)。 */
  onClose: () => void
}

/**
 * 拉取一次 Python 状态。
 *
 * @returns 状态载荷;请求或解析失败时返回 null。
 */
async function fetchStatus(): Promise<PythonStatusPayload | null> {
  try {
    const response = await fetch('api/ppt/python-status')
    if (!response.ok) return null
    return (await response.json()) as PythonStatusPayload
  } catch {
    return null
  }
}

/**
 * 渲染 Python 环境引导对话框。
 *
 * @param props 引导对话框属性。
 * @returns 对话框元素。
 */
export function PythonGuide({ t, onClose }: PythonGuideProps): ReactNode {
  const [status, setStatus] = useState<GuidePhase>({ phase: 'loading' })
  const [copied, setCopied] = useState(false)

  const probe = useCallback((pass: boolean): void => {
    setStatus({ phase: 'loading' })
    setCopied(false)
    void fetchStatus().then((payload) => {
      if (payload === null) {
        setStatus({ phase: 'error' })
        return
      }
      setStatus({ phase: 'ok', payload })
      if (pass && payload.ready) {
        // 重检通过:关对话框并在画廊提示可重新选择模板。
        closeGuide()
        markGuideReadyHint()
      }
    })
  }, [])

  useEffect(() => {
    probe(false)
  }, [probe])

  const isWindows = /win/i.test(navigator.platform) || /win/i.test(navigator.userAgent)
  const installCommand = status.phase === 'ok' && !status.payload.ready
    ? buildInstallCommand(status.payload)
    : null

  return (
    <Modal open onClose={onClose} title={t('guideTitle')} closeLabel={t('close')}>
      {status.phase === 'loading' && <p className={css.guideStatus}>{t('guideChecking')}</p>}
      {status.phase === 'error' && <p className={`${css.guideStatus} ${css.guideStatusBad}`}>{t('guideCheckError')}</p>}
      {status.phase === 'ok' && status.payload.ready && <p className={css.guideStatus}>{t('guideReady')}</p>}
      {status.phase === 'ok' && !status.payload.ready && (
        <p className={`${css.guideStatus} ${css.guideStatusBad}`}>
          {!status.payload.python.available
            ? t('guideMissingPython')
            : !status.payload.python.versionOk
              ? t('guideBadVersion', { version: status.payload.python.version ?? '' })
              : t('guideMissingDeps', { packages: status.payload.dependencies.filter(dep => !dep.installed).map(dep => dep.name).join(', ') })}
        </p>
      )}
      {installCommand !== null
        ? <p className={css.guidePlatform}>{t('guideDepsHint')}</p>
        : (
          <p className={css.guidePlatform}>{isWindows ? t('guideWin') : t('guideMac')}</p>
        )}
      {installCommand !== null && (
        <div className={css.guideCommandRow}>
          <code className={css.guideCommand}>{installCommand}</code>
          <Button
            variant="outline"
            size="sm"
            icon={<IconCopyOutlineMedium />}
            onClick={() => {
              void navigator.clipboard.writeText(installCommand).then(() => { setCopied(true) })
            }}
          >
            {t('guideCopyPip')}
          </Button>
          {copied && <span className={css.guideCopied}>{t('guideCopied')}</span>}
        </div>
      )}
      <div className={css.guideActions}>
        <Button variant="primary" size="sm" onClick={() => { probe(true) }}>
          {t('guideRecheck')}
        </Button>
      </div>
    </Modal>
  )
}
