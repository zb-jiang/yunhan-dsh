/**
 * 手机访问设置页：状态轮询 + 总开关 + 局域网卡 + 公网网卡 + 配对与设备卡 + 桌面身份卡。
 *
 * <p>3s 轮询 `GET api/enterprise/pocket/status`；写操作（总开关/局域网开关/
 * 手动地址覆盖/隧道启停与配置/隧道 Token/配对码生成/设备吊销）调 §7.2 管理路由
 * 后用返回快照整体替换本地状态。公网开启走免责弹窗，确认后才携带 disclaimer 调路由。
 * 局域网与公网访问互斥（UI 层保证）：开启一侧前先经管理路由关闭另一侧。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PocketAccessSection.module.css'

/** 管理路由快照（§7.4 字段，与服务端 PocketAccessSnapshot 对齐）。 */
export interface PocketStatus {
  enabled: boolean
  proxyPort: number | null
  upstreamPort: number | null
  handshakeAvailable: boolean
  lan: {
    enabled: boolean
    url: string | null
    qr: string | null
    candidates: string[]
    override: string
  }
  devices: Array<{ id: string; createdAt: number; lastSeenAt: number; ua: string; source: 'lan' | 'wan' | null }>
  pairing: { code: string | null; expiresAt: number | null; qr: string | null }
  identity: { currentUserId: string | null }
  tunnel: {
    enabled: boolean
    state: 'idle' | 'starting' | 'running' | 'error'
    mode: 'quick' | 'named'
    url: string | null
    hostname: string
    tokenSet: boolean
    detail: string
    startedAt: number
  }
}

/** 读取状态快照；网络/服务端失败抛错（轮询降级显示）。 */
async function fetchStatus(): Promise<PocketStatus> {
  const res = await fetch('api/enterprise/pocket/status')
  // 管理路由仅应答桌面 loopback：手机端经代理访问一律 403，直接给出引导文案而非状态码
  if (res.status === 403) throw new Error('手机端不能管理手机访问设置，请在电脑上的 DSH 设置页操作。')
  if (!res.ok) throw new Error(`状态读取失败：${String(res.status)}`)
  return await res.json() as PocketStatus
}

/**
 * 调管理路由写操作，返回新快照。
 * @param path - 路由子路径（如 `enabled`）。
 * @param body - JSON 请求体。
 */
async function postAction(path: string, body: Record<string, unknown>): Promise<PocketStatus> {
  const res = await fetch(`api/enterprise/pocket/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`操作失败：${String(res.status)} ${errorMessage(text)}`)
  }
  return await res.json() as PocketStatus
}

/** 从管理路由错误响应提取中文原因（`{error}` JSON 优先，非 JSON 原样返回）。 */
function errorMessage(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text // 错误体非 JSON（如代理 502 文本页），原样展示
  }
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    const error = parsed.error
    if (typeof error === 'string' && error !== '') return error
  }
  return text
}

/** 隧道运行状态的展示文案（穷尽映射，新增状态会编译失败）。 */
function tunnelStateText(state: 'idle' | 'starting' | 'running' | 'error'): string {
  switch (state) {
    case 'idle': return '未运行'
    case 'starting': return '启动中…'
    case 'running': return '运行中'
    case 'error': return '异常（见错误详情）'
  }
}

/** 握手可用性的展示文案。 */
function handshakeText(available: boolean): string {
  return available ? '正常' : '不可用（webserver 未就绪）'
}

/** epoch 毫秒 → 本地时间（设备表展示用）。 */
function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}

/** 剩余毫秒 → mm:ss（配对码倒计时）。 */
function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.floor(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 每秒更新的当前时间，驱动配对码倒计时。 */
function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return now
}

/** @returns 手机访问设置页。 */
export function PocketAccessSection() {
  const [status, setStatus] = useState<PocketStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [overrideDraft, setOverrideDraft] = useState<string | null>(null)
  const [disclaimerOpen, setDisclaimerOpen] = useState(false)
  const [hostnameDraft, setHostnameDraft] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const now = useNow()

  const tick = useCallback((): void => {
    void fetchStatus()
      .then((next) => {
        setStatus(next)
        setLoadFailed(null)
        // 覆盖值草稿：未编辑过时跟随服务端；编辑中不回写
        setOverrideDraft(current => (current === null ? next.lan.override : current))
        // 命名隧道地址草稿同策略
        setHostnameDraft(current => (current === null ? next.tunnel.hostname : current))
      })
      .catch((error: unknown) => {
        setLoadFailed(error instanceof Error ? error.message : String(error))
      })
  }, [])

  useEffect(() => {
    tick()
    const timer = setInterval(tick, 3000)
    return () => {
      clearInterval(timer)
    }
  }, [tick])

  const runAction = (path: string, body: Record<string, unknown>, successText: string): void => {
    setBusy(true)
    setMessage(null)
    void postAction(path, body)
      .then((next) => {
        setStatus(next)
        setOverrideDraft(next.lan.override)
        setMessage(successText)
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  /**
   * 互斥切换：先调第一个写操作关掉另一侧，再调第二个开目标侧，全程共享一次 busy 周期。
   * @param first - 先执行的写操作（关闭另一侧）。
   * @param second - 后执行的写操作（开启目标侧）。
   * @param successText - 两步都成功后的提示文案。
   */
  const runMutualExclusive = (
    first: { path: string; body: Record<string, unknown> },
    second: { path: string; body: Record<string, unknown> },
    successText: string,
  ): void => {
    setBusy(true)
    setMessage(null)
    void postAction(first.path, first.body)
      .then(() => postAction(second.path, second.body))
      .then((next) => {
        setStatus(next)
        setOverrideDraft(next.lan.override)
        setMessage(successText)
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  if (status === null) {
    return (
      <div className={css.section}>
        <p className={css.hint}>{loadFailed === null ? '正在加载手机访问状态…' : loadFailed}</p>
      </div>
    )
  }

  const desktopSignedIn = status.identity.currentUserId !== null
  const tunnel = status.tunnel
  // 免责弹窗打开期间冻结公网网卡控件，避免轮询刷新造成开关与弹窗状态脱节
  const tunnelBusy = busy || disclaimerOpen
  const pairingActive = status.pairing.code !== null && status.pairing.expiresAt !== null
  const remainingMs = pairingActive ? Math.max(0, (status.pairing.expiresAt ?? 0) - now) : null
  // 新配对的设备排前面
  const devices = [...status.devices].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className={css.section}>
      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>总开关</h3>
          <Switch
            checked={status.enabled}
            disabled={busy}
            label={status.enabled ? '已开启' : '已关闭'}
            onChange={(checked) => { runAction('enabled', { enabled: checked }, checked ? '手机访问已开启' : '手机访问已关闭') }}
          />
        </div>
        <p className={css.hint}>控制代理服务启停：开启后手机方可经代理接入本机 DSH，关闭后代理停止、手机端全部断开。首次使用需扫码配对。</p>
        <dl className={css.facts}>
          <div className={css.fact}>
            <dt>代理端口</dt>
            <dd>{status.proxyPort === null ? '-' : String(status.proxyPort)}</dd>
          </div>
          <div className={css.fact}>
            <dt>上游端口</dt>
            <dd>{status.upstreamPort === null ? '-' : String(status.upstreamPort)}</dd>
          </div>
          <div className={css.fact}>
            <dt>登录握手</dt>
            <dd>{handshakeText(status.handshakeAvailable)}</dd>
          </div>
          <div className={css.fact}>
            <dt>桌面登录</dt>
            <dd>{desktopSignedIn ? '已登录' : '桌面未登录，手机暂不可用'}</dd>
          </div>
        </dl>
      </div>

      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>局域网访问</h3>
          <Switch
            checked={status.lan.enabled}
            disabled={busy}
            label={status.lan.enabled ? '已开启' : '已关闭'}
            onChange={(checked) => {
              // 与公网访问互斥：开启局域网前先停掉运行中的公网隧道
              if (checked && tunnel.enabled) {
                runMutualExclusive(
                  { path: 'tunnel', body: { action: 'stop' } },
                  { path: 'lan', body: { enabled: true } },
                  '已切换到局域网访问：公网访问已关闭',
                )
                return
              }
              runAction('lan', { enabled: checked }, checked ? '局域网访问已开启' : '局域网访问已关闭')
            }}
          />
        </div>
        <p className={css.hint}>仅控制局域网内手机的接入：关闭时立即断开手机端连接，代理服务与本机 DSH 不受影响。与公网访问互斥：开启时自动关闭公网访问。</p>
        {status.lan.url !== null && status.lan.qr !== null
          ? (
            <div className={css.lanBody}>
              <img className={css.qr} src={status.lan.qr} alt="手机访问二维码" width={220} height={220} />
              <div className={css.lanInfo}>
                <p className={css.url}>{status.lan.url}</p>
                {status.lan.candidates.length > 0 && (
                  <p className={css.hint}>
                    候选地址：
                    {status.lan.candidates.join('、')}
                  </p>
                )}
              </div>
            </div>
          )
          : (
            <p className={css.hint}>开启总开关并确认本机存在局域网地址后，这里会显示访问地址与二维码。</p>
          )}
        <div className={css.overrideRow}>
          <input
            className={css.overrideInput}
            value={overrideDraft ?? ''}
            placeholder="手动指定局域网地址（留空自动探测）"
            disabled={busy}
            onChange={(event) => { setOverrideDraft(event.target.value) }}
          />
          <Button
            disabled={busy || overrideDraft === null || overrideDraft === status.lan.override}
            onClick={() => { runAction('lan-override', { ip: overrideDraft ?? '' }, '局域网地址已更新') }}
          >
            保存地址
          </Button>
        </div>
      </div>

      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>公网访问</h3>
          <Switch
            checked={tunnel.enabled}
            disabled={tunnelBusy || !status.enabled}
            label={tunnel.enabled ? '已开启' : '已关闭'}
            onChange={(checked) => {
              if (checked) { setDisclaimerOpen(true); return }
              runAction('tunnel', { action: 'stop' }, '公网访问已关闭')
            }}
          />
        </div>
        <p className={css.hint}>
          经 Cloudflare 隧道把本机 DSH 发布到公网，手机在任何网络下都能访问，无需同一 WiFi。与局域网访问互斥：开启时自动关闭局域网访问。
          {status.enabled ? '' : '代理未运行：请先开启总开关。'}
        </p>
        <dl className={css.facts}>
          <div className={css.fact}>
            <dt>运行状态</dt>
            <dd>{tunnelStateText(tunnel.state)}</dd>
          </div>
          <div className={css.fact}>
            <dt>隧道模式</dt>
            <dd>{tunnel.mode === 'quick' ? '快速隧道' : '命名隧道'}</dd>
          </div>
        </dl>
        {tunnel.url !== null && <p className={css.url}>{tunnel.url}</p>}
        {tunnel.state === 'running' && tunnel.mode === 'named' && tunnel.hostname !== ''
          && <p className={css.url}>{`https://${tunnel.hostname}`}</p>}
        {tunnel.state === 'error' && tunnel.detail !== '' && (
          <p className={css.tunnelError}>{tunnel.detail}</p>
        )}
        <div className={css.modeRow}>
          <Button
            variant={tunnel.mode === 'quick' ? 'primary' : 'outline'}
            disabled={tunnelBusy}
            onClick={() => { runAction('tunnel-config', { mode: 'quick' }, '隧道模式已切换为快速隧道') }}
          >
            快速隧道
          </Button>
          <Button
            variant={tunnel.mode === 'named' ? 'primary' : 'outline'}
            disabled={tunnelBusy}
            onClick={() => { runAction('tunnel-config', { mode: 'named' }, '隧道模式已切换为命名隧道') }}
          >
            命名隧道
          </Button>
        </div>
        {tunnel.mode === 'named' && (
          <div className={css.tunnelForm}>
            <div className={css.overrideRow}>
              <input
                className={css.overrideInput}
                value={hostnameDraft ?? ''}
                placeholder="命名隧道地址（如 dsh.example.com）"
                disabled={tunnelBusy}
                onChange={(event) => { setHostnameDraft(event.target.value) }}
              />
              <Button
                disabled={tunnelBusy || hostnameDraft === null || hostnameDraft === tunnel.hostname}
                onClick={() => { runAction('tunnel-config', { hostname: hostnameDraft ?? '' }, '命名隧道地址已保存') }}
              >
                保存地址
              </Button>
            </div>
            <p className={css.hint}>地址需已在 Cloudflare 账号中配置为该隧道的公网主机名；修改在下次启动隧道时生效。</p>
            <div className={css.overrideRow}>
              {tunnel.tokenSet
                ? (
                  <>
                    <span className={css.tokenSet}>Token 已配置</span>
                    <Button disabled={tunnelBusy} onClick={() => { runAction('tunnel-token', { token: '' }, '隧道 Token 已清除') }}>
                      清除 Token
                    </Button>
                  </>
                )
                : (
                  <>
                    <input
                      className={css.overrideInput}
                      type="password"
                      value={tokenDraft}
                      placeholder="粘贴 Cloudflare 隧道 Token"
                      disabled={tunnelBusy}
                      onChange={(event) => { setTokenDraft(event.target.value) }}
                    />
                    <Button
                      disabled={tunnelBusy || tokenDraft.trim() === ''}
                      onClick={() => { runAction('tunnel-token', { token: tokenDraft.trim() }, '隧道 Token 已保存') }}
                    >
                      保存 Token
                    </Button>
                  </>
                )}
            </div>
          </div>
        )}
      </div>

      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>配对与设备</h3>
          <Button disabled={busy} onClick={() => { runAction('pairing', { action: 'create' }, '配对码已生成') }}>
            生成配对码
          </Button>
        </div>
        {pairingActive && status.pairing.qr !== null
          ? (
            <div className={css.pairingBody}>
              <img className={css.qr} src={status.pairing.qr} alt="配对二维码" width={220} height={220} />
              <div className={css.pairingInfo}>
                <p className={css.pairingCode}>{status.pairing.code}</p>
                <p className={css.hint}>
                  {`剩余有效期 ${formatRemaining(remainingMs ?? 0)}；单次使用，5 分钟内有效。扫码打开的页面自动完成配对，无需手动输码。`}
                  {'二维码始终指向当前开启的入口：公网访问开启时指向公网地址，任何网络下的手机均可扫描；否则指向局域网地址，仅同一 Wi-Fi 下的手机可扫。'}
                </p>
              </div>
            </div>
          )
          : (
            <p className={css.hint}>无活跃配对码。手机打开局域网地址（或公网隧道地址）后，需输入这里生成的配对码。</p>
          )}
        <table className={css.deviceTable}>
          <thead>
            <tr>
              <th>设备</th>
              <th>接入</th>
              <th>添加时间</th>
              <th>最近活跃</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {devices.map(device => (
              <tr key={device.id}>
                <td className={css.deviceUa} title={device.id}>{device.ua !== '' ? device.ua : '未知设备'}</td>
                <td>{device.source === 'wan' ? '公网' : device.source === 'lan' ? '局域网' : '—'}</td>
                <td>{formatTime(device.createdAt)}</td>
                <td>{formatTime(device.lastSeenAt)}</td>
                <td>
                  <Button
                    disabled={busy}
                    onClick={() => { runAction('pairing', { action: 'revoke', deviceId: device.id }, '设备已吊销') }}
                  >
                    吊销
                  </Button>
                </td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr>
                <td colSpan={5} className={css.deviceEmpty}>暂无已配对设备</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>桌面身份</h3>
        </div>
        <p className={css.hint}>手机侧带凭据的请求将以同账号校验；桌面未登录时手机访问被拒绝。</p>
        <p className={css.identityId}>{desktopSignedIn ? status.identity.currentUserId : '未登录'}</p>
      </div>

      {message !== null && <p className={css.message}>{message}</p>}

      <Modal
        open={disclaimerOpen}
        onClose={() => { setDisclaimerOpen(false) }}
        title="开启公网访问"
        closeLabel="取消"
        description="请先阅读并确认以下风险提示。"
        footer={(
          <>
            <Button onClick={() => { setDisclaimerOpen(false) }}>取消</Button>
            <Button
              variant="primary"
              data-modal-autofocus
              onClick={() => {
                setDisclaimerOpen(false)
                // 与局域网访问互斥：启动隧道前先关闭局域网（服务端会断开局域网设备）
                if (status.lan.enabled) {
                  runMutualExclusive(
                    { path: 'lan', body: { enabled: false } },
                    { path: 'tunnel', body: { action: 'start', disclaimer: true } },
                    '已切换到公网访问：局域网访问已关闭，隧道启动中…',
                  )
                  return
                }
                runAction('tunnel', { action: 'start', disclaimer: true }, '公网访问已开启，隧道启动中…')
              }}
            >
              确认开启
            </Button>
          </>
        )}
      >
        <p className={css.disclaimerText}>
          开启公网即把可执行代码的 DSH 暴露到互联网：任何拿到公网地址的人都能触达你的 DSH 实例，
          AI 对话、文件与已配置的工具随之暴露。
        </p>
        <p className={css.disclaimerText}>
          DSH 通过配对码与同账号校验限制访问，但公网暴露仍会增大攻击面，请确认你了解并接受该风险。
        </p>
        <p className={css.disclaimerText}>
          快速隧道无需注册，地址由 Cloudflare 随机分配且重启后会变化；命名隧道使用你自己的
          Cloudflare 账号与固定域名，需先粘贴隧道 Token。
        </p>
      </Modal>
    </div>
  )
}
