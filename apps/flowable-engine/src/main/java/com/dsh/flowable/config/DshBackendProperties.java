package com.dsh.flowable.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * DSH backend task delegate 集成配置(design 2026-09-14 §6.2)。
 *
 * @param pollIntervalSeconds 轮询间隔秒(默认 3):提交后 GET 任务状态的节奏
 * @param callTimeoutSeconds  单次任务调用总超时秒(默认 600,含轮询累计):
 *                            LLM 会话含 thinking 耗时长,超时抛 IllegalStateException
 *                            交 async job 按重试周期重试(重新提交 = 新会话)
 * @param serviceKey          backend profile 任务端点的 X-Service-Key 密钥
 *                            (平台统一 DSH_SERVICE_KEY,与 backend-task 插件
 *                            serviceKey 同源);空白时启动即报错——任务端点已启用
 *                            鉴权,不带密钥的引擎会被 401 拒绝
 */
@ConfigurationProperties(prefix = "dsh.backend")
public record DshBackendProperties(
    long pollIntervalSeconds,
    long callTimeoutSeconds,
    String serviceKey
) {
    public DshBackendProperties {
        pollIntervalSeconds = pollIntervalSeconds <= 0 ? 3 : pollIntervalSeconds;
        callTimeoutSeconds = callTimeoutSeconds <= 0 ? 600 : callTimeoutSeconds;
        if (serviceKey == null || serviceKey.isBlank()) {
            throw new IllegalStateException(
                "dsh.backend.service-key 未配置:backend task 端点已启用 X-Service-Key 鉴权,"
                    + "请设置 DSH_SERVICE_KEY(与 backend profile 一致)");
        }
    }
}
