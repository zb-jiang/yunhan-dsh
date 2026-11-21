package com.dsh.console.runtime;

import com.dsh.console.app.ApplicationService;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.runtime.dto.ContextVariableDto;
import com.dsh.console.runtime.dto.HistoricActivityDto;
import com.dsh.console.runtime.dto.ProcessInstanceDto;
import com.dsh.console.runtime.dto.ProcessLogEntryDto;
import com.dsh.console.runtime.dto.ProcessVariableDto;
import com.dsh.console.runtime.dto.StartFormVariableDto;
import com.dsh.console.runtime.dto.StartProcessInstanceRequest;
import com.dsh.console.runtime.dto.TaskDto;
import com.dsh.console.security.AuthContext;
import com.dsh.console.security.PlatformRole;
import com.dsh.console.user.UserService;
import com.dsh.console.workflow.BpmnContextParser;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 流程实例运行时业务编排。
 *
 * <p>V1 由 Web Console 后端发起实例启动与查询,作为端到端联调入口(spec §6.3):
 * <ul>
 *   <li>启动实例:校验 workflow_definition 已发布 + 应用访问权限;注入应用隔离三变量
 *       {@code dsh_applicant_user_id} / {@code dsh_app_id} / {@code dsh_workflow_definition_id}
 *       (spec §7.7.4 + §13.4);调 Flowable REST。</li>
 *   <li>列实例:{@code state=running} 走引擎 DSH runtime 端点按流程定义 key 跨版本收集
 *       (保留 suspended 标志);其余走引擎历史查询(含全部/completed/terminated),
 *       对齐主流 BPM 平台的实例历史视图。</li>
 *   <li>查实例详情/变量/活动/BPMN XML:runtime 不存在时回退历史(已结束实例可见),
 *       供详情页展示历史实例与其上下文变量终值。</li>
 *   <li>列实例任务:运行中走 runtime tasks;已结束回退历史任务。</li>
 *   <li>终止实例:管理员干预,记审计(spec §11.2)。</li>
 *   <li>完成任务:V1 简化的人工干预通道,不做输出校验(spec §8.8 在 DSH task-api 层)。</li>
 * </ul>
 *
 * <p>应用隔离(spec §13.4):所有写操作和查详情都校验当前用户能访问目标 workflow_definition
 * 所属的应用(system_admin 全部;app_admin 仅自己管理应用)。历史实例的 procdefId 若
 * 无法反查 workflow_definition(旧版本部署已被新发布覆盖),仅 system_admin 可见。
 */
@Service
public class ProcessInstanceService {

    private final FlowableRestClient flowableRestClient;
    private final WorkflowDefinitionJdbcRepository workflowRepository;
    private final ApplicationService applicationService;
    private final AuditService auditService;
    private final ProcessStartValidationService startValidation;
    private final UserService userService;

    /** workflow 反查缓存 TTL:发布/下线定义后列表归属最迟 1 分钟对齐。 */
    private static final long WORKFLOW_CACHE_TTL_MILLIS = 60_000;

    /** procdefId → 反查结果缓存。miss(empty)也缓存:miss 代价最高(两次 DB 查询 + 引擎调用)。 */
    private final ConcurrentHashMap<String, WorkflowCacheEntry> workflowByProcdefCache = new ConcurrentHashMap<>();

    /** bpmnProcessKey → 反查结果缓存(历史版本实例走 key 反查路径)。 */
    private final ConcurrentHashMap<String, WorkflowCacheEntry> workflowByKeyCache = new ConcurrentHashMap<>();

    /** procdefId → 定义 key 缓存(③ 引擎 repository API 查询结果,含 empty=定义已清理)。 */
    private final ConcurrentHashMap<String, Optional<String>> procdefKeyCache = new ConcurrentHashMap<>();

    private record WorkflowCacheEntry(Optional<WorkflowDefinitionDto> wf, long expiresAtMillis) {
    }

    public ProcessInstanceService(FlowableRestClient flowableRestClient,
                                  WorkflowDefinitionJdbcRepository workflowRepository,
                                  ApplicationService applicationService,
                                  AuditService auditService,
                                  ProcessStartValidationService startValidation,
                                  UserService userService) {
        this.flowableRestClient = flowableRestClient;
        this.workflowRepository = workflowRepository;
        this.applicationService = applicationService;
        this.auditService = auditService;
        this.startValidation = startValidation;
        this.userService = userService;
    }

    /**
     * 生成启动表单变量清单(已部署 BPMN 的 start-param 声明)。
     *
     * <p>按部署版本而非草稿,与启动校验同一声明源。权限与发起一致
     * (checkCanStartProcess):员工发起前需要读取启动参数声明。
     */
    public List<StartFormVariableDto> startForm(UUID workflowDefinitionId, AuthContext auth) {
        WorkflowDefinitionDto wf = requirePublished(workflowDefinitionId);
        applicationService.checkCanStartProcess(auth, wf.appId());
        return startValidation.startForm(
            startValidation.loadDeclarations(wf.publishedProcdefId()));
    }

    /**
     * 实例流程定义的全部上下文声明(管理员强制完成弹窗的变量清单)。
     *
     * <p>声明取自已部署 BPMN 的 {@code dsh:contextVariables},与启动校验同一解析源。
     * 访问权限与查详情一致(requireAccessibleInstance)。
     */
    public List<ContextVariableDto> listContextDeclarations(String instanceId, AuthContext auth) {
        JsonNode instance = requireAccessibleInstance(instanceId, auth);
        String procdefId = textOrNull(instance, "processDefinitionId");
        if (procdefId == null) {
            throw new NotFoundException("实例缺少 processDefinitionId,无法取上下文声明: " + instanceId);
        }
        return startValidation.loadDeclarations(procdefId).stream()
            .map(ProcessInstanceService::toContextVariableDto)
            .toList();
    }

    /** 声明树 → DTO 递归映射(object 字段清单随行带出,供弹窗展开点路径)。 */
    private static ContextVariableDto toContextVariableDto(BpmnContextParser.ContextVariable v) {
        return new ContextVariableDto(v.name(), v.type(), v.description(),
            v.fields().stream().map(ProcessInstanceService::toContextVariableDto).toList());
    }

    /**
     * 当前用户可发起的 published 流程清单(员工端/管理台发起入口)。
     *
     * <p>system_admin 查全部;其余用户聚合"管理的应用 ∪ active 成员的应用"
     * ({@link ApplicationService#listStartableAppIds})下的 published 流程。
     */
    public List<com.dsh.console.runtime.dto.StartableWorkflowDto> listStartable(AuthContext auth) {
        if (auth.isSystemAdmin()) {
            return workflowRepository.listStartableAll();
        }
        return workflowRepository.listStartableByAppIds(applicationService.listStartableAppIds(auth));
    }

    /**
     * 启动流程实例。
     *
     * <p>启动校验(design 2026-09-01 §4 严格声明制):按已部署 BPMN 的上下文声明
     * 拒绝未声明/未标记 start-param 的传入变量,按类型反序列化,initial 兜底注入;
     * source=system 的 initiator 声明按登录人(auth)自动注入。
     *
     * <p>组织维度审批路由(design 2026-09-19 §5.1 发起身份选择):注入第四变量
     * {@code dsh_applicant_org_unit_id}(发起身份部门,启动时快照)。身份来自
     * 申请人 org_unit_members 多对多归属:唯一部门自动采用,多部门必传
     * request.orgUnitId(须在归属列表中,防伪造);流程含同行政线节点而申请人无
     * 部门时启动拒绝。权限:system_admin/应用管理员/active 应用成员可发起
     * (checkCanStartProcess,员工端发起的前提)。
     */
    @Transactional
    public ProcessInstanceDto start(StartProcessInstanceRequest request, AuthContext auth) {
        WorkflowDefinitionDto wf = requirePublished(request.workflowDefinitionId());
        applicationService.checkCanStartProcess(auth, wf.appId());

        ProcessStartValidationService.StartContext startContext =
            startValidation.loadStartContext(wf.publishedProcdefId());
        UUID applicantOrgUnitId = startValidation.resolveApplicantOrgUnit(
            startContext,
            userService.findOrgUnitIdsByAuthSubject(auth.authSubject()),
            request.orgUnitId());

        Map<String, Object> contextVariables = startValidation.buildVariables(
            startContext.declarations(), request.variables(), auth);

        // 应用隔离三变量(spec §7.7.4 + §13.4)与上下文变量合并。
        // dsh_applicant_user_id 存流程身份(auth_subject = JWT sub),与引擎侧
        // assignee/候选人同一 ID 体系,SoD not-applicant 比较才能命中。
        Map<String, Object> variables = new LinkedHashMap<>();
        variables.put("dsh_applicant_user_id", auth.authSubject());
        variables.put("dsh_app_id", wf.appId().toString());
        variables.put("dsh_workflow_definition_id", wf.id().toString());
        // 第四变量(design 2026-09-19):发起身份部门,引擎侧组织维度候选解析的锚点;
        // 申请人无部门且流程无同行政线节点时不注入(引擎 getVariable 得 null)
        if (applicantOrgUnitId != null) {
            variables.put("dsh_applicant_org_unit_id", applicantOrgUnitId.toString());
        }
        variables.putAll(contextVariables);

        JsonNode instance = flowableRestClient.startProcessInstance(
            wf.publishedProcdefId(), request.businessKey(), request.name(), variables);

        ProcessInstanceDto dto = toDto(instance, wf, new java.util.HashMap<>());
        Map<String, Object> auditDetails = new LinkedHashMap<>();
        auditDetails.put("instanceId", dto.id());
        auditDetails.put("workflowDefinitionId", wf.id());
        auditDetails.put("appId", wf.appId());
        auditDetails.put("businessKey", String.valueOf(request.businessKey()));
        if (applicantOrgUnitId != null) {
            auditDetails.put("applicantOrgUnitId", applicantOrgUnitId.toString());
        }
        auditService.record("PROCESS_INSTANCE_START", "workflow_definition", null,
            auth.platformUserId(), auditDetails);
        return dto;
    }

    /**
     * 列实例(状态可过滤)。
     *
     * <p>{@code state=running} 走 runtime 查询(保留 suspended 标志);{@code completed}
     * 只看正常完成;{@code terminated} 只看已终止(deleteReason 非空);不传看全部
     * (运行中 + 已结束,历史表在实例启动时即写入)。
     * 给 {@code appId} 时只列该应用下的实例;不给时 system_admin 查全部,
     * app_admin 自动汇总自己管理的所有应用下的实例。
     */
    public List<ProcessInstanceDto> list(UUID appIdFilter, String procdefIdFilter, String state,
                                         int start, int size, AuthContext auth) {
        if ("running".equalsIgnoreCase(state)) {
            return listRuntime(appIdFilter, procdefIdFilter, start, size, auth);
        }
        return listHistoric(appIdFilter, procdefIdFilter, state, start, size, auth);
    }

    private List<ProcessInstanceDto> listRuntime(UUID appIdFilter, String procdefIdFilter,
                                                 int start, int size, AuthContext auth) {
        int page = toPage(start, size);
        boolean seeAll = canSeeAllInstances(auth);
        // procdefIdFilter 非空:反查 workflow_definition 校验应用权限,按 bpmnProcessKey
        // 跨版本收集(运行中实例可能挂在重新发布前的旧版本 procdef 上)
        if (procdefIdFilter != null) {
            WorkflowDefinitionDto wf = workflowRepository.findByProcdefId(procdefIdFilter)
                .orElseThrow(() -> new NotFoundException(
                    "procdefId 未对应任何 published workflow_definition: " + procdefIdFilter));
            if (seeAll) {
                applicationService.checkCanAccessApp(auth, wf.appId());
            }
            return filterOwnInstances(listRuntimeByWorkflow(wf, page, size), auth);
        }

        // appIdFilter 非空:按单个应用过滤
        if (appIdFilter != null) {
            if (seeAll) {
                applicationService.checkCanAccessApp(auth, appIdFilter);
            }
            return filterOwnInstances(listInstancesByApp(appIdFilter, page, size), auth);
        }

        // appIdFilter 和 procdefIdFilter 都为空
        if (auth.isSystemAdmin()) {
            // 走引擎 DSH runtime 端点:响应带 processDefinitionKey,旧版本实例可按 key 归属
            JsonNode resp = flowableRestClient.listDshRuntimeProcessInstances(null, page, size);
            return parseHistoricInstanceList(resp, null);
        }

        if (seeAll) {
            // app_admin:名下应用实例 ∪ 自己发起的运行中实例(以成员身份在其他应用发起)
            List<ApplicationDto> apps = applicationService.listManagedApps(auth.platformUserId());
            Map<String, ProcessInstanceDto> merged = new LinkedHashMap<>();
            for (ApplicationDto app : apps) {
                for (ProcessInstanceDto dto : listInstancesByApp(app.id(), page, size)) {
                    merged.put(dto.id(), dto);
                }
            }
            String ownSubject = auth.authSubject();
            JsonNode resp = flowableRestClient.listDshRuntimeProcessInstances(null, page, size);
            for (ProcessInstanceDto dto : parseHistoricInstanceList(resp, null)) {
                if (ownSubject != null && ownSubject.equals(dto.startUserId())) {
                    merged.put(dto.id(), dto);
                }
            }
            return new ArrayList<>(merged.values());
        }

        // 普通用户:全量页拉回后仅保留自己发起的实例
        JsonNode resp = flowableRestClient.listDshRuntimeProcessInstances(null, page, size);
        return filterOwnInstances(parseHistoricInstanceList(resp, null), auth);
    }

    /**
     * 按单个 workflow_definition 列运行中实例:优先按 bpmnProcessKey 跨部署版本收集
     * (运行中实例可能挂在旧版本 procdef 上);bpmn_process_key 为空的迁移旧行
     * 退回按当前发布版本 procdefId 查(旧版本实例不可见)。
     */
    private List<ProcessInstanceDto> listRuntimeByWorkflow(WorkflowDefinitionDto wf, int page, int size) {
        String key = wf.bpmnProcessKey();
        if (key == null || key.isBlank()) {
            JsonNode resp = flowableRestClient.listRuntimeProcessInstances(
                wf.publishedProcdefId(), null, size);
            return parseInstanceList(resp, wf);
        }
        JsonNode resp = flowableRestClient.listDshRuntimeProcessInstances(key, page, size);
        return parseHistoricInstanceList(resp, wf);
    }

    /**
     * 列历史实例(全部/正常完成/已终止),按应用归属过滤。
     *
     * <p>引擎历史查询按发起时间倒序。procdefId 可解析时优先按 bpmnProcessKey 过滤
     * (跨版本收集,重新发布后旧版本实例不漏);按应用聚合时拉全量后本地过滤——逐实例
     * 反查(procdefId 精确 + process key 回退)后仍无法归属的实例 appId 为 null:
     * system_admin 可见(流程名/定义信息由引擎补齐),其余用户仅发起人自己可见。
     */
    private List<ProcessInstanceDto> listHistoric(UUID appIdFilter, String procdefIdFilter,
                                                  String state, int start, int size,
                                                  AuthContext auth) {
        int page = toPage(start, size);
        boolean seeAll = canSeeAllInstances(auth);
        if (procdefIdFilter != null) {
            WorkflowDefinitionDto wf = workflowRepository.findByProcdefId(procdefIdFilter)
                .orElseThrow(() -> new NotFoundException(
                    "procdefId 未对应任何 published workflow_definition: " + procdefIdFilter));
            if (seeAll) {
                applicationService.checkCanAccessApp(auth, wf.appId());
            }
            // 按 bpmnProcessKey 过滤(跨版本收集);key 为空的迁移旧行退回 procdefId 精确过滤
            String key = wf.bpmnProcessKey();
            JsonNode resp = (key == null || key.isBlank())
                ? flowableRestClient.listHistoricProcessInstances(procdefIdFilter, null, state, page, size)
                : flowableRestClient.listHistoricProcessInstances(null, key, state, page, size);
            return filterOwnInstances(parseHistoricInstanceList(resp, wf), auth);
        }

        if (appIdFilter != null && seeAll) {
            applicationService.checkCanAccessApp(auth, appIdFilter);
        }
        JsonNode resp = flowableRestClient.listHistoricProcessInstances(
            null, null, state, page, size);
        List<ProcessInstanceDto> all = parseHistoricInstanceList(resp, null);

        Set<UUID> visibleAppIds = null;
        if (auth.hasRole(PlatformRole.APP_ADMIN)) {
            visibleAppIds = new HashSet<>();
            for (ApplicationDto app : applicationService.listManagedApps(auth.platformUserId())) {
                visibleAppIds.add(app.id());
            }
        }
        String ownSubject = auth.isSystemAdmin() ? null : auth.authSubject();
        List<ProcessInstanceDto> result = new ArrayList<>();
        for (ProcessInstanceDto dto : all) {
            if (visibleAppIds != null) {
                // app_admin:名下应用的实例 ∪ 自己发起的实例(以成员身份在其他应用发起)
                boolean appVisible = dto.appId() != null && visibleAppIds.contains(dto.appId());
                boolean ownVisible = ownSubject != null && ownSubject.equals(dto.startUserId());
                if (!appVisible && !ownVisible) {
                    continue;
                }
            } else if (ownSubject != null && !ownSubject.equals(dto.startUserId())) {
                // 普通用户:仅自己发起的实例
                continue;
            }
            if (appIdFilter != null && !appIdFilter.equals(dto.appId())) {
                continue;
            }
            result.add(dto);
        }
        return result;
    }

    /**
     * 是否跳出"仅自己发起"过滤:system_admin 看全部;app_admin 看名下应用实例
     * (∪ 自己发起的实例,列表方法内合并);普通用户仅看自己发起的实例。
     * 带 appId/procdefId 过滤的路径用它决定是否做应用管理权校验(非名下应用维持拒绝)。
     */
    private boolean canSeeAllInstances(AuthContext auth) {
        return auth.isSystemAdmin() || auth.hasRole(PlatformRole.APP_ADMIN);
    }

    /** 普通用户仅保留自己发起的实例(startUserId=JWT sub);管理员原样返回。 */
    private List<ProcessInstanceDto> filterOwnInstances(List<ProcessInstanceDto> instances,
                                                        AuthContext auth) {
        if (canSeeAllInstances(auth)) {
            return instances;
        }
        String subject = auth.authSubject();
        List<ProcessInstanceDto> result = new ArrayList<>();
        for (ProcessInstanceDto dto : instances) {
            if (subject != null && subject.equals(dto.startUserId())) {
                result.add(dto);
            }
        }
        return result;
    }

    private List<ProcessInstanceDto> listInstancesByApp(UUID appId, int page, int size) {
        List<WorkflowDefinitionDto> wfs = workflowRepository.listPublishedByApp(appId);
        List<ProcessInstanceDto> all = new ArrayList<>();
        for (WorkflowDefinitionDto wf : wfs) {
            all.addAll(listRuntimeByWorkflow(wf, page, size));
        }
        return all;
    }

    /**
     * 查实例详情(runtime 优先,已结束回退历史)。
     */
    public ProcessInstanceDto getById(String instanceId, AuthContext auth) {
        JsonNode instance = requireAccessibleInstance(instanceId, auth);
        WorkflowDefinitionDto wf = resolveWorkflow(instance);
        // 发起人显示名单独解析(toDto 只查预取缓存,空 Map 会退回裸 ID)
        String startUserId = textOrNull(instance, "startUserId");
        Map<String, String> displayNames = startUserId == null
            ? Map.of() : userService.findDisplayNames(Set.of(startUserId));
        return toDto(instance, wf, new java.util.HashMap<>(displayNames));
    }

    /**
     * 列实例任务(运行中走 runtime tasks;已结束回退历史任务,含完成时间/终止原因)。
     */
    public List<TaskDto> listTasks(String instanceId, AuthContext auth) {
        JsonNode instance = requireAccessibleInstance(instanceId, auth);
        if (textOrNull(instance, "endTime") == null) {
            return parseTaskList(flowableRestClient.listTasksByProcessInstance(instanceId));
        }
        return parseHistoricTaskList(flowableRestClient.listHistoricTasks(instanceId));
    }

    /**
     * 列实例上下文变量(历史变量统一视图:运行中返回当前值,已结束返回终值)。
     */
    public List<ProcessVariableDto> listVariables(String instanceId, AuthContext auth) {
        requireAccessibleInstance(instanceId, auth);
        JsonNode resp = flowableRestClient.listHistoricVariables(instanceId);
        List<ProcessVariableDto> result = new ArrayList<>();
        if (resp == null || !resp.isArray()) {
            return result;
        }
        for (JsonNode node : resp) {
            result.add(new ProcessVariableDto(
                textOrNull(node, "variableName"),
                textOrNull(node, "variableTypeName"),
                node.path("value"),
                parseTime(node, "createTime"),
                parseTime(node, "lastUpdatedTime")
            ));
        }
        return result;
    }

    /**
     * 列实例历史活动(执行路径回溯,含 sequenceFlow,按进入时间升序)。
     */
    public List<HistoricActivityDto> listActivities(String instanceId, AuthContext auth) {
        requireAccessibleInstance(instanceId, auth);
        JsonNode resp = flowableRestClient.listHistoricActivities(instanceId);
        List<HistoricActivityDto> result = new ArrayList<>();
        if (resp == null || !resp.isArray()) {
            return result;
        }
        // 处理人显示名:先收集全部 assignee 批量查,避免逐人单查
        Set<String> assignees = new HashSet<>();
        for (JsonNode node : resp) {
            String assignee = textOrNull(node, "assignee");
            if (assignee != null) {
                assignees.add(assignee);
            }
        }
        Map<String, String> nameCache = userService.findDisplayNames(assignees);
        for (JsonNode node : resp) {
            String assignee = textOrNull(node, "assignee");
            result.add(new HistoricActivityDto(
                textOrNull(node, "id"),
                textOrNull(node, "activityId"),
                textOrNull(node, "activityName"),
                textOrNull(node, "activityType"),
                assignee,
                resolveUserDisplayName(assignee, nameCache),
                parseTime(node, "startTime"),
                parseTime(node, "endTime"),
                node.path("durationInMillis").isNumber()
                    ? node.path("durationInMillis").asLong()
                    : null
            ));
        }
        return result;
    }

    /**
     * 取实例部署版 BPMN XML(活动路径图渲染用;旧版本部署引擎仍保留资源)。
     */
    public String getBpmnXml(String instanceId, AuthContext auth) {
        JsonNode instance = requireAccessibleInstance(instanceId, auth);
        String procdefId = textOrNull(instance, "processDefinitionId");
        if (procdefId == null) {
            throw new NotFoundException("实例缺少 processDefinitionId,无法取 BPMN XML: " + instanceId);
        }
        return flowableRestClient.getProcessDefinitionBpmnXml(procdefId);
    }

    /**
     * 回读实例业务日志(引擎实例日志文件的结构化条目)。
     *
     * <p>数据源是引擎磁盘上的 {@code logs/process/<实例id>.log}(backend task /
     * service task 等 delegate 写入);UserTask/网关等无代码执行的节点天然没有条目。
     * 访问权限与查详情一致(requireAccessibleInstance)。
     */
    public List<ProcessLogEntryDto> listProcessLog(String instanceId, AuthContext auth) {
        requireAccessibleInstance(instanceId, auth);
        JsonNode resp = flowableRestClient.getProcessLog(instanceId);
        List<ProcessLogEntryDto> result = new ArrayList<>();
        if (resp == null || !resp.isArray()) {
            return result;
        }
        for (JsonNode node : resp) {
            result.add(new ProcessLogEntryDto(
                textOrNull(node, "timestamp"),
                textOrNull(node, "activityId"),
                textOrNull(node, "activityName"),
                textOrNull(node, "message"),
                textOrNull(node, "raw")
            ));
        }
        return result;
    }

    /**
     * 终止实例(spec §11.2:管理员强制结束)。
     */
    @Transactional
    public void terminate(String instanceId, String reason, AuthContext auth) {
        JsonNode instance = flowableRestClient.getRuntimeProcessInstance(instanceId);
        if (instance == null) {
            throw new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
                "流程实例不存在或已结束: " + instanceId);
        }
        WorkflowDefinitionDto wf = resolveWorkflowDefinition(instance);
        applicationService.checkCanAccessApp(auth, wf.appId());

        flowableRestClient.deleteProcessInstance(instanceId, reason);
        auditService.record("PROCESS_INSTANCE_TERMINATE", "workflow_definition", null,
            auth.platformUserId(), Map.of(
                "instanceId", instanceId,
                "workflowDefinitionId", wf.id(),
                "appId", wf.appId(),
                "deleteReason", reason == null ? "" : reason));
    }

    /**
     * 完成任务(V1 简化:不做输出校验,直接转发 Flowable)。
     */
    @Transactional
    public void completeTask(String taskId, Map<String, Object> variables, AuthContext auth) {
        flowableRestClient.completeTask(taskId, variables);
        auditService.record("TASK_COMPLETE", "workflow_definition", null,
            auth.platformUserId(), Map.of(
                "taskId", taskId,
                "operator", auth.platformUserId().toString()));
    }

    // ===== 内部辅助 =====

    /** 查流程定义并断言已发布(published_procdef_id 就绪);startForm/start 共用。 */
    private WorkflowDefinitionDto requirePublished(UUID workflowDefinitionId) {
        WorkflowDefinitionDto wf = workflowRepository.findById(workflowDefinitionId)
        .orElseThrow(() -> new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
            "流程定义不存在: " + workflowDefinitionId));
        if (!"published".equalsIgnoreCase(wf.status())) {
            throw new IllegalArgumentException(
                "流程定义状态非 published,不允许启动实例: " + wf.status());
        }
        if (wf.publishedProcdefId() == null || wf.publishedProcdefId().isBlank()) {
            throw new IllegalStateException("流程定义已发布但 published_procdef_id 为空(数据不一致)");
        }
        return wf;
    }

    /**
     * 从 Flowable runtime instance JSON 反查 workflow_definition(必须归属成功)。
     *
     * <p>先按 procdefId 精确反查;重新发布后的旧版本运行实例(继续按启动时定义执行)
     * miss 时按 BPMN process key 回退。
     *
     * @throws NotFoundException procdefId 与 process key 都无法归属(数据不一致)
     */
    private WorkflowDefinitionDto resolveWorkflowDefinition(JsonNode instance) {
        WorkflowDefinitionDto wf = resolveWorkflow(instance);
        if (wf == null) {
            throw new com.dsh.console.common.GlobalExceptionHandler.NotFoundException(
                "procdefId 未对应任何 workflow_definition(数据不一致): "
                    + instance.path("processDefinitionId").asText());
        }
        return wf;
    }

    /**
     * 查实例(runtime 优先,已结束回退历史)并校验访问权限。
     *
     * <p>可见性:system_admin 全部;名下应用(app_admin_user_ids 含自己)的实例对
     * app_admin 开放;任何人可访问自己发起的实例。procdefId 无法反查
     * workflow_definition(旧版本部署已被新发布覆盖)时应用归属无法判定,
     * 除 system_admin 外仅发起人自己可见。
     *
     * @throws NotFoundException 实例不存在(运行中与历史都查不到),或当前用户无权访问
     */
    private JsonNode requireAccessibleInstance(String instanceId, AuthContext auth) {
        JsonNode instance;
        try {
            instance = flowableRestClient.getRuntimeProcessInstance(instanceId);
        } catch (NotFoundException e) {
            instance = flowableRestClient.getHistoricProcessInstance(instanceId);
        }
        if (instance == null) {
            throw new NotFoundException("流程实例不存在(runtime/history): " + instanceId);
        }
        WorkflowDefinitionDto wf = resolveWorkflow(instance);
        if (auth.isSystemAdmin()) {
            // 全部可见
        } else if (java.util.Objects.equals(auth.authSubject(), textOrNull(instance, "startUserId"))) {
            // 自己发起的实例:任意应用可访问(app_admin 以成员身份在其他应用发起的也在内)
        } else if (wf != null && auth.hasRole(PlatformRole.APP_ADMIN)) {
            // 名下应用的实例
            applicationService.checkCanAccessApp(auth, wf.appId());
        } else {
            // 不可访问一律 NotFound,不泄露存在性
            throw new NotFoundException("流程实例不存在或不可访问: " + instanceId);
        }
        return instance;
    }

    /**
     * 解析引擎 runtime/官方列表响应,全部实例视为给定流程定义(procdef 过滤路径);
     * 发起人显示名走批量。
     */
    private List<ProcessInstanceDto> parseInstanceList(JsonNode resp, WorkflowDefinitionDto wf) {
        List<ProcessInstanceDto> result = new ArrayList<>();
        if (resp == null) {
            return result;
        }
        JsonNode data = resp.path("data");
        if (data == null || !data.isArray()) {
            return result;
        }
        Set<String> startUserIds = new HashSet<>();
        for (JsonNode node : data) {
            String startUserId = textOrNull(node, "startUserId");
            if (startUserId != null) {
                startUserIds.add(startUserId);
            }
        }
        Map<String, String> displayNames = userService.findDisplayNames(startUserIds);
        for (JsonNode node : data) {
            result.add(toDto(node, wf, displayNames));
        }
        return result;
    }

    /**
     * 解析引擎历史实例响应(plain JSON 数组,非 Flowable REST 的 {@code data} 包装)。
     *
     * <p>两遍式批量解析:先收集全页 procdefId/key/发起人,三次批量查询
     * (procdefId IN + key IN + user IN)后逐实例组装——远端 Supabase RTT 高,
     * 逐实例单查(列表 N+1)会在连接池上限下占满连接拖垮整个后端。
     *
     * @param wfFilter 非 null 时所有实例视为该流程定义(procdef 过滤路径),
     *                 跳过 workflow 批量反查;null 时批量反查(旧版本部署 miss 归 null)
     */
    private List<ProcessInstanceDto> parseHistoricInstanceList(JsonNode resp,
                                                               WorkflowDefinitionDto wfFilter) {
        List<ProcessInstanceDto> result = new ArrayList<>();
        if (resp == null || !resp.isArray()) {
            return result;
        }
        Set<String> procdefIds = new HashSet<>();
        Set<String> keys = new HashSet<>();
        Set<String> startUserIds = new HashSet<>();
        for (JsonNode node : resp) {
            collectInstanceKeys(node, procdefIds, keys, startUserIds);
        }
        Map<String, WorkflowDefinitionDto> byProcdef = wfFilter != null
            ? Map.of() : workflowRepository.findByProcdefIds(procdefIds);
        if (wfFilter == null) {
            // 历史官方 REST 响应不带 processDefinitionKey:procdefId miss 的节点按
            // procdefId 补查 key(带缓存)并入 key 集合,key 反查才能命中
            for (JsonNode node : resp) {
                if (byProcdef.containsKey(textOrNull(node, "processDefinitionId"))) {
                    continue;
                }
                String key = resolveInstanceProcdefKey(node);
                if (key != null) {
                    keys.add(key);
                }
            }
        }
        Map<String, WorkflowDefinitionDto> byKey = wfFilter != null
            ? Map.of() : workflowRepository.findByBpmnProcessKeys(keys);
        Map<String, String> displayNames = userService.findDisplayNames(startUserIds);
        for (JsonNode node : resp) {
            WorkflowDefinitionDto wf = wfFilter != null ? wfFilter
                : byProcdef.get(textOrNull(node, "processDefinitionId"));
            if (wf == null) {
                // ① procdefId miss(重新发布后的旧版本实例)→ key 回退(key 跨版本稳定)。
                // 历史官方 REST 响应不带 processDefinitionKey:缺失时按 procdefId
                // 查 repository API 补(带缓存),避免 byKey.get(null)
                wf = byKey.get(resolveInstanceProcdefKey(node));
            }
            result.add(toDto(node, wf, displayNames));
        }
        return result;
    }

    /** 实例 JSON 自带 processDefinitionKey 时直接用;缺失按 procdefId 补查(带缓存)。 */
    private String resolveInstanceProcdefKey(JsonNode node) {
        String key = textOrNull(node, "processDefinitionKey");
        if (key != null) {
            return key;
        }
        String procdefId = textOrNull(node, "processDefinitionId");
        if (procdefId == null) {
            return null;
        }
        return procdefKeyCache
            .computeIfAbsent(procdefId, this::lookupProcdefKeyFromEngine)
            .orElse(null);
    }

    private static void collectInstanceKeys(JsonNode node, Set<String> procdefIds,
                                            Set<String> keys, Set<String> userIds) {
        String procdefId = textOrNull(node, "processDefinitionId");
        if (procdefId != null) {
            procdefIds.add(procdefId);
        }
        String key = textOrNull(node, "processDefinitionKey");
        if (key != null) {
            keys.add(key);
        }
        String startUserId = textOrNull(node, "startUserId");
        if (startUserId != null) {
            userIds.add(startUserId);
        }
    }

    /**
     * 解析历史实例的流程定义归属,三级回退:① procdefId 精确反查(当前发布版本);
     * ② 实例 JSON 的 processDefinitionKey 反查(引擎历史端点从 ACT_RE_PROCDEF 补查);
     * ③ 实例 JSON 无 key 时(runtime 官方响应不带该字段)按 procdefId 查官方
     * repository API 拿定义 key 再反查——历史版本定义不会因重新发布消失。
     *
     * <p>三级结果(procdefId/key → workflow,含 miss)统一进 60 秒 TTL 缓存:
     * 实例列表每实例都触发反查,无缓存时一次 200 条列表会打上百次远端 DB 小查询,
     * 在 5 连接池上限下耗尽连接拖垮整个后端。
     */
    private WorkflowDefinitionDto resolveWorkflow(JsonNode instance) {
        String procdefId = instance.path("processDefinitionId").asText();
        Optional<WorkflowDefinitionDto> cachedByProcdef = cachedWorkflow(workflowByProcdefCache, procdefId);
        if (cachedByProcdef != null) {
            return cachedByProcdef.orElse(null);
        }
        WorkflowDefinitionDto wf = workflowRepository.findByProcdefId(procdefId).orElse(null);
        if (wf != null) {
            cacheWorkflow(procdefId, null, Optional.of(wf));
            return wf;
        }
        // ② key 反查:实例 JSON 自带 key 直接用;没有则走 ③ 引擎查询(带缓存)
        String key = instance.path("processDefinitionKey").asText(null);
        if (key == null || key.isBlank()) {
            key = procdefKeyCache
                .computeIfAbsent(procdefId, this::lookupProcdefKeyFromEngine)
                .orElse(null);
        }
        Optional<WorkflowDefinitionDto> resolved = Optional.empty();
        if (key != null && !key.isBlank()) {
            resolved = cachedWorkflow(workflowByKeyCache, key);
            if (resolved == null) {
                resolved = workflowRepository.findByBpmnProcessKey(key);
            }
        }
        cacheWorkflow(procdefId, key, resolved);
        return resolved.orElse(null);
    }

    /** 官方 repository API 按 procdefId 查定义 key;定义被物理清理时缓存 empty(归属失败不反复调引擎)。 */
    private Optional<String> lookupProcdefKeyFromEngine(String procdefId) {
        try {
            JsonNode definition = flowableRestClient.getProcessDefinition(procdefId);
            return Optional.ofNullable(definition == null ? null : definition.path("key").asText(null));
        } catch (NotFoundException e) {
            // 定义已被引擎物理清理(ACT_RE_PROCDEF 不应删除,理论不发生):
            // 归属失败,实例退化为 system_admin 可见,不炸整个列表
            return Optional.empty();
        }
    }

    /** 命中未过期返回缓存值;过期或不存在返回 null(调用方回源并写回)。 */
    private Optional<WorkflowDefinitionDto> cachedWorkflow(
        ConcurrentHashMap<String, WorkflowCacheEntry> cache, String cacheKey) {
        WorkflowCacheEntry entry = cache.get(cacheKey);
        if (entry == null) {
            return null;
        }
        if (entry.expiresAtMillis() < System.currentTimeMillis()) {
            cache.remove(cacheKey, entry);
            return null;
        }
        return entry.wf();
    }

    private void cacheWorkflow(String procdefId, String key, Optional<WorkflowDefinitionDto> wf) {
        long expiresAt = System.currentTimeMillis() + WORKFLOW_CACHE_TTL_MILLIS;
        workflowByProcdefCache.put(procdefId, new WorkflowCacheEntry(wf, expiresAt));
        if (key != null && !key.isBlank()) {
            workflowByKeyCache.put(key, new WorkflowCacheEntry(wf, expiresAt));
        }
    }

    private List<TaskDto> parseTaskList(JsonNode resp) {
        List<TaskDto> result = new ArrayList<>();
        if (resp == null) {
            return result;
        }
        JsonNode data = resp.path("data");
        if (data == null || !data.isArray()) {
            return result;
        }
        Map<String, String> displayNames = batchDisplayNames(data);
        for (JsonNode node : data) {
            String assignee = textOrNull(node, "assignee");
            String assigneeName = resolveUserDisplayName(assignee, displayNames);
            result.add(new TaskDto(
                textOrNull(node, "id"),
                textOrNull(node, "name"),
                assignee,
                assigneeName,
                textOrNull(node, "owner"),
                parseTime(node, "createTime"),
                parseTime(node, "dueDate"),
                textOrNull(node, "processInstanceId"),
                textOrNull(node, "processDefinitionId"),
                textOrNull(node, "taskDefinitionKey"),
                textOrNull(node, "description"),
                null,
                null
            ));
        }
        return result;
    }

    /** 解析引擎历史任务响应(plain JSON 数组),统一到 {@link TaskDto}(补 endTime/deleteReason)。 */
    private List<TaskDto> parseHistoricTaskList(JsonNode resp) {
        List<TaskDto> result = new ArrayList<>();
        if (resp == null || !resp.isArray()) {
            return result;
        }
        Map<String, String> displayNames = batchDisplayNames(resp);
        for (JsonNode node : resp) {
            String assignee = textOrNull(node, "assignee");
            result.add(new TaskDto(
                textOrNull(node, "id"),
                textOrNull(node, "name"),
                assignee,
                resolveUserDisplayName(assignee, displayNames),
                null,
                parseTime(node, "startTime"),
                null,
                textOrNull(node, "processInstanceId"),
                textOrNull(node, "processDefinitionId"),
                textOrNull(node, "taskDefinitionKey"),
                null,
                parseTime(node, "endTime"),
                textOrNull(node, "deleteReason")
            ));
        }
        return result;
    }

    /** 收集任务数组全部 assignee 一次批量查显示名(逐人单查是 N+1,见 {@link #resolveUserDisplayName})。 */
    private Map<String, String> batchDisplayNames(JsonNode taskArray) {
        Set<String> assignees = new HashSet<>();
        for (JsonNode node : taskArray) {
            String assignee = textOrNull(node, "assignee");
            if (assignee != null) {
                assignees.add(assignee);
            }
        }
        return userService.findDisplayNames(assignees);
    }

    /**
     * 从批量预查的显示名 Map 取值(任务办理人、实例发起人共用;查不到返回 null,保留原 ID 显示)。
     *
     * <p>调用方(各 parse*List)先收集全页 userId 一次批量查 {@code userService.findDisplayNames},
     * 不逐人单查(远端 Supabase RTT × N 会占满连接池)。
     */
    private String resolveUserDisplayName(String userId, Map<String, String> displayNames) {
        if (userId == null || userId.isBlank()) {
            return null;
        }
        return displayNames.get(userId);
    }

    private ProcessInstanceDto toDto(JsonNode node, WorkflowDefinitionDto wf, Map<String, String> nameCache) {
        if (node == null) {
            return null;
        }
        String startUserId = textOrNull(node, "startUserId");
        OffsetDateTime endTime = parseTime(node, "endTime");
        // runtime 响应带 ended 字段;引擎历史响应无 ended,按 endTime 非空判定已结束
        boolean ended = node.path("ended").asBoolean(false) || endTime != null;
        return new ProcessInstanceDto(
            textOrNull(node, "id"),
            textOrNull(node, "businessKey"),
            textOrNull(node, "processDefinitionId"),
            textOrNull(node, "processDefinitionKey"),
            textOrNull(node, "processDefinitionName"),
            textOrNull(node, "name"),
            startUserId,
            resolveUserDisplayName(startUserId, nameCache),
            parseTime(node, "startTime"),
            node.path("suspended").asBoolean(false),
            ended,
            textOrNull(node, "deleteReason"),
            endTime,
            wf == null ? null : wf.id(),
            wf == null ? null : wf.appId(),
            wf == null ? null : wf.name()
        );
    }

    /** start/size 分页参数转引擎历史端点的 page 页码(0-based)。 */
    private static int toPage(int start, int size) {
        return size <= 0 ? 0 : Math.max(0, start) / size;
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.path(field);
        if (v == null || v.isMissingNode() || v.isNull()) {
            return null;
        }
        String s = v.asText();
        return s == null || s.isEmpty() ? null : s;
    }

    private static OffsetDateTime parseTime(JsonNode node, String field) {
        String s = textOrNull(node, field);
        if (s == null) {
            return null;
        }
        try {
            return OffsetDateTime.parse(s);
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
