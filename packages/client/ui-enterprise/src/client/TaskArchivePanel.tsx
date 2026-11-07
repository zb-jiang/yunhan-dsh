/**
 * 任务档案标签页:rightbar 标签页系统 `sidebar.right.pane.tab` 座位的企业占据者。
 *
 * <p>当前会话绑定待办时展示任务档案四件套 —— 任务信息 / 任务指令(重新填入) /
 * 流程进度(部署版 BPMN 迷你图,支持分支与并行;下方"流程节点"执行记录为
 * 折叠区块)/ 上下文变量带值(折叠区块)——流程节点与上下文变量两区块默认
 * 折叠手动展开,并自动提取最近一个 AI 输出 JSON(整段会话向前扫描,不随后续纯文本回复
 * 丢失);需要更早的历史块时,在 AI 输出区的下拉中选回,选中值经映射确认
 * 对话框提交待办。提交后:会话回执能在"已完成"列表定位引擎历史任务时
 * 渲染完整完成档案(进度/变量/执行记录),否则退化为最小回执;选中已完成
 * 任务(无本地会话)渲染只读档案;未绑定会话渲染空态。会话区(中间栏)
 * 保持原生 ConversationRoot,员工零复制粘贴。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconTriangleRightFillRegular, JsonTree,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { ARCHIVE_TAB_ID, type EnterpriseWorkbench } from './enterprise-workbench.ts'
import { JSON_TREE_LABELS } from './jsonTreeLabels.ts'
import { TaskSubmitDialog } from './TaskSubmitDialog.tsx'
import type {
  CompletedTask, ContextVariable, HistoricActivity, HistoricVariable, Task,
} from './task-api.ts'
import { getBpmnXml, getHistoricActivities, getHistoricVariables } from './task-api.ts'
import { parseMiniBpmn } from './bpmn-xml.ts'
import type { MiniBpmnDiagram } from './bpmn-xml.ts'
import { ProcessDiagram } from './workbench/ProcessDiagram.tsx'
import {
  activityStatuses, collectJsonBlocks, executionRecords, latestJson,
} from './workbench/pure.ts'
import { formatShortTime, useSnapshot } from './workbench/hooks.ts'
import css from './TaskArchivePanel.module.css'

/** 档案标签页注入面:工作台编排器(关闭走 tabInfo 的 tab actions)。 */
export type TaskArchivePanelInjected = {
  workbench: EnterpriseWorkbench
}

/** 档案标签页组件 props:session 标准套件 + tabInfo 钩子 + 注入面。 */
export type TaskArchivePanelProps =
  & PropsRuntime<'sidebar.right.pane.tab', typeof ARCHIVE_TAB_ID>
  & TaskArchivePanelInjected

/** 流程进度/变量区块的数据面(一次按实例聚合拉取)。 */
type ArchiveData = {
  loading: boolean
  error: string | null
  activities: readonly HistoricActivity[]
  variables: readonly HistoricVariable[]
  diagram: MiniBpmnDiagram | null
}

const ARCHIVE_EMPTY: ArchiveData = {
  loading: false, error: null, activities: [], variables: [], diagram: null,
}

/** 活动类型 → 人读标签(缺省原样返回)。 */
const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  startEvent: '开始', endEvent: '结束',
  userTask: '人工任务', serviceTask: '服务任务', scriptTask: '脚本任务',
  sendTask: '发送任务', receiveTask: '接收任务', manualTask: '手工任务',
  businessRuleTask: '规则任务', callActivity: '调用活动',
  exclusiveGateway: '排他网关', parallelGateway: '并行网关',
  inclusiveGateway: '相容网关', eventBasedGateway: '事件网关',
  boundaryEvent: '边界事件', intermediateCatchEvent: '捕获事件',
  intermediateThrowEvent: '抛出事件', subProcess: '子流程',
}

function activityTypeLabel(type: string): string {
  return ACTIVITY_TYPE_LABELS[type] ?? type
}

/** 变量值的人读格式:JSON 一行,超长截断。 */
function formatValue(value: unknown): string {
  const text = value === undefined ? 'null' : JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

/** 档案折叠区块头:chevron(展开右转 90°)+ 标题 + 计数;点击切换展开。
 *  流程节点执行记录与上下文变量用(两区块默认折叠手动展开)。
 */
function ArchiveDisclosure(props: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const { label, count, open, onToggle, children } = props
  return (
    <>
      <button type="button" className={css.disclosure} aria-expanded={open} onClick={onToggle}>
        <IconTriangleRightFillRegular
          className={clsx(css.disclosureChevron, open && css.disclosureChevronOpen)}
        />
        <span className={css.disclosureLabel}>{label}</span>
        <span className={css.disclosureCount}>{count}</span>
      </button>
      {open && children}
    </>
  )
}

/** 流程节点执行记录列表(流程进度迷你图下方的折叠区块内容)。 */
function NodeRecords(props: { records: readonly HistoricActivity[] }) {
  const { records } = props
  if (records.length === 0) return <div className={css.hint}>暂无节点记录</div>
  return (
    <div className={css.records}>
      {records.map(record => (
        <div key={record.id} className={css.recordRow}>
          <span className={`${css.recordDot} ${record.endTime === null ? css.recordDotActive : ''}`} />
          <span className={css.recordName}>
            {record.activityName ?? record.activityId}
            <span className={css.recordType}>{activityTypeLabel(record.activityType)}</span>
          </span>
          <span className={css.recordTime}>
            {record.startTime !== null ? formatShortTime(record.startTime) : ''}
            {record.endTime === null ? ' …' : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

/** 档案数据的实例定位面(待办与已完成历史任务共有的定位字段)。 */
type ArchiveTaskRef = Pick<Task, 'processInstanceId' | 'processDefinitionId'>

/**
 * 按流程实例聚合拉取档案数据(活动/变量/部署版 XML→迷你图)。
 * 切换任务时以序号守卫丢弃过期响应;XML 解析失败只降级迷你图不报错。
 *
 * <p>refreshKey(绑定任务 id)参与依赖:同一实例内流程推进到下一任务时
 * 重取活动,避免迷你图停在旧快照、进行中节点不亮。
 */
function useArchiveData(task: ArchiveTaskRef | undefined, refreshKey: string | undefined): ArchiveData {
  const instanceId = task?.processInstanceId
  const definitionId = task?.processDefinitionId
  const [state, setState] = useState<ArchiveData>(ARCHIVE_EMPTY)

  useEffect(() => {
    if (instanceId === undefined || definitionId === undefined) {
      setState(ARCHIVE_EMPTY)
      return
    }
    let live = true
    setState({ ...ARCHIVE_EMPTY, loading: true })
    void (async () => {
      try {
        const [activities, variables, xml] = await Promise.all([
          getHistoricActivities(instanceId),
          getHistoricVariables(instanceId),
          getBpmnXml(definitionId),
        ])
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- tsgolint cannot track the closure-mutated `live` flag
        if (!live) return
        setState({
          loading: false, error: null, activities, variables,
          diagram: parseMiniBpmn(xml),
        })
      } catch (e) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- tsgolint cannot track the closure-mutated `live` flag
        if (!live) return
        setState({
          ...ARCHIVE_EMPTY,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })()
    return () => { live = false }
  }, [instanceId, definitionId, refreshKey])

  return state
}

/** 任务档案标签页(见模块文档)。 */
export function TaskArchivePanel({ sessionId, useSession, useChat, useTabInfo, workbench }: TaskArchivePanelProps) {
  const tasks = useSnapshot(workbench.tasks)
  const bindings = useSnapshot(workbench.bindings)
  const nodes = useChat(s => s.legacy.nodes)
  const running = useSession(s => s.running)
  // 关闭动作:走本标签页的 tab actions(与标签条自带关闭同一语义)。
  const tabInfo = useTabInfo()
  const closeDetails = () => { tabInfo.tab.actions.close() }

  const taskId = bindings.sessionToTask[sessionId]
  const task = taskId === undefined ? undefined : tasks.items.find(item => item.id === taskId)
  const completed = bindings.completedBySession[sessionId]
  // 回执对应的引擎历史任务(在"已完成"列表中定位);找到则右栏渲染完整
  // 流程档案(进度/变量/执行记录),不在近期列表时退化为最小回执。
  const completedTask = completed === undefined
    ? undefined
    : tasks.completed.find(item => item.id === completed.taskId)
  const selectedCompleted = tasks.selectedCompleted
  const archiveTask = task ?? selectedCompleted ?? completedTask ?? undefined
  const archive = useArchiveData(archiveTask, archiveTask?.id)

  // 手动切换会话(原生 workspaces 浏览)时退出已完成任务的只读视图;
  // 挂载本身不清(否则面板随会话出现而挂载时会把刚选中的只读档案清掉)。
  const lastSessionId = useRef(sessionId)
  useEffect(() => {
    if (lastSessionId.current === sessionId) return
    lastSessionId.current = sessionId
    workbench.clearSelectedCompleted()
  }, [sessionId, workbench])

  // 下拉选中的历史 JSON 块(按助手回复序号);undefined = 跟随最新。
  const [pickedNo, setPickedNo] = useState<number | undefined>(undefined)
  // 切换会话即回到"自动(最新)":点选只在本会话内有效。
  useEffect(() => { setPickedNo(undefined) }, [sessionId])
  // 展示优先级:下拉选中的历史块 > 自动提取的最近 JSON(整段会话向前
  // 扫描,后续纯文本回复不会清空输出区)。
  const blocks = useMemo(() => collectJsonBlocks(nodes), [nodes])
  const json = useMemo(() => {
    const picked = pickedNo === undefined
      ? undefined
      : blocks.find(block => block.messageNo === pickedNo)
    return picked?.value ?? latestJson(nodes)
  }, [blocks, pickedNo, nodes])
  const jsonTreeData = useMemo<object | unknown[] | null>(() => {
    if (json === null || typeof json !== 'object') return null
    return json
  }, [json])
  const jsonText = useMemo(
    () => (json === undefined ? '' : JSON.stringify(json, null, 2)),
    [json],
  )

  const [submitOpen, setSubmitOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const statuses = useMemo(() => activityStatuses(archive.activities), [archive.activities])
  const records = useMemo(() => executionRecords(archive.activities), [archive.activities])
  const valuesByName = useMemo(
    () => new Map(archive.variables.map(v => [v.variableName, v])),
    [archive.variables],
  )
  // 流程节点与上下文变量默认折叠手动展开;跨任务切换保持展开状态。
  const [nodesOpen, setNodesOpen] = useState(false)
  const [varsOpen, setVarsOpen] = useState(false)

  const handleSubmit = (variables: Record<string, unknown>): void => {
    if (task === undefined) return
    setSubmitting(true)
    setSubmitError(null)
    workbench.submitTask(task, variables)
      .then(() => { setSubmitOpen(false) })
      .catch((e: unknown) => { setSubmitError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { setSubmitting(false) })
  }

  return (
    <div className={css.root}>
      {selectedCompleted !== null
        ? <CompletedArchive task={selectedCompleted} archive={archive} closeDetails={closeDetails} />
        : task === undefined
          ? (
            completedTask !== undefined
              ? <CompletedArchive task={completedTask} archive={archive} closeDetails={closeDetails} />
              : (
                <div className={css.placeholder}>
                  {completed !== undefined
                    ? (
                      <div className={css.receipt}>
                        <div className={css.receiptBadge}>已提交</div>
                        <div className={css.receiptName}>{completed.taskName}</div>
                        <div className={css.receiptTime}>
                          完成于 {formatShortTime(new Date(completed.submittedAt).toISOString())}
                        </div>
                        <div className={css.receiptHint}>
                          本会话已保留,可继续查阅处理过程;左侧「已完成」可再次进入。
                        </div>
                      </div>
                    )
                    : <div className={css.emptyHint}>当前会话未绑定待办任务</div>}
                </div>
              )
          )
          : (
            <>
              <div className={css.header}>
                <div className={css.headerMain}>
                  <div className={css.title}>{task.name ?? task.id}</div>
                  <div className={css.subtitle}>{task.processDefinitionName ?? task.processDefinitionId}</div>
                </div>
                <button type="button" className={css.close} onClick={closeDetails} aria-label="关闭档案栏">
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className={css.body}>
                <section className={css.section}>
                  <div className={css.sectionTitle}>任务信息</div>
                  <div className={css.infoGrid}>
                    <span className={css.infoLabel}>发起人</span>
                    <span className={css.infoValue}>{task.startUserName ?? task.startUserId ?? '未知'}</span>
                    <span className={css.infoLabel}>到达时间</span>
                    <span className={css.infoValue}>{formatShortTime(task.createTime)}</span>
                    <span className={css.infoLabel}>流程实例</span>
                    <span className={clsx(css.infoValue, css.infoValueMono)} title={task.processInstanceId}>
                      {task.processInstanceId.slice(0, 13)}…
                    </span>
                  </div>
                </section>

                <section className={css.section}>
                  <div className={css.sectionTitle}>
                    任务指令
                    <button
                      type="button"
                      className={css.linkButton}
                      disabled={(task.dshMeta?.userPrompt ?? '') === ''}
                      onClick={() => { workbench.reinsertPrompt(task, sessionId) }}
                      title="把设计时配置的任务指令重新填入输入框"
                    >
                      重新填入
                    </button>
                  </div>
                  <pre className={css.prompt}>
                    {task.dshMeta?.userPrompt ?? '（本任务未配置指令）'}
                  </pre>
                </section>

                <section className={css.section}>
                  <div className={css.sectionTitle}>流程进度</div>
                  {archive.loading && <div className={css.hint}>加载中…</div>}
                  {archive.error !== null && <div className={css.error}>{archive.error}</div>}
                  {!archive.loading && archive.error === null && (
                    <>
                      {archive.diagram !== null && (
                        <ProcessDiagram
                          diagram={archive.diagram}
                          statuses={statuses}
                          currentActivityId={task.nodeId ?? task.taskDefinitionKey}
                        />
                      )}
                      <ArchiveDisclosure
                        label="流程节点"
                        count={records.length}
                        open={nodesOpen}
                        onToggle={() => { setNodesOpen(v => !v) }}
                      >
                        <NodeRecords records={records} />
                      </ArchiveDisclosure>
                    </>
                  )}
                </section>

                <section className={css.section}>
                  <ArchiveDisclosure
                    label="上下文变量"
                    count={(task.dshMeta?.contextVariables ?? []).length}
                    open={varsOpen}
                    onToggle={() => { setVarsOpen(v => !v) }}
                  >
                    <ContextVariables
                      declarations={task.dshMeta?.contextVariables ?? []}
                      valuesByName={valuesByName}
                    />
                  </ArchiveDisclosure>
                </section>

                <section className={css.section}>
                  <div className={css.sectionTitle}>
                    AI 输出
                    {running && <span className={css.runningTag}>生成中…</span>}
                    {blocks.length > 0 && (
                      <select
                        className={css.select}
                        value={pickedNo === undefined ? '' : String(pickedNo)}
                        onChange={(e) => {
                          setPickedNo(e.target.value === '' ? undefined : Number(e.target.value))
                        }}
                        aria-label="选择 AI 输出 JSON 块"
                      >
                        <option value="">自动(最新)</option>
                        {blocks.map(block => (
                          <option key={block.messageNo} value={String(block.messageNo)}>
                            {`第${block.messageNo}条 · ${block.preview}`}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {jsonTreeData !== null
                    ? <JsonTree data={jsonTreeData} label="AI 输出 JSON" labels={JSON_TREE_LABELS} />
                    : (
                      <div className={css.hint}>
                        {running
                          ? 'AI 正在处理,完成后这里自动提取最新的 JSON 输出。'
                          : '暂无可提取的 JSON 输出 —— 在会话区发送任务指令后,AI 输出中的 JSON 会自动显示在这里。'}
                      </div>
                    )}
                  <Button
                    className={css.submitButton}
                    disabled={json === undefined}
                    onClick={() => { setSubmitOpen(true) }}
                  >
                    提交待办
                  </Button>
                </section>
              </div>

              <TaskSubmitDialog
                key={task.id}
                open={submitOpen}
                task={task}
                jsonText={jsonText}
                submitting={submitting}
                submitError={submitError}
                onClose={() => { setSubmitOpen(false) }}
                onSubmit={handleSubmit}
              />
            </>
          )}
    </div>
  )
}

/** 耗时的人读格式(毫秒 → `x 分 y 秒`/`x 秒`;null 保持空)。 */
function formatDuration(millis: number | null): string {
  if (millis === null || millis < 0) return ''
  const seconds = Math.round(millis / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
}

/** 已完成任务的只读档案(引擎历史数据;无本地会话时的回看视图)。 */
function CompletedArchive(props: {
  task: CompletedTask
  archive: ArchiveData
  closeDetails: () => void
}) {
  const { task, archive, closeDetails } = props
  const statuses = useMemo(() => activityStatuses(archive.activities), [archive.activities])
  const records = useMemo(() => executionRecords(archive.activities), [archive.activities])
  const valuesByName = useMemo(
    () => new Map(archive.variables.map(v => [v.variableName, v])),
    [archive.variables],
  )
  // 与待办档案一致:流程节点与上下文变量默认折叠手动展开。
  const [nodesOpen, setNodesOpen] = useState(false)
  const [varsOpen, setVarsOpen] = useState(false)

  return (
    <>
      <div className={css.header}>
        <div className={css.headerMain}>
          <div className={css.title}>{task.name ?? task.id}</div>
          <div className={css.subtitle}>已完成任务(只读)</div>
        </div>
        <button type="button" className={css.close} onClick={closeDetails} aria-label="关闭档案栏">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className={css.body}>
        <section className={css.section}>
          <div className={css.sectionTitle}>任务信息</div>
          <div className={css.infoGrid}>
            <span className={css.infoLabel}>完成时间</span>
            <span className={css.infoValue}>
              {task.endTime !== null ? formatShortTime(task.endTime) : '—'}
            </span>
            <span className={css.infoLabel}>处理耗时</span>
            <span className={css.infoValue}>{formatDuration(task.durationInMillis) || '—'}</span>
            <span className={css.infoLabel}>流程实例</span>
            <span className={clsx(css.infoValue, css.infoValueMono)} title={task.processInstanceId}>
              {task.processInstanceId.slice(0, 13)}…
            </span>
          </div>
        </section>

        <section className={css.section}>
          <div className={css.sectionTitle}>流程进度</div>
          {archive.loading && <div className={css.hint}>加载中…</div>}
          {archive.error !== null && <div className={css.error}>{archive.error}</div>}
          {!archive.loading && archive.error === null && (
            <>
              {archive.diagram !== null && (
                <ProcessDiagram diagram={archive.diagram} statuses={statuses} currentActivityId={null} />
              )}
              <ArchiveDisclosure
                label="流程节点"
                count={records.length}
                open={nodesOpen}
                onToggle={() => { setNodesOpen(v => !v) }}
              >
                <NodeRecords records={records} />
              </ArchiveDisclosure>
            </>
          )}
        </section>

        <section className={css.section}>
          <ArchiveDisclosure
            label="上下文变量"
            count={(task.dshMeta?.contextVariables ?? []).length}
            open={varsOpen}
            onToggle={() => { setVarsOpen(v => !v) }}
          >
            <ContextVariables
              declarations={task.dshMeta?.contextVariables ?? []}
              valuesByName={valuesByName}
            />
          </ArchiveDisclosure>
        </section>
      </div>
    </>
  )
}

/** 上下文变量声明 + 实例当前值的合并展示。 */
function ContextVariables(props: {
  declarations: readonly ContextVariable[]
  valuesByName: ReadonlyMap<string, HistoricVariable>
}) {
  const { declarations, valuesByName } = props
  if (declarations.length === 0) {
    return <div className={css.hint}>本流程未声明上下文变量</div>
  }
  return (
    <div className={css.variables}>
      {declarations.map((declaration) => {
        const value = valuesByName.get(declaration.name)
        return (
          <div key={declaration.name} className={css.variableRow} title={declaration.description ?? undefined}>
            <span className={css.variableName}>{declaration.name}</span>
            <span className={css.variableType}>{declaration.type}</span>
            <span className={css.variableValue}>
              {value === undefined ? '（未赋值）' : formatValue(value.value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
