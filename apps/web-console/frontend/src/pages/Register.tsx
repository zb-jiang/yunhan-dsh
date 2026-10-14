import { LockOutlined, MailOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getSupabaseClient } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/Brand'

interface RegisterForm {
  email: string
  displayName?: string
  password: string
  confirm: string
}

/**
 * 用户注册页(仅 supabase 模式)。
 *
 * 注册走 Supabase Auth;Supabase 创建 auth.users 记录后,setup guide §4 trigger
 * 自动在 public.platform_users 插入 pending_approval 记录,等待平台管理员审批。
 * 注册成功后,后端 /api/users/me 返回 null(或 401 pending),前端 RequireAuth
 * 会把用户引导到 /pending 页面;所以这里注册成功后直接跳登录页。
 *
 * OIDC 模式(casdoor/客户 IdP)不支持自助注册:账号在认证中心/企业 IM 侧管理,
 * 渲染提示卡并引导去登录。
 */
export default function RegisterPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { mode } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null)

  const onFinish = async (values: RegisterForm) => {
    if (values.password !== values.confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const client = await getSupabaseClient()
      const { error: signUpError, data } = await client.auth.signUp({
        email: values.email,
        password: values.password,
        options: {
          data: {
            display_name: values.displayName ?? null,
            login_name: values.email.split('@')[0],
          },
        },
      })
      if (signUpError) throw signUpError
      // Supabase signUp 返回的 user 可能为 null(邮箱确认开启时)
      if (data.user && data.session === null) {
        // 邮箱确认流程:用户需点击邮件链接后才能登录
        setRegisteredEmail(values.email)
      } else if (data.session) {
        // 直接过会话(邮箱确认关闭时),新用户记录已插入 pending_approval
        message.success('注册成功,等待平台管理员审批')
        navigate('/pending', { replace: true })
      } else {
        // 数据中既没 session 也没 user,可能是同一邮箱已注册且未确认
        setRegisteredEmail(values.email)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '注册失败'
      setError(msg)
      message.error(msg)
    } finally {
      setLoading(false)
    }
  }

  if (mode === 'oidc') {
    return (
      <div className="auth-shell">
        <Card style={{ width: 420 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <BrandMark variant="auth" />
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              注册账号
            </Typography.Title>
            <Typography.Text type="secondary">云汉企业AI协同平台</Typography.Text>
          </div>
          <Alert
            type="info"
            showIcon
            message="本部署不支持自助注册"
            description="企业账号由认证中心统一管理。如需开通账号,请联系企业管理员;或使用企业 IM(钉钉/飞书)账号直接登录。"
          />
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            已有账号? <Link to="/login">去登录</Link>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="auth-shell">
      <Card style={{ width: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <BrandMark variant="auth" />
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            注册账号
          </Typography.Title>
          <Typography.Text type="secondary">云汉企业AI协同平台</Typography.Text>
        </div>

        {registeredEmail ? (
          <Alert
            type="success"
            showIcon
            message="注册已提交"
            description={
              <div>
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  我们已向 <Typography.Text strong>{registeredEmail}</Typography.Text> 发送确认邮件。
                  请点击邮件中的链接完成邮箱验证,然后等待平台管理员审批后登录。
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                  审批通过后,你才能登录后台使用应用管理、流程定义等功能。
                </Typography.Paragraph>
              </div>
            }
            action={
              <Button type="link" onClick={() => navigate('/login', { replace: true })}>
                去登录
              </Button>
            }
          />
        ) : (
          <>
            {error && (
              <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
            )}
            <Form<RegisterForm> layout="vertical" onFinish={onFinish} autoComplete="off">
              <Form.Item
                name="email"
                label="邮箱"
                rules={[
                  { required: true, message: '请输入邮箱' },
                  { type: 'email', message: '邮箱格式不正确' },
                ]}
              >
                <Input prefix={<MailOutlined />} placeholder="you@example.com" />
              </Form.Item>
              <Form.Item name="displayName" label="显示名(可选)">
                <Input prefix={<UserOutlined />} placeholder="张三" />
              </Form.Item>
              <Form.Item
                name="password"
                label="密码"
                rules={[
                  { required: true, message: '请输入密码' },
                  { min: 8, message: '密码至少 8 位' },
                ]}
              >
                <Input.Password prefix={<LockOutlined />} placeholder="至少 8 位" />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="确认密码"
                rules={[
                  { required: true, message: '请再次输入密码' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('password') === value) return Promise.resolve()
                      return Promise.reject(new Error('两次输入的密码不一致'))
                    },
                  }),
                ]}
              >
                <Input.Password prefix={<LockOutlined />} placeholder="再次输入密码" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  注册
                </Button>
              </Form.Item>
            </Form>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              注册后自动创建账号,但需平台管理员审批后才能登录后台。
            </Typography.Paragraph>
            <div style={{ textAlign: 'center' }}>
              已有账号? <Link to="/login">立即登录</Link>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
