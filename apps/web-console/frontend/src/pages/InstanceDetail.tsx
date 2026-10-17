import { ArrowLeftOutlined, CheckOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  instancesApi,
  type ContextVariableDto,
  type HistoricActivityDto,
  type ProcessInstanceDto,
  type ProcessLogEntryDto,
  type ProcessVariableDto,
  type StartFormVariableDto,
  type TaskDto,
} from '../api/process-instances'
import { type OrgPositionDto, runtimeApi } from '../api/runtime'
import { PLATFORM_ROLE } from '../api/types'
import { workflowsApi, type WorkflowDefinitionDto } from '../api/workflows'
import { useAuth } from '../auth/AuthContext'
import BpmnHistoryViewer from '../bpmn/BpmnHistoryViewer'
import { SubmitModal } from '../components/SubmitModal'
import { InstanceWorkspacePanel } from './InstanceWorkspacePanel'

/** 历史活动类型 → 中文名(路径图时间线展示用;未映射的类型原样显示)。 */
const ACTIVITY_TYPE_TEXT: Record<string, string> = {
  startEvent: '开始事件',
  endEvent: '结束事件',
  userTask: '用户任务',
  serviceTask: '服务任务',
  sendTask: '发送任务',
  receiveTask: '接收任务',
  manualTask: '手工任务',
  businessRuleTask: '业务规则任务',
  scriptTask: '脚本任务',
  callActivity: '调用活动',
  exclusiveGateway: '排他网关',
  parallelGateway: '并行网关',
  inclusiveGateway: '包容网关',
  eventBasedGateway: '事件网关',
  sequenceFlow: '连线',
}

/** 活动耗时(毫秒)→ 人读时长。 */
function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}分${rs}秒` : `${m}分钟`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}小时${rm}分` : `${h}小时`
}

/** 变量值 → 展示文本(对象/数组 pretty JSON;字符串原样)。 */
function formatVariableValue(v: unknown): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

export default function InstanceDetailPage() {
  const { instanceId = '' } = useParams()
  const [searchParams] = useSearchParams()

  // 当访问 /instances/new?workflowId=xxx 时,渲染新建实例表单
  if (instanceId === 'new') {
    const workflowId = searchParams.get('workflowId')
    if (!workflowId) {
      return (
        <Alert
          type="error"
          message="缺少 workflowId 参数"
          description={'请从流程定义列表的"发起"按钮进入。'}
          showIcon
        />
      )
    }
    return <InstanceStartForm workflowId={workflowId} />
  }

  return <InstanceDetailView instanceId={instanceId} />
}

function InstanceStartForm({ workflowId }: { workflowId: string }) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [wf, setWf] = useState<WorkflowDefinitionDto | null>(null)
  const [startVars, setStartVars] = useState<StartFormVariableDto[]>([])
  const [positions, setPositions] = useState<OrgPositionDto[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<Record<string, unknown>>()

  useEffect(() => {
    void (async () => {
      try {
        const data = await workflowsApi.get(workflowId)
        setWf(data)
        if (data.status !== 'published') {
          message.error(`流程当前状态为 ${data.status},不可发起`)
          return
        }
        // 启动表单变量清单(已部署 BPMN 的 start-param 声明)
        setStartVars(await instancesApi.startForm(workflowId))
      } catch (e) {
        message.error(e instanceof Error ? e.message : '加载流程定义失败')
      }
    })()
  }, [workflowId, message])

  useEffect(() => {
    // 当前用户组织身份:多身份时必选发起身份,唯一身份预选
    runtimeApi.myOrgPositions().then((list) => {
      setPositions(list ?? [])
      if (list && list.length === 1) {
        form.setFieldValue('orgUnitId', list[0].orgUnitId)
      }
    }).catch(() => {
      // 拉取失败不阻断表单:提交时后端仍会校验身份
    })
  }, [form])

  const submit = async () => {
    const values = await form.validateFields()
    // 按 start-param 声明组装变量:空值不传(由后端 initial 兜底),object/array 解析 JSON
    const variables: Record<string, unknown> = {}
    let parseError = false
    for (const v of startVars) {
      const raw = values[v.name]
      if (raw === undefined || raw === null || raw === '') continue
      if (v.type === 'object' || v.type === 'array') {
        try {
          variables[v.name] = JSON.parse(raw as string)
        } catch {
          message.error(`变量 ${v.name} 不是合法的 JSON`)
          parseError = true
        }
      } else if (v.type === 'boolean') {
        variables[v.name] = raw === true || raw === 'true'
      } else {
        variables[v.name] = raw
      }
    }
    if (parseError) return
    setSubmitting(true)
    try {
      const instance = await instancesApi.start({
        workflowDefinitionId: workflowId,
        businessKey: (values.businessKey as string) || undefined,
        name: (values.name as string) || undefined,
        orgUnitId: (values.orgUnitId as string) || undefined,
        variables,
      })
      message.success(`已启动实例 ${instance.id}`)
      navigate(`/instances/${instance.id}`, { replace: true })
    } catch (e) {
      message.error(e instanceof Error ? e.message : '启动失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (!wf) {
    return <Typography.Text type="secondary">加载流程定义...</Typography.Text>
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/workflows')}>
          返回流程定义
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          发起实例:{wf.name}
        </Typography.Title>
      </Space>

      <Descriptions
        bordered
        column={2}
        size="small"
        style={{ background: '#fff', marginBottom: 16 }}
        items={[
          { key: 'id', label: '流程定义 ID', children: wf.id },
          { key: 'name', label: '名称', children: wf.name },
          {
            key: 'status',
            label: '状态',
            children: <Tag color={wf.status === 'published' ? 'green' : 'default'}>{wf.status}</Tag>,
          },
          { key: 'procdefId', label: 'procdefId', children: wf.publishedProcdefId ?? '-' },
        ]}
      />

      <Form form={form} layout="vertical" style={{ maxWidth: 600 }}>
        {positions.length === 0 ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="当前账号未分配部门"
            description="流程将不以任何组织身份发起;若流程含同行政线审批节点,发起会被拒绝。可在「用户管理」页分配所属部门。"
          />
        ) : (
          <Form.Item
            name="orgUnitId"
            label="发起身份"
            tooltip="以哪个部门的身份发起:同行政线审批路由、上级链均按该部门解析"
            rules={positions.length > 1 ? [{ required: true, message: '存在多个组织身份,请选择发起身份' }] : undefined}
          >
            <Select
              allowClear={positions.length > 1}
              showSearch
              optionFilterProp="label"
              placeholder={positions.length > 1 ? '请选择以哪个部门身份发起' : '唯一组织身份'}
              options={positions.map(p => ({
                label: p.pathToRoot.join(' / '),
                value: p.orgUnitId,
              }))}
            />
          </Form.Item>
        )}
        <Form.Item name="businessKey" label="业务键">
          <Input placeholder="如订单号(可空)" />
        </Form.Item>
        <Form.Item name="name" label="实例名">
          <Input placeholder="便于查找的实例名(可空)" />
        </Form.Item>
        {startVars.map(v => (
          <Form.Item
            key={v.name}
            name={v.name}
            label={`${v.name} (${v.type})`}
            tooltip={v.description ?? undefined}
            rules={v.required ? [{ required: true, message: `请输入 ${v.name}` }] : undefined}
          >
            {renderStartParamInput(v.type)}
          </Form.Item>
        ))}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          表单项由流程的上下文声明(start-param)自动生成;未声明变量会被后端拒绝。
          应用隔离三变量(dsh_applicant_user_id / dsh_app_id / dsh_workflow_definition_id)由后端自动注入。
        </Typography.Paragraph>
        <Form.Item>
          <Button type="primary" loading={submitting} onClick={submit}>
            启动实例
          </Button>
        </Form.Item>
      </Form>
    </div>
  )
}

/** 按声明类型渲染 start-param 输入控件。 */
function renderStartParamInput(type: string) {
  switch (type) {
    case 'integer':
    case 'float':
      return <InputNumber style={{ width: '100%' }} placeholder={type === 'integer' ? '整数' : '小数'} />
    case 'boolean':
      return (
        <Select
          allowClear
          options={[
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
        />
      )
    case 'date':
      return <Input placeholder="yyyy-MM-dd,如 2026-01-31" />
    case 'datetime':
      return <Input placeholder="ISO-8601,如 2026-01-31T09:30:00" />
    case 'object':
    case 'array':
      return <Input.TextArea rows={3} placeholder='JSON 文本,如 {"k":"v"}' style={{ fontFamily: 'monospace' }} />
    default:
      return <Input placeholder="字符串" />
  }
}

/** 强制完成弹窗的变量映射行本地态。 */
type CompleteVarRow = { key: string; name: string; value: unknown }

/** 声明清单 → 平铺点路径选项(object 递归展开为 var.field;array 只出整体)。 */
function flattenVarOptions(decls: ContextVariableDto[], prefix = ''): { path: string; type: string }[] {
  const out: { path: string; type: string }[] = []
  for (const d of decls ?? []) {
    const name = (d.name ?? '').trim()
    if (!name) continue
    const path = prefix ? `${prefix}.${name}` : name
    out.push({ path, type: d.type ?? 'string' })
    if ((d.type ?? '') === 'object') {
      out.push(...flattenVarOptions(d.fields ?? [], path))
    }
  }
  return out
}

/** 在对象上按点路径设置值(自动创建中间对象);供 "a.b" 形式的映射行组装嵌套变量。 */
function setDeepPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (typeof current[p] !== 'object' || current[p] === null) {
      current[p] = {}
    }
    current = current[p] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

/** 强制完成弹窗:按声明类型渲染变量值输入控件(宽度撑满所在 flex 容器)。 */
function renderCompleteValueInput(type: string, value: unknown, onChange: (v: unknown) => void) {
  switch (type) {
    case 'integer':
      return (
        <InputNumber
          style={{ width: '100%' }}
          value={value as number}
          precision={0}
          placeholder="整数"
          onChange={v => onChange(v ?? undefined)}
        />
      )
    case 'float':
      return (
        <InputNumber
          style={{ width: '100%' }}
          value={value as number}
          placeholder="小数"
          onChange={v => onChange(v ?? undefined)}
        />
      )
    case 'boolean':
      return (
        <Select
          style={{ width: '100%' }}
          allowClear
          placeholder="true / false"
          value={(value as boolean) ?? undefined}
          options={[
            { value: true, label: 'true' },
            { value: false, label: 'false' },
          ]}
          onChange={v => onChange(v)}
        />
      )
    case 'date':
      return (
        <Input value={(value as string) ?? ''} placeholder="yyyy-MM-dd,如 2026-01-31" onChange={e => onChange(e.target.value)} />
      )
    case 'datetime':
      return (
        <Input value={(value as string) ?? ''} placeholder="ISO-8601,如 2026-01-31T09:30:00" onChange={e => onChange(e.target.value)} />
      )
    case 'object':
    case 'array':
      return (
        <Input.TextArea
          rows={2}
          style={{ fontFamily: 'monospace' }}
          value={(value as string) ?? ''}
          placeholder={type === 'object' ? 'JSON,如 {"k":"v"}' : 'JSON,如 ["a","b"]'}
          onChange={e => onChange(e.target.value)}
        />
      )
    default:
      return (
        <Input value={(value as string) ?? ''} placeholder="字符串" onChange={e => onChange(e.target.value)} />
      )
  }
}

function InstanceDetailView({ instanceId }: { instanceId: string }) {
  const { message } = App.useApp()
  const navigate = useNavigate()
  // 管理干预操作(终止/强制完成任务)仅 system_admin/app_admin 可见;
  // 普通用户只读查看自己发起的实例
  const { me } = useAuth()
  const isAdmin = (me?.roles ?? []).includes(PLATFORM_ROLE.SYSTEM_ADMIN)
    || (me?.roles ?? []).includes(PLATFORM_ROLE.APP_ADMIN)

  const [inst, setInst] = useState<ProcessInstanceDto | null>(null)
  const [tasks, setTasks] = useState<TaskDto[]>([])
  const [variables, setVariables] = useState<ProcessVariableDto[]>([])
  const [activities, setActivities] = useState<HistoricActivityDto[]>([])
  const [bpmnXml, setBpmnXml] = useState('')
  // 流程日志(引擎实例日志文件回读)与画布点击联动状态
  const [processLog, setProcessLog] = useState<ProcessLogEntryDto[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [loading, setLoading] = useState(false)
  const [terminateOpen, setTerminateOpen] = useState(false)
  const [terminating, setTerminating] = useState(false)
  const [terminateForm] = Form.useForm<{ reason?: string }>()
  const [completeTarget, setCompleteTarget] = useState<TaskDto | null>(null)
  // 强制完成弹窗的变量映射行;声明清单按实例缓存(null=未加载)
  const [completeVars, setCompleteVars] = useState<CompleteVarRow[]>([])
  const [decls, setDecls] = useState<ContextVariableDto[] | null>(null)
  const [completing, setCompleting] = useState(false)

  const load = useCallback(async () => {
    if (!instanceId) return
    setLoading(true)
    try {
      // 概要/任务失败提示;变量/活动/图/日志属于历史视图,拉不到时优雅降级为空
      const [instance, taskList, varList, actList, xml, logList] = await Promise.all([
        instancesApi.get(instanceId),
        instancesApi.listTasks(instanceId),
        instancesApi.listVariables(instanceId).catch(() => [] as ProcessVariableDto[]),
        instancesApi.listActivities(instanceId).catch(() => [] as HistoricActivityDto[]),
        instancesApi.getBpmnXml(instanceId).catch(() => ''),
        instancesApi.listProcessLog(instanceId).catch(() => [] as ProcessLogEntryDto[]),
      ])
      setInst(instance)
      setTasks(taskList ?? [])
      setVariables(varList ?? [])
      setActivities(actList ?? [])
      setBpmnXml(xml ?? '')
      setProcessLog(logList ?? [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载实例失败')
    } finally {
      setLoading(false)
    }
  }, [instanceId, message])

  useEffect(() => {
    void load()
  }, [load])

  // ===== 流程日志 × 画布联动 =====

  /** 画布节点点击:记住元素 id 作为日志过滤键(无匹配条目的节点自然清除高亮)。 */
  const handleCanvasClick = useCallback((elementId: string) => {
    setSelectedNodeId(elementId)
  }, [])

  /** 画布选中的节点在日志表中的命中条目(按 activityId 匹配)。 */
  const hitEntries = useMemo(
    () => (selectedNodeId ? processLog.filter(e => e.activityId === selectedNodeId) : []),
    [processLog, selectedNodeId],
  )

  /** 被选中节点的展示名:优先日志条目记录的节点名,退回活动时间线的节点名,再退回元素 id。 */
  const selectedNodeName = useMemo(() => {
    if (!selectedNodeId) return null
    return hitEntries.find(e => e.activityName)?.activityName
      ?? activities.find(a => a.activityId === selectedNodeId && a.activityName)?.activityName
      ?? selectedNodeId
  }, [selectedNodeId, hitEntries, activities])

  // 命中条目存在时滚动到第一条(平滑滚到表格中部,便于看到高亮上下文)
  const logTableRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selectedNodeId || hitEntries.length === 0) return
    // 等 antd Table 渲染完高亮行再滚动
    const timer = setTimeout(() => {
      const row = logTableRef.current?.querySelector('.dsh-log-hit-row')
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    return () => clearTimeout(timer)
  }, [selectedNodeId, hitEntries.length])

  // 点日志行反向定位:同一节点反复点击也重新闪亮(seq 自增)
  const flashSeqRef = useRef(0)
  const flashFromLog = (entry: ProcessLogEntryDto) => {
    if (!entry.activityId) return
    flashSeqRef.current += 1
    setFlash({ id: entry.activityId, seq: flashSeqRef.current })
  }

  // 运行中实例的自动刷新(10 秒轮询日志,backend task 跑着时可见实时轨迹)
  useEffect(() => {
    if (!autoRefresh || !inst || inst.ended) return
    const timer = setInterval(() => {
      instancesApi.listProcessLog(instanceId)
        .then(setProcessLog)
        .catch(() => { /* 轮询失败静默,下个周期重试 */ })
    }, 10_000)
    return () => clearInterval(timer)
  }, [autoRefresh, inst, instanceId])

  const submitTerminate = async () => {
    if (!inst) return
    const values = await terminateForm.validateFields()
    setTerminating(true)
    try {
      await instancesApi.terminate(inst.id, values.reason || undefined)
      message.success('已终止实例')
      setTerminateOpen(false)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '终止失败')
    } finally {
      setTerminating(false)
    }
  }

  /** 打开强制完成弹窗:清空映射行,首次拉取流程上下文声明清单。 */
  const openComplete = (task: TaskDto) => {
    setCompleteTarget(task)
    setCompleteVars([])
    if (decls === null) {
      void instancesApi.contextDeclarations(instanceId)
        .then(setDecls)
        .catch(() => setDecls([]))
    }
  }

  // 平铺点路径选项(object 展开 var.field)与 path→类型映射;未在清单中的干预变量按 string 处理
  const flatVars = useMemo(() => flattenVarOptions(decls ?? []), [decls])
  const varTypeMap = useMemo(() => new Map(flatVars.map(v => [v.path, v.type])), [flatVars])
  const varType = (name: string) => varTypeMap.get(name.trim()) ?? 'string'

  const updateCompleteVar = (key: string, patch: Partial<CompleteVarRow>) => {
    setCompleteVars(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  const addCompleteVar = () => {
    setCompleteVars(prev => [...prev, { key: `${Date.now()}-${Math.random()}`, name: '', value: undefined }])
  }

  const submitComplete = async () => {
    if (!inst || !completeTarget) return
    // 按映射行组装变量:空行跳过;object/array 按 JSON 文本解析(与启动表单同一约定);
    // 点路径行(a.b)组装为嵌套对象——Flowable complete 的键不会自动按点拆分
    const variables: Record<string, unknown> = {}
    let parseError = false
    for (const row of completeVars) {
      const name = row.name.trim()
      if (!name || row.value === undefined || row.value === null || row.value === '') continue
      const type = varType(name)
      let value: unknown = row.value
      if (type === 'object' || type === 'array') {
        try {
          value = JSON.parse(String(row.value))
        } catch {
          message.error(`变量 ${name} 不是合法的 JSON`)
          parseError = true
          continue
        }
      }
      if (name.includes('.')) {
        setDeepPath(variables, name, value)
      } else {
        variables[name] = value
      }
    }
    if (parseError) return
    setCompleting(true)
    try {
      await instancesApi.completeTask(inst.id, completeTarget.id, { variables })
      message.success(`已完成任务 ${completeTarget.name ?? completeTarget.id}`)
      setCompleteTarget(null)
      setCompleteVars([])
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '完成任务失败')
    } finally {
      setCompleting(false)
    }
  }

  const taskColumns: ColumnsType<TaskDto> = [
    { title: '任务 ID', dataIndex: 'id', key: 'id', render: v => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
    { title: '任务名', dataIndex: 'name', key: 'name', render: (v: string | null) => v ?? '-' },
    { title: '节点 key', dataIndex: 'taskDefinitionKey', key: 'taskDefinitionKey' },
    { title: '办理人', dataIndex: 'assigneeName', key: 'assigneeName', render: (v: string | null, task: TaskDto) => v ?? task.assignee ?? '-' },
    { title: 'owner', dataIndex: 'owner', key: 'owner', render: (v: string | null) => v ?? '-' },
    {
      title: '创建时间',
      dataIndex: 'createTime',
      key: 'createTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '完成时间',
      dataIndex: 'endTime',
      key: 'endTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, task) => {
        if (task.endTime) {
          return <Tag color={task.deleteReason ? 'red' : 'default'}>{task.deleteReason ? '已终止' : '已完成'}</Tag>
        }
        return <Tag color="blue">{task.assignee ? '待办理' : '待 claim'}</Tag>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, task) =>
        !isAdmin || task.endTime ? null : (
          <Button
            size="small"
            type="link"
            icon={<CheckOutlined />}
            onClick={() => openComplete(task)}
          >
            完成
          </Button>
        ),
    },
  ]

  const activityColumns: ColumnsType<HistoricActivityDto> = [
    {
      title: '节点',
      key: 'activityName',
      render: (_, act) => act.activityName ?? act.activityId,
    },
    {
      title: '类型',
      dataIndex: 'activityType',
      key: 'activityType',
      render: (v: string) => ACTIVITY_TYPE_TEXT[v] ?? v,
    },
    {
      title: '处理人',
      dataIndex: 'assigneeName',
      key: 'assigneeName',
      render: (v: string | null, act: HistoricActivityDto) => v ?? act.assignee ?? '-',
    },
    {
      title: '开始时间',
      dataIndex: 'startTime',
      key: 'startTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '结束时间',
      dataIndex: 'endTime',
      key: 'endTime',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '耗时',
      dataIndex: 'durationInMillis',
      key: 'durationInMillis',
      render: (v: number | null) => formatDuration(v),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, act) =>
        act.endTime ? <Tag color="green">已完成</Tag> : <Tag color="blue">进行中</Tag>,
    },
  ]

  const variableColumns: ColumnsType<ProcessVariableDto> = [
    {
      title: '变量名',
      dataIndex: 'name',
      key: 'name',
      width: 240,
      render: v => <Typography.Text code style={{ whiteSpace: 'nowrap' }}>{v}</Typography.Text>,
    },
    { title: '类型', dataIndex: 'type', key: 'type', width: 100, render: (v: string | null) => v ?? '-' },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      render: (v: unknown) => (
        <Typography.Text
          style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}
        >
          {formatVariableValue(v)}
        </Typography.Text>
      ),
    },
    {
      title: '最后更新',
      dataIndex: 'lastUpdatedTime',
      key: 'lastUpdatedTime',
      width: 180,
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
  ]

  const logColumns: ColumnsType<ProcessLogEntryDto> = [
    {
      title: '时间戳',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 200,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '节点名称',
      key: 'node',
      width: 200,
      render: (_, entry) => entry.activityName ?? entry.activityId ?? '-',
    },
    {
      title: '日志详情',
      key: 'detail',
      render: (_, entry) => (
        <Typography.Text
          style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        >
          {entry.message ?? entry.raw ?? '-'}
        </Typography.Text>
      ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/instances')}>
          返回列表
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          实例详情
        </Typography.Title>
        {isAdmin && inst && !inst.ended && (
          <Popconfirm title="确认终止实例?" onConfirm={() => setTerminateOpen(true)}>
            <Button danger icon={<StopOutlined />}>终止</Button>
          </Popconfirm>
        )}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </Space>

      <Descriptions
        bordered
        column={2}
        size="small"
        style={{ background: '#fff', marginBottom: 16 }}
        items={[
          { key: 'id', label: '实例 ID', children: <Typography.Text code>{inst?.id ?? '-'}</Typography.Text> },
          { key: 'name', label: '实例名', children: inst?.name ?? '-' },
          { key: 'workflowName', label: '流程名', children: inst?.workflowName ?? inst?.processDefinitionName ?? '-' },
          { key: 'businessKey', label: '业务键', children: inst?.businessKey ?? '-' },
          { key: 'procdefId', label: 'procdefId', children: inst?.processDefinitionId ?? '-' },
          { key: 'startUserId', label: '发起人', children: inst?.startUserName ?? inst?.startUserId ?? '-' },
          {
            key: 'startTime',
            label: '启动时间',
            children: inst?.startTime ? dayjs(inst.startTime).format('YYYY-MM-DD HH:mm:ss') : '-',
          },
          {
            key: 'status',
            label: '状态',
            children: inst ? (
              inst.ended ? (
                <Tag color={inst.deleteReason ? 'red' : 'green'}>{inst.deleteReason ? '已终止' : '已完成'}</Tag>
              ) : (
                <Tag color={inst.suspended ? 'orange' : 'blue'}>{inst.suspended ? '已挂起' : '运行中'}</Tag>
              )
            ) : '-',
          },
          {
            key: 'endTime',
            label: '结束时间',
            children: inst?.endTime ? dayjs(inst.endTime).format('YYYY-MM-DD HH:mm:ss') : '-',
          },
          {
            key: 'deleteReason',
            label: '终止原因',
            children: inst?.deleteReason ?? '-',
          },
        ]}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>历史活动路径</Typography.Title>
      {bpmnXml ? (
        <>
          <Space style={{ marginBottom: 8 }} size={16}>
            <span>
              <span style={{ display: 'inline-block', width: 12, height: 12, background: '#d9f7be', border: '2px solid #52c41a', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />
              已完成
            </span>
            <span>
              <span style={{ display: 'inline-block', width: 12, height: 12, background: '#bae0ff', border: '2px solid #1677ff', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />
              进行中
            </span>
            <span>
              <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2.5px solid #52c41a', marginRight: 4, verticalAlign: 3 }} />
              已走过连线
            </span>
          </Space>
          <BpmnHistoryViewer
            xml={bpmnXml}
            activities={activities}
            onElementClick={handleCanvasClick}
            flashElementId={flash?.id ?? null}
            flashSeq={flash?.seq}
          />
        </>
      ) : (
        <Alert
          type="info"
          showIcon
          message="未获取到部署版 BPMN XML,无法渲染活动路径图"
          description="旧版本部署可能已被新发布覆盖;活动时间线仍可用。"
          style={{ marginBottom: 16 }}
        />
      )}

      <Typography.Title level={5} style={{ marginTop: 24, fontSize: 14 }}>
        流程日志
        {selectedNodeId && (
          <Tag
            color="orange"
            closable
            style={{ marginLeft: 8, fontWeight: 'normal' }}
            onClose={() => setSelectedNodeId(null)}
          >
            {selectedNodeName}:{hitEntries.length} 条日志
          </Tag>
        )}
      </Typography.Title>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12 }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          自动节点(backend task / service task)的运行轨迹;点击上方流程图节点可高亮该节点的日志,点击日志行可在图中定位节点。
        </Typography.Text>
        {inst && !inst.ended && (
          <Space size={4} style={{ flexShrink: 0 }}>
            <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
            <span style={{ fontSize: 12, color: '#888' }}>自动刷新(10s)</span>
          </Space>
        )}
      </div>
      <div ref={logTableRef} className="dsh-process-log-table">
        <Table<ProcessLogEntryDto>
          rowKey={(_, index) => String(index)}
          columns={logColumns}
          dataSource={processLog}
          loading={loading}
          pagination={processLog.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
          size="small"
          locale={{ emptyText: '暂无流程日志(仅自动节点写入;user task / 网关不产生日志)' }}
          rowClassName={entry =>
            selectedNodeId && entry.activityId === selectedNodeId ? 'dsh-log-hit-row' : ''
          }
          onRow={entry => ({
            onClick: () => flashFromLog(entry),
            style: entry.activityId ? { cursor: 'pointer' } : undefined,
          })}
        />
      </div>

      <Typography.Title level={5} style={{ marginTop: 24, fontSize: 14 }}>活动时间线</Typography.Title>
      <Table<HistoricActivityDto>
        rowKey="id"
        columns={activityColumns}
        dataSource={activities}
        loading={loading}
        pagination={false}
        size="small"
        scroll={{ x: 900 }}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>任务列表</Typography.Title>
      <Table<TaskDto>
        rowKey="id"
        columns={taskColumns}
        dataSource={tasks}
        loading={loading}
        pagination={false}
        size="small"
        scroll={{ x: 900 }}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>流程变量</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        运行中实例显示当前值;已结束实例显示终值。dsh_* 前缀为系统注入的应用隔离与身份变量。
      </Typography.Paragraph>
      <Table<ProcessVariableDto>
        rowKey="name"
        columns={variableColumns}
        dataSource={variables}
        loading={loading}
        pagination={false}
        size="small"
        tableLayout="fixed"
      />

      <InstanceWorkspacePanel instanceId={instanceId} />

      <SubmitModal
        title="终止实例"
        open={terminateOpen}
        onCancel={() => setTerminateOpen(false)}
        onOk={submitTerminate}
        submitting={terminating}
        destroyOnClose
      >
        <Form form={terminateForm} layout="vertical">
          <Form.Item name="reason" label="终止原因">
            <Input.TextArea rows={3} placeholder="可空" />
          </Form.Item>
        </Form>
      </SubmitModal>

      <SubmitModal
        title={completeTarget ? `完成任务: ${completeTarget.name ?? completeTarget.id}` : '完成任务'}
        open={!!completeTarget}
        width={680}
        onCancel={() => setCompleteTarget(null)}
        onOk={submitComplete}
        submitting={completing}
        destroyOnClose
      >
        {completeVars.map(row => (
          <div
            key={row.key}
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}
          >
            <AutoComplete
              style={{ width: 220, flexShrink: 0 }}
              value={row.name}
              options={flatVars.map(v => ({ value: v.path, label: `${v.path} (${v.type})` }))}
              filterOption={(input, option) =>
                String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
              placeholder="选择或输入变量名"
              onChange={v => updateCompleteVar(row.key, { name: v })}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              {renderCompleteValueInput(
                varType(row.name),
                row.value,
                v => updateCompleteVar(row.key, { value: v }),
              )}
            </div>
            <Button
              size="small"
              type="text"
              icon={<DeleteOutlined />}
              style={{ flexShrink: 0 }}
              onClick={() => setCompleteVars(prev => prev.filter(r => r.key !== row.key))}
            />
          </div>
        ))}
        <Button size="small" icon={<PlusOutlined />} onClick={addCompleteVar}>
          添加变量
        </Button>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
          变量清单来自流程上下文声明(名称后括号是类型);object 变量已展开为点路径字段,提交时自动组装为嵌套对象;object/array 顶层可整体填 JSON 文本。
          清单外的变量可手动输入变量名写入。留空的行提交时忽略。
        </Typography.Paragraph>
        <Typography.Paragraph type="warning" style={{ fontSize: 12 }}>
          管理员强制完成：不经过员工端 AI 对话与输出映射校验，直接调用引擎 complete 任务。
          仅用于端到端联调或管理员干预，正式办理请通过 DSH 员工端「我的待办」提交。
        </Typography.Paragraph>
      </SubmitModal>
    </div>
  )
}
