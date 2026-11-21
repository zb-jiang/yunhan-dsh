package com.dsh.console.runtime;

import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * Flowable 引擎 REST API 薄封装。
 *
 * <p>Web Console 后端通过此客户端调用 Flowable 引擎(V1 用 basic auth,见
 * {@link com.dsh.console.config.RestClientConfig})。所有路径前缀 {@code /process-api}
 * 对应 Flowable 7 OSS REST。
 *
 * <p>404 由本客户端抛 {@link NotFoundException},由
 * {@link com.dsh.console.common.GlobalExceptionHandler} 转 404;5xx 仍抛
 * {@code RestClientException} 转 502。
 *
 * <p>Flowable REST 变量格式:{@code [{"name":"k","value":"v"},...]},不是普通 JSON Map。
 * {@link #toRestVariables(Map)} 做转换。
 */
@Component("flowableServiceClient")
public class FlowableRestClient {

    private final RestClient flowableRestClient;
    private final ObjectMapper objectMapper;

    public FlowableRestClient(RestClient flowableRestClient, ObjectMapper objectMapper) {
        this.flowableRestClient = flowableRestClient;
        this.objectMapper = objectMapper;
    }

    /**
     * 启动流程实例。
     *
     * @param procdefId      Flowable procdef id
     * @param businessKey    业务键(可空)
     * @param name           实例名(可空)
     * @param variables      变量(可空,含 dsh_applicant_user_id 等)
     * @return Flowable 返回的实例 JSON(含 id / businessKey / processDefinitionId / startUserId / startTime / suspended)
     */
    public JsonNode startProcessInstance(String procdefId, String businessKey, String name,
                                        Map<String, Object> variables) {
        java.util.Map<String, Object> body = new java.util.HashMap<>();
        body.put("processDefinitionId", procdefId);
        if (businessKey != null && !businessKey.isBlank()) {
            body.put("businessKey", businessKey);
        }
        if (name != null && !name.isBlank()) {
            body.put("name", name);
        }
        body.put("variables", toRestVariables(variables));

        return flowableRestClient.post()
            .uri("/process-api/runtime/process-instances")
            .body(body)
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 查运行中实例详情。不存在抛 {@link NotFoundException}。
     */
    public JsonNode getRuntimeProcessInstance(String instanceId) {
        return flowableRestClient.get()
            .uri("/process-api/runtime/process-instances/{id}", instanceId)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("流程实例不存在(runtime): " + instanceId); })
            .body(JsonNode.class);
    }

    /**
     * 列运行中实例(可按 procdefId 过滤)。
     *
     * <p>Flowable 返回 {@code {"data":[...],"total":N,...}}。
     */
    public JsonNode listRuntimeProcessInstances(String procdefId, Integer start, Integer size) {
        return flowableRestClient.get()
            .uri(uriBuilder -> {
                uriBuilder.path("/process-api/runtime/process-instances");
                if (procdefId != null && !procdefId.isBlank()) {
                    uriBuilder.queryParam("processDefinitionId", procdefId);
                }
                if (start != null) {
                    uriBuilder.queryParam("start", start);
                }
                if (size != null) {
                    uriBuilder.queryParam("size", size);
                }
                return uriBuilder.build();
            })
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 终止实例(DELETE runtime instance + deleteReason)。
     *
     * <p>Flowable 7 OSS {@code DELETE /process-api/runtime/process-instances/{id}} 不直接支持
     * body,deleteReason 通过 query param 传。{@code cascade} 默认 false(只删实例,不删 historic);
     * V1 保留 historic 数据用于审计。
     *
     * @throws NotFoundException 实例不存在
     */
    public void deleteProcessInstance(String instanceId, String deleteReason) {
        flowableRestClient.delete()
            .uri(uriBuilder -> {
                uriBuilder.path("/process-api/runtime/process-instances/{id}");
                if (deleteReason != null && !deleteReason.isBlank()) {
                    uriBuilder.queryParam("deleteReason", deleteReason);
                }
                return uriBuilder.build(instanceId);
            })
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("流程实例不存在(已结束或不存在): " + instanceId); })
            .toBodilessEntity();
    }

    /**
     * 列实例当前任务(runtime tasks)。
     *
     * <p>Flowable 返回 {@code {"data":[...],"total":N,...}}。
     */
    public JsonNode listTasksByProcessInstance(String instanceId) {
        return flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/process-api/runtime/tasks")
                .queryParam("processInstanceId", instanceId)
                .build())
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 完成任务。
     *
     * <p>Flowable 7 REST 完成 task 用 {@code POST /process-api/runtime/tasks/{taskId}},
     * body {@code {"action":"complete","variables":[{"name":"k","value":"v"}]}}。
     *
     * @throws NotFoundException 任务不存在
     */
    public void completeTask(String taskId, Map<String, Object> variables) {
        java.util.Map<String, Object> body = new java.util.HashMap<>();
        body.put("action", "complete");
        body.put("variables", toRestVariables(variables));

        flowableRestClient.post()
            .uri("/process-api/runtime/tasks/{taskId}", taskId)
            .body(body)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("任务不存在: " + taskId); })
            .toBodilessEntity();
    }

    /**
     * 取流程定义已部署的 BPMN XML(启动校验按部署版本而非草稿)。
     *
     * <p>用 Flowable 单步端点 {@code GET /repository/process-definitions/{id}/resourcedata},
     * 引擎内部按 deploymentId + resourceName 定位资源,直接返回 XML 内容。
     * 注意 process-definition 详情响应里资源名字段是 {@code resource},不是 resourceName。
     *
     * @throws NotFoundException 流程定义不存在
     */
    public String getProcessDefinitionBpmnXml(String procdefId) {
        return flowableRestClient.get()
            .uri("/process-api/repository/process-definitions/{id}/resourcedata", procdefId)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("流程定义不存在: " + procdefId); })
            .body(String.class);
    }

    /**
     * 查流程定义详情(官方 REST,响应含 {@code key})。
     *
     * <p>runtime 实例的官方响应没有 processDefinitionKey,归属解析回退时按旧
     * procdefId 查定义拿 key——历史版本定义保留在 ACT_RE_PROCDEF,不会因重新发布消失。
     *
     * @throws NotFoundException 流程定义不存在
     */
    public JsonNode getProcessDefinition(String procdefId) {
        return flowableRestClient.get()
            .uri("/process-api/repository/process-definitions/{id}", procdefId)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("流程定义不存在: " + procdefId); })
            .body(JsonNode.class);
    }

    /**
     * 查单个历史实例(runtime 不存在时的详情回退)。
     *
     * <p>调官方 REST {@code GET /process-api/history/historic-process-instances/{id}}
     * (无行级归属过滤,管理员/应用管理员审计详情依赖此语义);不存在返回 {@code null}。
     * 响应无 {@code processDefinitionKey} 字段,定义归属回退由调用方按 procdefId 补查。
     */
    public JsonNode getHistoricProcessInstance(String instanceId) {
        return flowableRestClient.get()
            .uri("/process-api/history/historic-process-instances/{id}", instanceId)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new NotFoundException("历史实例不存在: " + instanceId); })
            .body(JsonNode.class);
    }

    /**
     * 列历史实例(含运行中,按发起时间倒序),返回 plain JSON 数组。
     *
     * <p>调官方 REST {@code POST /process-api/query/historic-process-instances}
     * (无行级归属过滤——引擎 {@code /dsh/history/*} 端点强制「仅本人相关」,管理员/
     * 应用管理员的实例列表依赖全量语义,故走官方 REST;角色可见性由调用方在
     * {@code ProcessInstanceService} 收窄)。排序固定按发起时间倒序,对齐引擎端点语义。
     *
     * <p>completed/terminated 没有服务端 deleteReason 过滤参数:按 finished=true
     * 拉取到当前页尾,本地按 deleteReason 过滤(正常完成实例 deleteReason 为 null,
     * 被终止实例非空)后切片,对齐原引擎端点「过滤后再分页」语义,翻页不漏不重。
     *
     * @param processDefinitionId  可选;按 procdef id 过滤(部署版本级)
     * @param processDefinitionKey 可选;按流程定义 key 过滤(跨部署版本收集,重新发布后旧版本实例不漏)
     * @param state                可选;completed/terminated,不传看全部(运行中列表不经此方法)
     * @param page                 页码(0-based)
     * @param size                 单页条数
     */
    public JsonNode listHistoricProcessInstances(String processDefinitionId, String processDefinitionKey,
                                                 String state, int page, int size) {
        boolean completedOnly = "completed".equalsIgnoreCase(state);
        boolean terminatedOnly = "terminated".equalsIgnoreCase(state);
        boolean finishedFilter = completedOnly || terminatedOnly;
        int safeSize = Math.max(1, size);
        int firstResult = Math.max(0, page) * safeSize;

        Map<String, Object> body = new LinkedHashMap<>();
        if (processDefinitionId != null && !processDefinitionId.isBlank()) {
            body.put("processDefinitionId", processDefinitionId);
        }
        if (processDefinitionKey != null && !processDefinitionKey.isBlank()) {
            body.put("processDefinitionKey", processDefinitionKey);
        }
        if (finishedFilter) {
            body.put("finished", true);
        }
        body.put("order", "desc");
        body.put("sort", "startTime");
        body.put("start", finishedFilter ? 0 : firstResult);
        body.put("size", finishedFilter ? firstResult + safeSize : safeSize);

        JsonNode resp = flowableRestClient.post()
            .uri("/process-api/query/historic-process-instances")
            .body(body)
            .retrieve()
            .body(JsonNode.class);
        JsonNode data = resp == null ? null : resp.path("data");
        if (data == null || !data.isArray()) {
            return objectMapper.createArrayNode();
        }
        if (!finishedFilter) {
            return data;
        }
        List<JsonNode> filtered = new ArrayList<>(data.size());
        for (JsonNode node : data) {
            boolean hasDeleteReason = node.hasNonNull("deleteReason")
                && !node.path("deleteReason").asText("").isBlank();
            if (terminatedOnly == hasDeleteReason) {
                filtered.add(node);
            }
        }
        ArrayNode pageData = objectMapper.createArrayNode();
        int from = Math.min(firstResult, filtered.size());
        int to = Math.min(firstResult + safeSize, filtered.size());
        for (int i = from; i < to; i++) {
            pageData.add(filtered.get(i));
        }
        return pageData;
    }

    /**
     * 列运行中实例(引擎 DSH 端点,按流程定义 key 跨部署版本收集)。
     *
     * <p>调引擎 {@code GET /dsh/runtime/process-instances},返回 plain JSON 数组
     * (非 Flowable REST 的 {@code {"data":[...]}} 包装),实例响应带官方 runtime
     * representation 缺失的 processDefinitionKey/Name/Version。流程重新发布后运行中
     * 实例可能仍挂在旧版本 procdef 上,按当前发布版本 procdefId 查会漏,按 key 查不漏。
     *
     * @param processDefinitionKey 可选;按流程定义 key 过滤,不传返回全部运行中实例
     * @param page                 页码(0-based,引擎端点语义)
     * @param size                 单页条数
     */
    public JsonNode listDshRuntimeProcessInstances(String processDefinitionKey, int page, int size) {
        return flowableRestClient.get()
            .uri(uriBuilder -> {
                uriBuilder.path("/dsh/runtime/process-instances");
                if (processDefinitionKey != null && !processDefinitionKey.isBlank()) {
                    uriBuilder.queryParam("processDefinitionKey", processDefinitionKey);
                }
                uriBuilder.queryParam("page", Math.max(0, page));
                uriBuilder.queryParam("size", Math.max(1, size));
                return uriBuilder.build();
            })
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 查实例历史变量(上下文变量当前/最终值)。
     *
     * <p>调引擎 {@code GET /dsh/history/variables?processInstanceId=},返回 plain JSON 数组。
     */
    public JsonNode listHistoricVariables(String instanceId) {
        return flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/dsh/history/variables")
                .queryParam("processInstanceId", instanceId)
                .build())
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 查实例历史活动(执行路径回溯,含 sequenceFlow)。
     *
     * <p>调引擎 {@code GET /dsh/history/activities?processInstanceId=},返回 plain JSON 数组。
     */
    public JsonNode listHistoricActivities(String instanceId) {
        return flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/dsh/history/activities")
                .queryParam("processInstanceId", instanceId)
                .build())
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 回读实例业务日志(引擎实例日志文件的结构化条目)。
     *
     * <p>调引擎 {@code GET /dsh/history/process-log?processInstanceId=}:引擎读
     * {@code logs/process/<实例id>.log} 逐行解析;文件不存在返回空数组。
     * 返回 plain JSON 数组。
     */
    public JsonNode getProcessLog(String instanceId) {
        return flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/dsh/history/process-log")
                .queryParam("processInstanceId", instanceId)
                .build())
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 查实例历史任务(实例级审计,返回该实例全部任务)。
     *
     * <p>调引擎 {@code GET /dsh/history/tasks?processInstanceId=}:引擎在带实例范围时
     * 不按当前用户过滤。返回 plain JSON 数组。
     */
    public JsonNode listHistoricTasks(String instanceId) {
        return flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/dsh/history/tasks")
                .queryParam("processInstanceId", instanceId)
                .queryParam("size", 200)
                .build())
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * Map 变量转 Flowable REST 变量数组格式。
     *
     * <p>Flowable REST 变量是 {@code [{"name":"k","value":"v"}]} 数组,不是 Map。
     * 值为 null 时跳过(Flowable 不接受 null value)。
     */
    static List<Map<String, Object>> toRestVariables(Map<String, Object> variables) {
        List<Map<String, Object>> result = new ArrayList<>();
        if (variables == null || variables.isEmpty()) {
            return result;
        }
        variables.forEach((k, v) -> {
            if (v == null) {
                return;
            }
            result.add(Map.of("name", k, "value", v));
        });
        return result;
    }

    /**
     * 按 process definition key 统计运行中实例数(跨全部部署版本)。
     *
     * <p>流程重新发布走 Flowable 版本化(同 key 新版本),运行中实例可能挂在
     * 旧版本上;按 procdefId 查只能数到当前版本,守卫判定必须按 key 聚合。
     *
     * @param procdefKey BPMN process 元素 id(同流程各版本一致)
     * @return 运行中实例总数;查询异常返回 -1(调用方按"无法确认"拒绝)
     */
    public int countRunningInstancesByProcdefKey(String procdefKey) {
        JsonNode resp = flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/process-api/runtime/process-instances")
                .queryParam("processDefinitionKey", procdefKey)
                .queryParam("size", 1)
                .build())
            .retrieve()
            .body(JsonNode.class);
        return resp == null ? -1 : resp.path("total").asInt(-1);
    }

    /**
     * 按部署版本(procdef id)统计运行中实例数。
     *
     * <p>角色停用守卫用:逐版本判定"该版本是否有运行中实例",只解析
     * 真正有实例在跑的版本的 BPMN XML。
     *
     * @param procdefId Flowable procdef id(具体版本)
     * @return 该版本运行中实例数;查询异常返回 -1(调用方按"无法确认"拒绝)
     */
    public int countRunningInstancesByProcdefId(String procdefId) {
        JsonNode resp = flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/process-api/runtime/process-instances")
                .queryParam("processDefinitionId", procdefId)
                .queryParam("size", 1)
                .build())
            .retrieve()
            .body(JsonNode.class);
        return resp == null ? -1 : resp.path("total").asInt(-1);
    }

    /**
     * 列流程定义 key 的全部部署版本 procdef id(重新发布各产生一个版本)。
     *
     * <p>角色停用守卫用:配合 {@link #countRunningInstancesByProcdefId} 定位
     * 有运行中实例的版本。分页拉全(每页 100)。
     *
     * @throws IllegalStateException Flowable 响应缺 total 字段
     */
    public List<String> listProcessDefinitionIdsByKey(String key) {
        List<String> ids = new ArrayList<>();
        int start = 0;
        int pageSize = 100;
        while (true) {
            final int startParam = start;
            JsonNode resp = flowableRestClient.get()
                .uri(uriBuilder -> uriBuilder
                    .path("/process-api/repository/process-definitions")
                    .queryParam("key", key)
                    .queryParam("start", startParam)
                    .queryParam("size", pageSize)
                    .build())
                .retrieve()
                .body(JsonNode.class);
            if (resp == null || !resp.has("total")) {
                throw new IllegalStateException("Flowable 流程定义查询响应缺 total 字段: key=" + key);
            }
            int total = resp.path("total").asInt(-1);
            if (total < 0) {
                throw new IllegalStateException("Flowable 流程定义查询响应 total 非法: key=" + key);
            }
            for (JsonNode item : resp.path("data")) {
                ids.add(item.path("id").asText());
            }
            start += pageSize;
            if (start >= total) {
                return ids;
            }
        }
    }

    /**
     * 查流程定义的 key(BPMN process 元素 id)。
     *
     * @throws NotFoundException 流程定义不存在
     */
    public String getProcessDefinitionKey(String procdefId) {
        JsonNode resp = flowableRestClient.get()
            .uri("/process-api/repository/process-definitions/{id}", procdefId)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp404) -> { throw new NotFoundException("流程定义不存在: " + procdefId); })
            .body(JsonNode.class);
        if (resp == null || resp.path("key").asText().isEmpty()) {
            throw new IllegalStateException("Flowable procdef 响应缺 key 字段: " + procdefId);
        }
        return resp.path("key").asText();
    }

    /**
     * 统计某办理人(auth_subject)名下未完成的运行中任务数。
     *
     * @param assignee 办理人标识(Supabase Auth user.id)
     * @return 未完成任务数;查询异常返回 -1(调用方按"无法确认"拒绝)
     */
    public int countOpenTasksByAssignee(String assignee) {
        JsonNode resp = flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/process-api/runtime/tasks")
                .queryParam("assignee", assignee)
                .queryParam("size", 1)
                .build())
            .retrieve()
            .body(JsonNode.class);
        return resp == null ? -1 : resp.path("total").asInt(-1);
    }

    /**
     * 统计某办理人在指定流程(跨全部部署版本)名下的未完成任务数。
     *
     * <p>成员停用守卫用:只数该应用内该成员已认领(assigned)的任务;
     * 未认领的候选任务可由其他成员认领,不阻塞停用。
     *
     * @param assignee    办理人标识(Supabase Auth user.id)
     * @param procdefKey  BPMN process 元素 id(同流程各版本一致)
     * @return 未完成任务数;查询异常返回 -1(调用方按"无法确认"拒绝)
     */
    public int countOpenTasksByAssigneeAndProcdefKey(String assignee, String procdefKey) {
        JsonNode resp = flowableRestClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/process-api/runtime/tasks")
                .queryParam("assignee", assignee)
                .queryParam("processDefinitionKey", procdefKey)
                .queryParam("size", 1)
                .build())
            .retrieve()
            .body(JsonNode.class);
        return resp == null ? -1 : resp.path("total").asInt(-1);
    }

    // ==================== 分析看板(设计 2026-09-25) ====================

    /**
     * 分析聚合:流程实例概览统计(发起/完成/运行中/终止 + 时长均值/P95)。
     *
     * <p>调引擎 {@code GET /dsh/analytics/overview},透传当前用户 JWT(请求线程)。
     * {@code processDefinitionKeys} 为空集合 = 不过滤;非空时按 key 集合并集聚合。
     */
    public JsonNode getAnalyticsOverview(int days, List<String> processDefinitionKeys) {
        return analyticsGet("/dsh/analytics/overview", days, processDefinitionKeys);
    }

    /**
     * 分析聚合:每日吞吐量(发起数按发起日/完成数按完成日,同一日期轴)。
     */
    public JsonNode getAnalyticsDailyVolumes(int days, List<String> processDefinitionKeys) {
        return analyticsGet("/dsh/analytics/daily-volumes", days, processDefinitionKeys);
    }

    /**
     * 分析聚合:节点活动统计(热力图 + TOP 最慢节点,含 sequenceFlow 连线)。
     */
    public JsonNode getAnalyticsActivityStats(int days, List<String> processDefinitionKeys) {
        return analyticsGet("/dsh/analytics/activity-stats", days, processDefinitionKeys);
    }

    /**
     * 分析聚合:办理人时效统计(assignee 为 user.id,displayName 由本服务补齐)。
     */
    public JsonNode getAnalyticsTaskStats(int days, List<String> processDefinitionKeys) {
        return analyticsGet("/dsh/analytics/task-stats", days, processDefinitionKeys);
    }

    /** 引擎分析端点公共 GET(透传用户 JWT;key 集合为空不传参)。 */
    private JsonNode analyticsGet(String path, int days, List<String> processDefinitionKeys) {
        return flowableRestClient.get()
            .uri(uriBuilder -> {
                uriBuilder.path(path).queryParam("days", days);
                if (processDefinitionKeys != null && !processDefinitionKeys.isEmpty()) {
                    uriBuilder.queryParam("processDefinitionKeys", String.join(",", processDefinitionKeys));
                }
                return uriBuilder.build();
            })
            .retrieve()
            .body(JsonNode.class);
    }

    /**
     * 查引擎单个 actuator 指标(分析看板运维指标轮询用)。
     *
     * <p>调 {@code GET /actuator/metrics/{metric}},返回 {@code {name, description,
     * baseUnit, measurements:[{statistic,value}], availableTags:[...]}}。
     * 调度线程无用户 JWT,透传 interceptor 不补头——引擎侧该端点 permitAll(内网信任)。
     *
     * @param metricName 指标名(如 dsh.flowable.jobs.async)
     * @param tagFilter  可选;tag 过滤(格式 {@code tagKey:tagValue},如 outcome:success)
     */
    public JsonNode getEngineMetric(String metricName, String tagFilter) {
        return flowableRestClient.get()
            .uri(uriBuilder -> {
                uriBuilder.path("/actuator/metrics/{metric}");
                if (tagFilter != null && !tagFilter.isBlank()) {
                    uriBuilder.queryParam("tag", tagFilter);
                }
                return uriBuilder.build(metricName);
            })
            .retrieve()
            .body(JsonNode.class);
    }
}
