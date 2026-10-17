package com.dsh.flowable.delegate;

import com.dsh.flowable.config.DshBackendProperties;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

/**
 * DSH backend profile 的 HTTP 调用客户端(design 2026-09-14 §6.2)。
 *
 * <p>提交 + 轮询模式:{@code POST {baseUrl}/api/backend/tasks} 建任务拿 taskId,
 * 按 {@code dsh.backend.poll-interval-seconds} 间隔轮询
 * {@code GET {baseUrl}/api/backend/tasks/{taskId}},累计到
 * {@code dsh.backend.call-timeout-seconds} 抛 {@link IllegalStateException};
 * {@code ready} 返回 result JSON(Map),{@code failed} 抛异常携带 error 文本。
 *
 * <p>失败语义:任何失败(HTTP 不通/超时/failed/result 非 JSON 对象)都抛
 * {@link IllegalStateException}/{@link IllegalArgumentException},由
 * {@link DshBackendTaskDelegate} 上抛给 async job 按重试周期重试。
 *
 * <p>形态:@Component + Properties record + execute + 失败抛异常,
 * 传输层为 HTTP(backend profile 是常驻服务)。
 */
@Component
public class DshBackendClient {

    private static final Logger log = LoggerFactory.getLogger(DshBackendClient.class);

    private final DshBackendProperties properties;
    private final ObjectMapper objectMapper;
    private final RestTemplate restTemplate;

    public DshBackendClient(DshBackendProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.restTemplate = new RestTemplate();
    }

    /**
     * 提交并等待一个 backend task 完成,返回其 result JSON。
     *
     * @param baseUrl   backend profile 实例 URL(协议+主机+端口)
     * @param prompt    插值后的 userPrompt
     * @param skillRefs 节点引用的 skill 清单
     * @param activityId 节点 id(日志定位;payload 的 taskId,可空)
     * @param processInstanceId 流程实例 id(payload 关联键,实例空间按它定位;
     *                          可空,兼容手工构造的测试场景)
     * @param kb        任务知识库(可为 null:应用未开通知识库或解析降级,
     *                  非 null 时 payload 附带 kbId/kbName 供 backend profile
     *                  注入 kb 上下文并圈定 kb_* 工具范围)
     * @return ready 任务的 result(JSON 对象反序列化为 Map)
     * @throws IllegalStateException  提交/轮询 HTTP 失败、超时、任务 failed
     * @throws IllegalArgumentException result 不是 JSON 对象
     */
    public Map<String, Object> execute(String baseUrl, String prompt,
                                        List<String> skillRefs, String activityId,
                                        String processInstanceId,
                                        WebConsoleKbClient.KbRef kb) {
        String taskId = submit(baseUrl, prompt, skillRefs, activityId, processInstanceId, kb);
        return pollUntilReady(baseUrl, taskId, activityId);
    }

    /** 提交任务:POST /api/backend/tasks → 202 { taskId }。 */
    private String submit(String baseUrl, String prompt,
                           List<String> skillRefs, String activityId,
                           String processInstanceId,
                           WebConsoleKbClient.KbRef kb) {
        String url = baseUrl + "/api/backend/tasks";
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        Map<String, Object> payload = new HashMap<>();
        payload.put("prompt", prompt == null ? "" : prompt);
        payload.put("skillRefs", skillRefs == null ? List.of() : skillRefs);
        // 实例空间关联键(design 2026-10-14 任务2):backend profile 据此定位实例空间;
        // taskId 取节点 id(可空),未升级的 backend profile 忽略这两个新字段
        payload.put("processInstanceId", processInstanceId);
        payload.put("taskId", activityId);
        if (kb != null) {
            payload.put("kbId", kb.kbId());
            payload.put("kbName", kb.kbName());
        }
        String body;
        try {
            body = objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("backend task 请求体序列化失败(activity " + activityId + ")", e);
        }
        ResponseEntity<String> response;
        try {
            response = restTemplate.postForEntity(url, new HttpEntity<>(body, headers), String.class);
        } catch (RestClientException e) {
            throw new IllegalStateException("backend profile 提交失败(" + url + ", activity "
                + activityId + "): " + e.getMessage(), e);
        }
        if (response.getStatusCode().value() != 202 || response.getBody() == null) {
            throw new IllegalStateException("backend profile 提交返回异常状态(" + url + ", activity "
                + activityId + "): " + response.getStatusCode());
        }
        try {
            Map<String, Object> parsed = objectMapper.readValue(
                response.getBody(), new TypeReference<Map<String, Object>>() {});
            Object taskId = parsed.get("taskId");
            if (taskId == null || String.valueOf(taskId).isBlank()) {
                throw new IllegalStateException("backend profile 提交响应缺 taskId(activity "
                    + activityId + "): " + abbreviate(response.getBody()));
            }
            return String.valueOf(taskId);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("backend profile 提交响应解析失败(activity "
                + activityId + "): " + abbreviate(response.getBody()), e);
        }
    }

    /** 轮询直到 ready / failed / 超时;ready 返回 result。 */
    private Map<String, Object> pollUntilReady(String baseUrl, String taskId, String activityId) {
        String url = baseUrl + "/api/backend/tasks/" + taskId;
        long deadline = System.currentTimeMillis() + properties.callTimeoutSeconds() * 1000;
        while (System.currentTimeMillis() < deadline) {
            ResponseEntity<String> response;
            try {
                response = restTemplate.exchange(url, HttpMethod.GET, null, String.class);
            } catch (RestClientException e) {
                throw new IllegalStateException("backend profile 轮询失败(" + url + ", activity "
                    + activityId + "): " + e.getMessage(), e);
            }
            if (response.getStatusCode().value() != 200 || response.getBody() == null) {
                throw new IllegalStateException("backend profile 轮询返回异常状态(" + url
                    + ", activity " + activityId + "): " + response.getStatusCode());
            }
            Map<String, Object> parsed;
            try {
                parsed = objectMapper.readValue(
                    response.getBody(), new TypeReference<Map<String, Object>>() {});
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("backend profile 轮询响应解析失败(activity "
                    + activityId + "): " + abbreviate(response.getBody()), e);
            }
            String status = String.valueOf(parsed.get("status"));
            switch (status) {
                case "running" -> sleepBeforeNextPoll();
                case "ready" -> {
                    log.info("[DSH backend] 任务完成: activity={}, taskId={}", activityId, taskId);
                    return extractResult(parsed.get("result"), activityId);
                }
                case "failed" -> throw new IllegalStateException("backend task 失败(activity "
                    + activityId + "): " + parsed.get("error"));
                default -> throw new IllegalStateException("backend task 状态未知(activity "
                    + activityId + "): " + status);
            }
        }
        throw new IllegalStateException("backend task 轮询超时(" + properties.callTimeoutSeconds()
            + "s, activity " + activityId + "): " + url);
    }

    /**
     * 取 result 字段:JSON 对象直接返回;字符串则按「首个 { 到末个 }」容错提取解析
     * (防模型输出包了代码块外的说明文字)。
     */
    private Map<String, Object> extractResult(Object result, String activityId) {
        if (result instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            return typed;
        }
        if (result instanceof String text) {
            int start = text.indexOf('{');
            int end = text.lastIndexOf('}');
            if (start >= 0 && end > start) {
                try {
                    return objectMapper.readValue(
                        text.substring(start, end + 1),
                        new TypeReference<Map<String, Object>>() {});
                } catch (JsonProcessingException e) {
                    throw new IllegalArgumentException("backend task result JSON 解析失败(activity "
                        + activityId + "): " + abbreviate(text), e);
                }
            }
        }
        throw new IllegalArgumentException("backend task result 不是 JSON 对象(activity "
            + activityId + "): " + String.valueOf(result));
    }

    private void sleepBeforeNextPoll() {
        try {
            Thread.sleep(properties.pollIntervalSeconds() * 1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("backend task 轮询被中断", e);
        }
    }

    private static String abbreviate(String text) {
        if (text == null) {
            return "";
        }
        return text.length() <= 200 ? text : text.substring(0, 200) + "…";
    }
}
