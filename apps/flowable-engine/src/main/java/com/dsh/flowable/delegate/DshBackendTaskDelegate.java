package com.dsh.flowable.delegate;

import com.dsh.flowable.listener.DshBpmnParseHandler;
import com.dsh.flowable.listener.DshContextVariable;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshExtensionResolver;
import com.dsh.flowable.listener.DshPromptInterpolator;
import com.dsh.flowable.listener.DshVariableMappingSupport;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * DSH backend task 的引擎 delegate(design 2026-09-14 §6.3;多实例扩展 2026-09-15)。
 *
 * <p>流程实例走到带 {@code dsh:backendTask} 扩展的 serviceTask(async job)时:
 * <ol>
 *   <li>解析节点扩展属性(backendProfileUrl / 多实例 profile 列表 / userPrompt /
 *       skillRefs / outputMappings,经 {@link DshExtensionResolver#resolveServiceTaskProperties}
 *       走 cache)。</li>
 *   <li>{@code {{var.path}}} 插值 userPrompt(与 user task 任务创建同语义:缺失→「空」,
 *       object/array 序列化 JSON 文本;{@link DshPromptInterpolator} 公共)。</li>
 *   <li>调 {@link DshBackendClient} 提交 backend profile 并轮询到 ready 拿 result JSON;
 *       多实例时按 {@code loopCounter} 取 {@code dsh:backendProfile} 列表的第 i 个
 *       URL(每实例可绑定不同 profile,发布校验保证列表长度等于实例数)。</li>
 *   <li>按 outputMappings 映射写入:source 相对 result 根点路径取值(空=整体),
 *       按上下文声明类型转换({@link DshVariableMappingSupport} 公共),target 点路径
 *       深入写入;**array 根为整体覆盖写,不做 user task 多实例的 append 聚合**;
 *       未声明变量拒绝写入抛错。</li>
 * </ol>
 *
 * <p>知识库(2026-10 集成):提交前经 {@link WebConsoleKbClient} 按流程定义解析
 * 所属工程的知识库,kb 随 payload(kbId/kbName)下发,backend profile 据此注入
 * kb 上下文并圈定 kb_* 工具;未开通/解析降级为 null,payload 不带 kb 字段。
 *
 * <p>实例空间关联(2026-10-14 任务2):payload 另带 processInstanceId(流程实例 id)
 * 与 taskId(节点 id),backend profile 据此读写该实例的云工作空间;旧 profile
 * 未升级时忽略这两个字段,不影响既有流程。
 *
 * <p>任何失败(HTTP 不通/超时/failed/JSON 不合法/映射失败)抛异常,交给 async job
 * 按 {@code flowable:failedJobRetryTimeCycle} 重试;重试耗尽走异常边界事件。
 */
@Component("dshBackendTaskDelegate")
public class DshBackendTaskDelegate implements JavaDelegate {

    private static final Logger log = LoggerFactory.getLogger(DshBackendTaskDelegate.class);

    private final DshExtensionResolver resolver;
    private final DshBackendClient client;
    private final WebConsoleKbClient kbClient;
    private final ObjectMapper objectMapper;
    private final MeterRegistry meterRegistry;

    public DshBackendTaskDelegate(DshExtensionResolver resolver,
                                   DshBackendClient client,
                                   WebConsoleKbClient kbClient,
                                   ObjectMapper objectMapper,
                                   MeterRegistry meterRegistry) {
        this.resolver = resolver;
        this.client = client;
        this.kbClient = kbClient;
        this.objectMapper = objectMapper;
        this.meterRegistry = meterRegistry;
    }

    @Override
    public void execute(DelegateExecution execution) {
        String activityId = execution.getCurrentActivityId();
        DshExtensionProperties props = resolver.resolveServiceTaskProperties(
            execution.getProcessDefinitionId(), activityId);
        if (props == null || props.backendTask() == null) {
            // 发布校验保证合法 XML 才能部署;走到这里说明部署被绕过(手改库/直连引擎)
            throw new IllegalStateException("DSH backend task 节点缺少 dsh:backendTask 扩展"
                + "(activity " + activityId + ",流程应经 web-console 发布校验)");
        }
        String profileUrl = resolveProfileUrl(props.backendTask(), execution, activityId);
        if (profileUrl == null) {
            throw new IllegalStateException("DSH backend task 节点缺少 backendProfileUrl"
                + "(activity " + activityId + ",流程应经 web-console 发布校验)");
        }
        String prompt = interpolatePrompt(props, execution);
        // 知识库是可选增强:解析失败/未开通都降级为无 kb,不阻塞任务
        WebConsoleKbClient.KbRef kb = kbClient.resolveOrNull(
            execution.getProcessDefinitionId(), activityId);
        // 每次尝试(含 async job 重试)都在实例日志留下完整输入/产出/失败,重试重放会重复记录
        ProcessLog.log(execution, "提交 backend task -> {}\n{}",
            profileUrl, prompt + (kb == null ? "" : "\n[知识库] " + kb.kbId() + " " + kb.kbName()));
        // 运维指标:backend task 调用计时(success/failed 分 tag)+ 失败计数
        // (分析看板按 dsh_metrics_sample 的 COUNT/TOTAL_TIME 窗口差分算成功率与平均时延)
        long start = System.nanoTime();
        Map<String, Object> result;
        try {
            result = client.execute(profileUrl, prompt, props.skillRefs(), activityId,
                execution.getProcessInstanceId(), kb);
        } catch (RuntimeException e) {
            meterRegistry.timer("dsh.backend.task", "outcome", "failed")
                .record(System.nanoTime() - start, TimeUnit.NANOSECONDS);
            meterRegistry.counter("dsh.backend.task.failure").increment();
            ProcessLog.log(execution, "backend task 调用失败: {}", e.getMessage());
            throw e;
        }
        meterRegistry.timer("dsh.backend.task", "outcome", "success")
            .record(System.nanoTime() - start, TimeUnit.NANOSECONDS);
        ProcessLog.log(execution, "backend task 返回: {}", toJson(result));
        applyOutputMappings(execution, result, props.outputMappings(), props.contextVariables());
        log.info("[DSH backend] {} 完成,输出映射 {} 条", activityId,
            props.outputMappings() == null ? 0 : props.outputMappings().size());
    }

    /**
     * 解析本实例应调用的 backend profile URL:多实例(执行上有 {@code loopCounter}
     * 本地变量)按序号取 {@code dsh:backendProfile} 列表第 i 个,列表缺失或越界
     * 抛异常(发布校验要求列表长度等于 loopCardinality,走到这里说明部署被绕过);
     * 单实例读 {@code backendProfileUrl} 属性。
     */
    private String resolveProfileUrl(DshExtensionProperties.BackendTask backendTask,
                                     DelegateExecution execution, String activityId) {
        Integer loopCounter = execution.getVariableLocal(DshBpmnParseHandler.LOOP_COUNTER_VARIABLE)
            instanceof Number n ? n.intValue() : null;
        if (loopCounter == null) {
            return backendTask.backendProfileUrl();
        }
        List<String> urls = backendTask.profileUrls();
        if (urls == null || urls.isEmpty()) {
            throw new IllegalStateException("DSH backend task 多实例未配置 dsh:backendProfile"
                + " 列表(activity " + activityId + ";发布校验要求列表长度等于实例数,"
                + "流程应经 web-console 发布)");
        }
        if (loopCounter >= urls.size()) {
            throw new IllegalStateException(String.format(
                "DSH backend task 多实例 profile 列表长度(%d)不大于当前实例序号(%d)"
                    + "(activity %s;流程应经 web-console 发布校验)",
                urls.size(), loopCounter, activityId));
        }
        return urls.get(loopCounter);
    }

    /** {{var.path}} 插值(与 user task 任务创建同语义,公共插值器)。 */
    private String interpolatePrompt(DshExtensionProperties props, DelegateExecution execution) {
        String template = props.userPrompt();
        if (template == null || template.isBlank()) {
            return "";
        }
        return DshPromptInterpolator.interpolate(template, execution::getVariable, objectMapper);
    }

    /** result 序列化为 JSON 文本(写实例日志);序列化失败退回 Map.toString。 */
    private String toJson(Map<String, Object> result) {
        try {
            return objectMapper.writeValueAsString(result);
        } catch (JsonProcessingException e) {
            return String.valueOf(result);
        }
    }

    /**
     * 执行输出映射:source 取值 → 声明类型转换 → target 写入。
     * source 提取结果为 null(字段缺失)跳过该条;未声明 target / 系统注入变量 /
     * 类型不符 / 深路径字段未在字段清单声明抛异常走重试。根路径按根变量声明转换,
     * array 整体覆盖(user task 的 append 聚合不适用:自动节点每次执行就是完整产出);
     * 深路径按叶子字段声明转换(值形态对应叶子字段)。
     */
    private void applyOutputMappings(DelegateExecution execution,
                                     Map<String, Object> result,
                                     List<DshExtensionProperties.OutputMapping> mappings,
                                     List<DshContextVariable> declarations) {
        if (mappings == null || mappings.isEmpty()) {
            return;
        }
        for (DshExtensionProperties.OutputMapping mapping : mappings) {
            Object value = DshVariableMappingSupport.extractSource(result, mapping.source());
            if (value == null) {
                continue;
            }
            String target = mapping.target();
            if (target == null || target.isBlank()) {
                throw new IllegalArgumentException("DSH backend task 输出映射缺少 target");
            }
            String root = DshVariableMappingSupport.rootSegment(target);
            DshContextVariable decl = declarations.stream()
                .filter(d -> root.equals(d.name()))
                .findFirst()
                .orElse(null);
            if (decl == null) {
                throw new IllegalArgumentException(
                    "输出映射 target 指向未声明变量: " + root + "(先在「上下文变量」面板声明)");
            }
            if (DshContextVariable.SYSTEM_SOURCE.equals(decl.source())) {
                throw new IllegalArgumentException(
                    "输出映射 target 指向系统注入变量: " + root + "(按登录人注入,不允许节点产出覆盖)");
            }
            String rest = target.contains(".")
                ? target.substring(target.indexOf('.') + 1) : null;
            if (rest == null) {
                // array 与 object/标量同分支:整体覆盖写(无多实例聚合语义)
                execution.setVariable(root, DshVariableMappingSupport.convertByType(value, decl));
            } else {
                // 深路径:叶子值按字段清单里叶子字段的声明类型转换
                // (根是 object,值形态对应叶子字段,不按根类型校验)
                DshContextVariable.Field leaf = DshVariableMappingSupport.resolveLeafField(decl, rest);
                if (leaf == null) {
                    throw new IllegalArgumentException(
                        "输出映射 target=" + target + " 的字段路径未在根变量字段清单中声明"
                        + "(设计器下拉只提供已声明路径)");
                }
                Object leafValue = DshVariableMappingSupport.convertByType(value, leaf);
                Object existing = execution.getVariable(root);
                if (existing != null && !(existing instanceof Map)) {
                    throw new IllegalArgumentException(
                        "映射 target=" + target + " 的根变量已有非 object 值,无法深入字段路径");
                }
                Map<String, Object> map =
                    DshVariableMappingSupport.copyMap((Map<?, ?>) existing);
                DshVariableMappingSupport.setPath(map, rest, leafValue);
                execution.setVariable(root, map);
            }
        }
    }
}
