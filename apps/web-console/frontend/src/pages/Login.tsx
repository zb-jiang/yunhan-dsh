import { LockOutlined, MailOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Form, Input, Modal, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import {
  buildOidcAuthorizeUrl,
  getOidcIssuer,
  readOidcLoginSuccessMessage,
} from '../auth/auth-session'
import { BrandMark } from '../components/Brand'

interface LoginForm {
  email: string
  password: string
}

export default function LoginPage() {
  const { signIn, mode, loginError, completeOidcLogin } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 非 null 时弹 Modal 内嵌认证中心登录页(iframe),null 收起。 */
  const [oidcFrameUrl, setOidcFrameUrl] = useState<string | null>(null)
  /** iframe 引用:load 后读其地址提取授权码,兜住认证中心不发 postMessage 的第三方扫码路径。 */
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const onFinish = async (values: LoginForm) => {
    setLoading(true)
    setError(null)
    try {
      await signIn(values.email, values.password)
      const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'
      navigate(from, { replace: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '登录失败'
      setError(msg)
      message.error(msg)
    } finally {
      setLoading(false)
    }
  }

  const openOidcFrame = async () => {
    setError(null)
    setLoading(true)
    try {
      // iframe 内嵌登录:授权 URL 带 popup=iframe,认证中心登录成功不 302 而是向本页 postMessage
      setOidcFrameUrl(await buildOidcAuthorizeUrl({ promptLogin: false, popupIframe: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  /** 拿到授权码后的公共续程:state 校验、令牌交换、推进认证状态、跳回来源页;postMessage 与 iframe load 两条路径共用。 */
  const handleOidcCode = useCallback(
    (callback: { code: string; state: string }) => {
      void (async () => {
        try {
          // completeOidcLogin 在交换成功后更新 AuthContext 的 authenticated/me——
          // 只写 localStorage 不够,RequireAuth 看的是上下文状态,否则 navigate 后被踢回登录页
          await completeOidcLogin(callback)
          const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'
          navigate(from, { replace: true })
        } catch (e) {
          const msg = e instanceof Error ? e.message : '登录失败'
          setError(msg)
          message.error(msg)
          setOidcFrameUrl(null)
        }
      })()
    },
    [location, navigate, message, completeOidcLogin],
  )

  useEffect(() => {
    if (oidcFrameUrl === null) return
    const onMessage = (event: MessageEvent) => {
      const callback = readOidcLoginSuccessMessage(event, getOidcIssuer())
      if (callback === null) return
      handleOidcCode(callback)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [oidcFrameUrl, handleOidcCode])

  /**
   * iframe load 兜底:账号密码路径认证中心会 postMessage(走上面的 onMessage),但钉钉等
   * 第三方 Provider 扫码路径拿到 code 后直接把 iframe 导航到 redirect_uri、不发消息。
   * 导航回本站后与父页面同源,这里读其地址提取 code/state;仍停在认证中心(跨源)或
   * 加载失败页时读取抛 SecurityError,静默等下一跳。load 派发早于 iframe 内 SPA 的
   * initAuth 网络往返,sessionStorage 一次性凭据由本页先取先删。
   */
  const onFrameLoad = useCallback(() => {
    const frame = frameRef.current
    if (frame === null) return
    let href: string
    try {
      href = frame.contentWindow?.location.href ?? ''
    } catch {
      return
    }
    const params = new URLSearchParams(new URL(href, window.location.origin).search)
    const code = params.get('code')
    const state = params.get('state')
    if (code !== null && state !== null) handleOidcCode({ code, state })
  }, [handleOidcCode])

  const displayError = error ?? loginError

  const brand = (
    <div style={{ textAlign: 'center', marginBottom: 24 }}>
      <BrandMark variant="auth" />
      <Typography.Title level={3} style={{ marginBottom: 4 }}>
        云汉企业AI协同平台
      </Typography.Title>
      <Typography.Text type="secondary">企业级应用平台管理后台</Typography.Text>
    </div>
  )

  if (mode === 'oidc') {
    return (
      <div className="auth-shell">
        <Card style={{ width: 380 }}>
          {brand}
          {displayError && (
            <Alert type="error" message={displayError} showIcon style={{ marginBottom: 16 }} />
          )}
          <Button
            type="primary"
            size="large"
            block
            icon={<SafetyCertificateOutlined />}
            loading={loading}
            onClick={() => void openOidcFrame()}
          >
            企业账号登录
          </Button>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
            登录由企业认证中心统一管理;如无法登录请联系平台管理员。
          </Typography.Paragraph>
        </Card>
        <Modal
          title="企业账号登录"
          open={oidcFrameUrl !== null}
          footer={null}
          width={520}
          destroyOnClose
          onCancel={() => setOidcFrameUrl(null)}
        >
          {oidcFrameUrl !== null && (
            <iframe
              ref={frameRef}
              src={oidcFrameUrl}
              title="企业认证中心登录"
              onLoad={onFrameLoad}
              style={{ width: '100%', height: 600, border: 'none' }}
            />
          )}
        </Modal>
      </div>
    )
  }

  return (
    <div className="auth-shell">
      <Card style={{ width: 380 }}>
        {brand}
        {displayError && (
          <Alert type="error" message={displayError} showIcon style={{ marginBottom: 16 }} />
        )}
        <Form<LoginForm> layout="vertical" onFinish={onFinish} autoComplete="off">
          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}
          >
            <Input prefix={<MailOutlined />} placeholder="you@example.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          登录账号由 Supabase Auth 管理;首次注册后需平台管理员审批方可使用后台。
        </Typography.Paragraph>
        <div style={{ textAlign: 'center' }}>
          还没账号? <Link to="/register">立即注册</Link>
        </div>
      </Card>
    </div>
  )
}
