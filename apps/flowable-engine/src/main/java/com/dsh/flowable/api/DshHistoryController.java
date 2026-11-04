package com.dsh.flowable.api;

import com.dsh.flowable.delegate.ProcessLog;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshTaskListener;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.flowable.engine.HistoryService;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.history.HistoricActivityInstance;
import org.flowable.engine.history.HistoricProcessInstance;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.task.api.history.HistoricTaskInstance;
import org.flowable.variable.api.history.HistoricVariableInstance;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * DSH 历史/审计薄封装 REST 端点(参见 SPEC §10.1 审计接口要求)。
 *
 * <p>Flowable 自带 REST 在 {@code /process-api/history/*} 暴露全部历史查询能力,但返回字段
 * 是 Flowable 原生模型,不含 {@code dsh_node_meta} 等业务字段,且过滤参数较多不便直接给前端用。
 * 本端点按 DSH 业务常用维度(按实例/按处理人/按状态)简化查询,并拼装 dsh 元数据 POJO,
 * 供 Web Console 审计页面和 DSH enterprise profile 退回/跳转参考使用。
 *
 * <p>覆盖范围(V1):
 * <ul>
 *   <li>{@code GET /dsh/history/tasks}:查历史任务(可选按实例/处理人/完成状态过滤)。</li>
 *   <li>{@code GET /dsh/history/process-instances}:查历史实例(可选按实例 id/定义 id/发起人/状态/key 过滤)。</li>
 *   <li>{@code GET /dsh/history/activities}:查历史活动(按实例 id 必填,回溯流程走过的全部节点)。</li>
 *   <li>{@code GET /dsh/history/variables}:查历史变量(按实例 id 必填,实例上下文变量当前/最终值)。</li>
 *   <li>{@code GET /dsh/history/bpmn-xml}:查流程定义的部署版 BPMN XML(按定义 id 必填,
 *       员工工作台迷你流程图与实例路径图渲染共用)。</li>
 *   <li>{@code GET /dsh/history/process-log}:回读流程实例业务日志文件(按实例 id 必填,
 *       backend task / service task 等自动节点的运行轨迹,与 ACT_* 历史互补)。</li>
 * </ul>
 *
 * <p><b>历史级别</b>:由 {@link com.dsh.flowable.config.FlowableConfig} 配置 {@code HistoryLevel.FULL},
 * 所有历史表({@code ACT_HI_*})都写入数据,本端点查询前提成立。
 *
 * <p><b>鉴权</b>:JWT 认证之外强制资源归属——任务/实例列表强制「仅本人相关」
 * (客户端传入的 assignee/startedBy 在非实例级查询中被忽略,防越权枚举他人数据);
 * 实例级端点(activities/variables/process-log 及按实例 id 的任务/实例查询)要求
 * 请求者是实例参与人(发起人或历史任务办理人),非参与人 403(见
 * {@link #requireParticipant})。引擎无 platform_roles 可见性,不设管理员旁路;
 * bpmn-xml 是定义级资源(无实例归属语义),不在此列。
 *
 * <p><b>分页</b>:V1 用 page/size 简单分页(默认 size=50,最大 200),返回 plain list;
 * V2 可改为 Spring HATEOAS 或 Page 对象。
 */
@RestController
@RequestMapping("/dsh/history")
public class DshHistoryController {

    /** 单页最大返回条数,防止前端误传大 size 拖垮引擎。 */
    private static final int MAX_PAGE_SIZE = 200;
    private static final int DEFAULT_PAGE_SIZE = 50;

    /**
     * 取 JWT sub(平台 user.id);缺失说明认证链路异常(端点位于 authenticated 之外
     * 才可能发生),直接 401 fail loud。
     */
    private static String requireUserId(Jwt jwt) {
        if (jwt == null || jwt.getSubject() == null || jwt.getSubject().isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "缺少有效的用户身份");
        }
        return jwt.getSubject();
    }

    /**
     * 实例归属校验:请求者必须是「实例参与人」——发起人(startUserId)或该实例任一
     * 历史任务的办理人;实例不存在 404,非参与人 403。引擎无 platform_roles 可见性,
     * 不设管理员旁路(web-console 实例审计走 {@code /api/process-instances/*},
     * 不经过本控制器)。
     */
    private void requireParticipant(String processInstanceId, String userId) {
        HistoricProcessInstance instance = historyService.createHistoricProcessInstanceQuery()
            .processInstanceId(processInstanceId)
            .singleResult();
        if (instance == null) {
            throw new ResponseStatusException(
                HttpStatus.NOT_FOUND, "流程实例不存在: " + processInstanceId);
        }
        if (userId.equals(instance.getStartUserId())) {
            return;
        }
        long assigneeCount = historyService.createHistoricTaskInstanceQuery()
            .processInstanceId(processInstanceId)
            .taskAssignee(userId)
            .count();
        if (assigneeCount == 0) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                "无权访问该流程实例的历史数据:仅实例参与人(发起人/办理人)可查");
        }
    }

    private final HistoryService historyService;
    private final RepositoryService repositoryService;
    private final ObjectMapper objectMapper;

    public DshHistoryController(HistoryService historyService,
                                  RepositoryService repositoryService,
                                  ObjectMapper objectMapper) {
        this.historyService = historyService;
        this.repositoryService = repositoryService;
        this.objectMapper = objectMapper;
    }

    /**
     * 查历史任务,可按实例/处理人/完成状态过滤。
     *
     * <p>用 {@code includeTaskLocalVariables} 一次查全部 local 变量,避免逐条回查拿 dsh_node_meta。
     *
     * @param processInstanceId 可选;按实例过滤(须为实例参与人,见 {@link #requireParticipant})
     * @param assignee          可选;按处理人(Supabase user.id)过滤;仅实例级查询内可用,
     *                          非实例级查询强制按当前 JWT 用户过滤(防越权枚举他人任务)
     * @param finished          可选;{@code true} 只看已完成,{@code false} 只看进行中,不传不过滤
     * @param page              页码(0-based),默认 0
     * @param size              单页条数,默认 50,上限 200
     */
    @GetMapping("/tasks")
    public List<HistoricTaskDto> getHistoricTasks(
        @RequestParam(name = "processInstanceId", required = false) String processInstanceId,
        @RequestParam(name = "assignee", required = false) String assignee,
        @RequestParam(name = "finished", required = false) Boolean finished,
        @RequestParam(name = "page", defaultValue = "0") int page,
        @RequestParam(name = "size", defaultValue = "50") int size,
        @AuthenticationPrincipal Jwt jwt
    ) {
        String userId = requireUserId(jwt);
        boolean instanceScoped = processInstanceId != null && !processInstanceId.isBlank();
        if (instanceScoped) {
            requireParticipant(processInstanceId, userId);
        }

        int safeSize = clampSize(size);
        int firstResult = Math.max(0, page) * safeSize;

        var query = historyService.createHistoricTaskInstanceQuery()
            .includeTaskLocalVariables()
            .orderByHistoricTaskInstanceStartTime().desc();
        if (instanceScoped) {
            // 参与人可见实例内全部任务(含他人办理的节点记录),assignee 仅作本人收窄
            query.processInstanceId(processInstanceId);
            if (assignee != null && !assignee.isBlank()) {
                query.taskAssignee(assignee);
            }
        } else {
            // 仅本人相关:忽略客户端传入的 assignee,强制按当前用户过滤
            query.taskAssignee(userId);
        }
        if (Boolean.TRUE.equals(finished)) {
            query.finished();
        } else if (Boolean.FALSE.equals(finished)) {
            query.unfinished();
        }

        List<HistoricTaskInstance> tasks = query.listPage(firstResult, safeSize);
        Set<String> procdefIds = new HashSet<>();
        for (HistoricTaskInstance task : tasks) {
            if (task.getProcessDefinitionId() != null) {
                procdefIds.add(task.getProcessDefinitionId());
            }
        }
        Map<String, ProcessDefinition> defById = loadProcdefByIds(procdefIds);
        return tasks.stream().map(t -> toDto(t, defById)).toList();
    }

    /**
     * 查历史流程实例,可按实例 id/定义 id/发起人/状态/key 过滤。
     *
     * <p>不传实例 id 时强制「我发起的」(按发起时间倒序,含运行中实例);参与但非本人
     * 发起的实例经带 processInstanceId 的查询获取(须为参与人)。管理员全量审计不在
     * 本控制器(web-console 实例审计走 {@code /api/process-instances/*})。
     *
     * @param processInstanceId     可选;按实例 id 精确过滤(查单个实例,含已结束的详情回退;
     *                              须为实例参与人,见 {@link #requireParticipant})
     * @param processDefinitionId   可选;按流程定义 id 过滤(部署版本级,Web Console 按应用聚合用)
     * @param startedBy             可选;按发起人 user.id 过滤;仅实例级查询内可用,
     *                              非实例级查询强制按当前 JWT 用户过滤(防越权枚举他人实例)
     * @param state                 可选;{@code running} 只看运行中,{@code completed} 只看正常完成,
     *                              {@code terminated} 只看已终止(deleteReason 非空),不传看全部
     * @param processDefinitionKey  可选;按流程定义 key 过滤(同流程不同版本一并查)
     * @param page                  页码(0-based),默认 0
     * @param size                  单页条数,默认 50,上限 200
     */
    @GetMapping("/process-instances")
    public List<HistoricProcessInstanceDto> getHistoricProcessInstances(
        @RequestParam(name = "processInstanceId", required = false) String processInstanceId,
        @RequestParam(name = "processDefinitionId", required = false) String processDefinitionId,
        @RequestParam(name = "startedBy", required = false) String startedBy,
        @RequestParam(name = "state", required = false) String state,
        @RequestParam(name = "processDefinitionKey", required = false) String processDefinitionKey,
        @RequestParam(name = "page", defaultValue = "0") int page,
        @RequestParam(name = "size", defaultValue = "50") int size,
        @AuthenticationPrincipal Jwt jwt
    ) {
        String userId = requireUserId(jwt);
        boolean instanceScoped = processInstanceId != null && !processInstanceId.isBlank();
        if (instanceScoped) {
            requireParticipant(processInstanceId, userId);
        }
        int safeSize = clampSize(size);
        int firstResult = Math.max(0, page) * safeSize;

        var query = historyService.createHistoricProcessInstanceQuery()
            .orderByProcessInstanceStartTime().desc();
        if (instanceScoped) {
            query.processInstanceId(processInstanceId);
        } else {
            // 仅本人相关:忽略客户端传入的 startedBy,强制按当前用户过滤
            query.startedBy(userId);
        }
        if (instanceScoped && startedBy != null && !startedBy.isBlank()) {
            query.startedBy(startedBy);
        }
        if (processDefinitionId != null && !processDefinitionId.isBlank()) {
            query.processDefinitionId(processDefinitionId);
        }
        // completed/terminated 都按 finished() 取数后本地过滤 deleteReason
        // (HistoricProcessInstanceQuery 没有 deleteReason isNull 过滤 API),过滤后再分页
        boolean completedOnly = "completed".equalsIgnoreCase(state);
        boolean terminatedOnly = "terminated".equalsIgnoreCase(state);
        if ("running".equalsIgnoreCase(state)) {
            query.unfinished();
        } else if (completedOnly || terminatedOnly) {
            query.finished();
        }
        if (processDefinitionKey != null && !processDefinitionKey.isBlank()) {
            query.processDefinitionKey(processDefinitionKey);
        }

        List<HistoricProcessInstance> instances;
        if (completedOnly || terminatedOnly) {
            instances = query.list().stream()
                .filter(i -> terminatedOnly == hasDeleteReason(i))
                .skip(firstResult)
                .limit(safeSize)
                .toList();
        } else {
            instances = query.listPage(firstResult, safeSize);
        }
        return instances.stream()
            .map(i -> toDto(i, loadProcdefById(instances)))
            .toList();
    }

    /**
     * 收集历史实例列表的 distinct procdefId,一次批量查 ProcessDefinition。
     *
     * <p>名称/key/版本 Flowable 7 在 HistoricProcessInstance 上不一定全有,统一从
     * RepositoryService 补齐;历史版本定义保留在 ACT_RE_PROCDEF 不删,旧实例也能命中。
     * 逐条 toDto 补查(同 procdefId 重复查)在远端 DB 上是 N+1,本方法一次往返查完。
     *
     * @return procdefId → ProcessDefinition;无 procdefId 的实例列表返回空 Map
     */
    private Map<String, ProcessDefinition> loadProcdefById(List<HistoricProcessInstance> instances) {
        Set<String> procdefIds = new HashSet<>();
        for (HistoricProcessInstance instance : instances) {
            if (instance.getProcessDefinitionId() != null) {
                procdefIds.add(instance.getProcessDefinitionId());
            }
        }
        return loadProcdefByIds(procdefIds);
    }

    /**
     * 按 distinct procdefId 集合一次批量查 ProcessDefinition(历史任务/实例共用)。
     *
     * @param procdefIds 去重后的定义 id;空集合直接返回空 Map,不发查询
     * @return procdefId → ProcessDefinition
     */
    private Map<String, ProcessDefinition> loadProcdefByIds(Set<String> procdefIds) {
        if (procdefIds.isEmpty()) {
            return Map.of();
        }
        Map<String, ProcessDefinition> defById = new HashMap<>();
        for (ProcessDefinition def : repositoryService.createProcessDefinitionQuery()
                .processDefinitionIds(procdefIds).list()) {
            defById.put(def.getId(), def);
        }
        return defById;
    }

    /** 正常完成实例无 deleteReason;终止实例 deleteReason 非空——completed/terminated 状态过滤依据。 */
    private static boolean hasDeleteReason(HistoricProcessInstance instance) {
        String deleteReason = instance.getDeleteReason();
        return deleteReason != null && !deleteReason.isBlank();
    }

    /**
     * 查历史活动(全部节点类型),按实例 id 必填。
     *
     * <p>用于审计"流程走过了哪些节点、何时走过、停留多久",覆盖 UserTask / ServiceTask /
     * Gateway / Event 等所有 BPMN 节点;与历史任务(只覆盖 UserTask)互补。
     *
     * <p>不分页:单实例的 ACT_HI_ACTINST 条目数有限(流程节点数 × 实例运行路径数,通常 < 100),
     * 一次性返回即可。
     *
     * @param processInstanceId 必填;按实例 id 过滤
     */
    @GetMapping("/activities")
    public List<HistoricActivityDto> getHistoricActivities(
        @RequestParam(name = "processInstanceId", required = false) String processInstanceId,
        @AuthenticationPrincipal Jwt jwt
    ) {
        if (processInstanceId == null || processInstanceId.isBlank()) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "processInstanceId parameter is required for /dsh/history/activities");
        }
        requireParticipant(processInstanceId, requireUserId(jwt));
        List<HistoricActivityInstance> activities = historyService.createHistoricActivityInstanceQuery()
            .processInstanceId(processInstanceId)
            .orderByHistoricActivityInstanceStartTime().asc()
            .list();
        return activities.stream().map(this::toDto).toList();
    }

    /**
     * 查历史变量(实例上下文变量),按实例 id 必填。
     *
     * <p>用于审计"实例的流程上下文变量最终是什么":运行中实例返回当前值(历史变量行
     * 随引擎实时更新),已结束实例返回终值。逐次变更轨迹不在 Flowable OSS 历史模型内。
     *
     * <p>不分页:单实例的变量数为流程声明数 + 应用隔离三变量,一次性返回即可。
     *
     * @param processInstanceId 必填;按实例 id 过滤
     */
    @GetMapping("/variables")
    public List<HistoricVariableDto> getHistoricVariables(
        @RequestParam(name = "processInstanceId", required = false) String processInstanceId,
        @AuthenticationPrincipal Jwt jwt
    ) {
        if (processInstanceId == null || processInstanceId.isBlank()) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "processInstanceId parameter is required for /dsh/history/variables");
        }
        requireParticipant(processInstanceId, requireUserId(jwt));
        List<HistoricVariableInstance> variables = historyService.createHistoricVariableInstanceQuery()
            .processInstanceId(processInstanceId)
            .list();
        return variables.stream()
            .sorted(java.util.Comparator.comparing(
                v -> v.getVariableName() == null ? "" : v.getVariableName()))
            .map(this::toDto)
            .toList();
    }

    /**
     * 查流程定义的部署版 BPMN XML(按定义 id 必填)。
     *
     * <p>员工工作台第三栏迷你流程图与 Web Console 实例路径图都需要部署版 XML
     * (设计器当前编辑内容 ≠ 已部署版本,历史实例必须按部署版渲染)。返回
     * {@code text/xml} 原文,前端交给 bpmn-js 只读视图解析。
     *
     * @param processDefinitionId 必填;流程定义 id(procdefId)
     */
    @GetMapping(value = "/bpmn-xml", produces = "text/xml;charset=UTF-8")
    public String getBpmnXml(
        @RequestParam(name = "processDefinitionId", required = false) String processDefinitionId
    ) {
        if (processDefinitionId == null || processDefinitionId.isBlank()) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "processDefinitionId parameter is required for /dsh/history/bpmn-xml");
        }
        ProcessDefinition def = repositoryService.createProcessDefinitionQuery()
            .processDefinitionId(processDefinitionId)
            .singleResult();
        if (def == null) {
            throw new ResponseStatusException(
                HttpStatus.NOT_FOUND,
                "Process definition not found: " + processDefinitionId);
        }
        try (java.io.InputStream model = repositoryService.getProcessModel(processDefinitionId)) {
            if (model == null) {
                throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND,
                    "Process model resource not found for definition: " + processDefinitionId);
            }
            return new String(model.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            throw new ResponseStatusException(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "Failed to read process model for definition: " + processDefinitionId, e);
        }
    }

    /**
     * 回读流程实例业务日志(按实例 id 必填)。
     *
     * <p>数据源是 {@link com.dsh.flowable.delegate.ProcessLog} 落盘的实例日志文件
     * {@code logs/process/<实例id>.log},与引擎后台日志完全分离;backend task /
     * service task 等 delegate 的运行轨迹都在这里,UserTask/网关等无代码执行的节点
     * 天然没有条目。文件不存在(老实例/尚无自动节点执行)返回空列表,不报 404。
     *
     * <p>解析规则:按 {@code 时间 [节点名(节点id)] 消息} 逐行解析为结构化条目;
     * 消息本身含换行时续行并入同一条目;不符合行格式的行降级为 raw 原文条目。
     *
     * <p>安全:实例 id 必须是 UUID 形状(Flowable 实例 id 即 UUID)且解析后路径
     * 仍位于日志目录内,防止路径穿越读取任意文件。
     *
     * @param processInstanceId 必填;流程实例 id
     */
    @GetMapping("/process-log")
    public List<ProcessLogEntryDto> getProcessLog(
        @RequestParam(name = "processInstanceId", required = false) String processInstanceId,
        @AuthenticationPrincipal Jwt jwt
    ) {
        if (processInstanceId == null || processInstanceId.isBlank()) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "processInstanceId parameter is required for /dsh/history/process-log");
        }
        requireParticipant(processInstanceId, requireUserId(jwt));
        try {
            UUID.fromString(processInstanceId);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "processInstanceId must be a UUID: " + processInstanceId);
        }
        Path file = ProcessLog.fileOf(processInstanceId).normalize();
        if (!file.startsWith(ProcessLog.logDir()) || !Files.exists(file)) {
            return List.of();
        }
        try {
            return parseLogLines(Files.readAllLines(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new ResponseStatusException(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "Failed to read process log for instance: " + processInstanceId, e);
        }
    }

    /**
     * 实例日志行格式:{@code yyyy-MM-dd HH:mm:ss.SSS [节点名(节点id)] 消息}。
     * 节点名用贪婪匹配(名称本身可含括号),节点 id 不含括号。
     */
    private static final Pattern PROCESS_LOG_LINE = Pattern.compile(
        "^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}) \\[(.*)\\(([^()]*)\\)\\] (.*)$");

    /** 行文本 → 结构化条目;续行并入上一条,无法解析的行降级为 raw 原文条目。 */
    private static List<ProcessLogEntryDto> parseLogLines(List<String> lines) {
        List<ProcessLogEntryDto> entries = new ArrayList<>();
        for (String line : lines) {
            if (line.isBlank()) {
                continue;
            }
            Matcher m = PROCESS_LOG_LINE.matcher(line);
            if (m.matches()) {
                String name = "null".equals(m.group(2)) ? null : m.group(2);
                entries.add(new ProcessLogEntryDto(m.group(1), m.group(3), name, m.group(4), null));
            } else if (!entries.isEmpty() && entries.get(entries.size() - 1).raw() == null) {
                // 消息含换行:续行是上一条消息的一部分
                ProcessLogEntryDto prev = entries.get(entries.size() - 1);
                entries.set(entries.size() - 1, new ProcessLogEntryDto(
                    prev.timestamp(), prev.activityId(), prev.activityName(),
                    prev.message() + "\n" + line, null));
            } else {
                entries.add(new ProcessLogEntryDto(null, null, null, null, line));
            }
        }
        return entries;
    }

    private HistoricTaskDto toDto(HistoricTaskInstance task, Map<String, ProcessDefinition> defById) {
        Map<String, Object> localVars = task.getTaskLocalVariables();
        String metaJson = localVars == null
            ? null
            : (String) localVars.get(DshTaskListener.TASK_VARIABLE_DSH_META);
        String nodeId = localVars == null
            ? null
            : (String) localVars.get(DshTaskListener.TASK_VARIABLE_NODE_ID);

        DshExtensionProperties meta = null;
        if (metaJson != null && !metaJson.isBlank()) {
            try {
                meta = objectMapper.readValue(metaJson, DshExtensionProperties.class);
            } catch (JsonProcessingException e) {
                throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR,
                    "Failed to deserialize dsh_node_meta for historic task " + task.getId(), e);
            }
        }

        // 流程定义名从列表路径批量预查的 defById 取(避免逐条补查),查不到为 null
        ProcessDefinition def = task.getProcessDefinitionId() == null
            ? null : defById.get(task.getProcessDefinitionId());

        return new HistoricTaskDto(
            task.getId(),
            task.getProcessInstanceId(),
            task.getProcessDefinitionId(),
            def == null ? null : def.getName(),
            task.getTaskDefinitionKey(),
            task.getName(),
            task.getAssignee(),
            toIso(task.getStartTime()),
            toIso(task.getEndTime()),
            task.getDurationInMillis(),
            task.getDeleteReason(),
            meta,
            nodeId
        );
    }

    private HistoricProcessInstanceDto toDto(HistoricProcessInstance instance,
                                             Map<String, ProcessDefinition> defById) {
        // 流程定义名称/key/版本 Flowable 7 在 HistoricProcessInstance 上不一定全有;从列表路径
        // 批量预查的 defById 取(避免逐条补查),查不到为 null。
        ProcessDefinition def = instance.getProcessDefinitionId() == null
            ? null : defById.get(instance.getProcessDefinitionId());
        String defName = def == null ? null : def.getName();
        String defKey = def == null ? null : def.getKey();
        Integer defVersion = def == null ? null : def.getVersion();

        return new HistoricProcessInstanceDto(
            instance.getId(),
            instance.getProcessDefinitionId(),
            defKey,
            defName,
            defVersion,
            instance.getBusinessKey(),
            instance.getStartUserId(),
            toIso(instance.getStartTime()),
            toIso(instance.getEndTime()),
            instance.getDurationInMillis(),
            instance.getDeleteReason(),
            instance.getSuperProcessInstanceId()
        );
    }

    private HistoricActivityDto toDto(HistoricActivityInstance activity) {
        return new HistoricActivityDto(
            activity.getId(),
            activity.getProcessInstanceId(),
            activity.getProcessDefinitionId(),
            activity.getActivityId(),
            activity.getActivityName(),
            activity.getActivityType(),
            activity.getAssignee(),
            toIso(activity.getStartTime()),
            toIso(activity.getEndTime()),
            activity.getDurationInMillis()
        );
    }

    private HistoricVariableDto toDto(HistoricVariableInstance variable) {
        return new HistoricVariableDto(
            variable.getId(),
            variable.getProcessInstanceId(),
            variable.getVariableName(),
            variable.getVariableTypeName(),
            toSafeValue(variable.getValue()),
            toIso(variable.getCreateTime()),
            toIso(variable.getLastUpdatedTime())
        );
    }

    /**
     * 变量值安全转 JsonNode:Jackson 能序列化的类型原样转;不可序列化的
     * Serializable 值(复杂 POJO)降级为 toString 文本,保证审计端点不因单个变量失败。
     */
    private JsonNode toSafeValue(Object value) {
        if (value == null) {
            return objectMapper.nullNode();
        }
        try {
            return objectMapper.valueToTree(value);
        } catch (RuntimeException e) {
            return objectMapper.getNodeFactory().textNode(String.valueOf(value));
        }
    }

    private String toIso(Date date) {
        return date == null ? null : Instant.ofEpochMilli(date.getTime()).toString();
    }

    private static int clampSize(int size) {
        if (size <= 0) {
            return DEFAULT_PAGE_SIZE;
        }
        return Math.min(size, MAX_PAGE_SIZE);
    }
}
