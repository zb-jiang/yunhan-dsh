import { Alert, Button, Card, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/Brand'

const STATUS_TEXT: Record<string, string> = {
  pending_approval: '待审批',
  disabled: '已禁用',
  locked: '已锁定',
}

export default function PendingPage() {
  const { me, signOut } = useAuth()
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  const status = me?.status ?? 'pending_approval'
  const text = STATUS_TEXT[status] ?? status

  return (
    <div className="auth-shell">
      <Card style={{ width: 420, textAlign: 'center' }}>
        <BrandMark variant="auth" />
        <Typography.Title level={3} style={{ marginBottom: 8 }}>
          账号状态:{text}
        </Typography.Title>
        <Alert
          type={status === 'pending_approval' ? 'info' : 'warning'}
          showIcon
          message={
            status === 'pending_approval'
              ? '您的账号已提交,正在等待平台管理员审批。'
              : status === 'disabled'
                ? '您的账号已被平台管理员禁用,请联系管理员恢复。'
                : '您的账号因多次登录失败等原因被锁定,请联系管理员。'
          }
          description={
            <Typography.Paragraph style={{ marginBottom: 0, marginTop: 8 }}>
              邮箱:{me?.email ?? '未知'} <br />
              姓名:{me?.displayName || me?.loginName || '未知'}
            </Typography.Paragraph>
          }
          style={{ marginBottom: 16, textAlign: 'left' }}
        />
        <Button type="primary" block onClick={handleSignOut}>
          退出登录
        </Button>
      </Card>
    </div>
  )
}
