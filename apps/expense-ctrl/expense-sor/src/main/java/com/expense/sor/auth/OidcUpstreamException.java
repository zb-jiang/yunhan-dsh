package com.expense.sor.auth;

/**
 * 认证中心(SSO 上游)调用失败:discovery 文档不可达/缺端点、token 端点非 2xx/
 * 响应非 JSON/缺 id_token。由 {@code GlobalExceptionHandler} 映射 502——上游
 * 故障不是本服务内部错误,引导调用方重试或检查认证中心部署状态。
 */
public class OidcUpstreamException extends RuntimeException {

    public OidcUpstreamException(String message) {
        super(message);
    }

    public OidcUpstreamException(String message, Throwable cause) {
        super(message, cause);
    }
}
