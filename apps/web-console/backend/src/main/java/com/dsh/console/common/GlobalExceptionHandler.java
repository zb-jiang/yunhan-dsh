package com.dsh.console.common;

import com.dsh.console.auth.OidcUpstreamException;
import com.dsh.console.knowledge.KbStorageException;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.util.unit.DataSize;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.client.RestClientException;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.context.request.async.AsyncRequestTimeoutException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

/**
 * 全局异常处理。
 *
 * <p>把业务异常与框架异常统一包装为 {@link ApiResponse} 返回,前端按 code 分发处理。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /** multipart 全局单文件上限(MB),用于超限消息提示具体数值。 */
    private final long multipartMaxFileMb;

    public GlobalExceptionHandler(
            @Value("${spring.servlet.multipart.max-file-size:64MB}") DataSize multipartMaxFileSize) {
        this.multipartMaxFileMb = multipartMaxFileSize.toMegabytes();
    }

    /** 业务异常:返回 400。 */
    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiResponse<Void>> handleIllegalArgument(IllegalArgumentException e) {
        log.warn("Business exception: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.fail(ApiError.of("BUSINESS_ERROR", e.getMessage())));
    }

    /** 业务状态冲突(守卫拒绝,如流程实例未结束):返回 409。 */
    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<ApiResponse<Void>> handleIllegalState(IllegalStateException e) {
        log.warn("Business conflict: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT)
            .body(ApiResponse.fail(ApiError.of("BUSINESS_CONFLICT", e.getMessage())));
    }

    /** 业务 not found:返回 404。 */
    @ExceptionHandler(NotFoundException.class)
    public ResponseEntity<ApiResponse<Void>> handleNotFound(NotFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
            .body(ApiResponse.fail(ApiError.of("NOT_FOUND", e.getMessage())));
    }

    /** 权限不足:返回 403。 */
    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ApiResponse<Void>> handleAccessDenied(AccessDeniedException e) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
            .body(ApiResponse.fail(ApiError.of("FORBIDDEN", e.getMessage())));
    }

    /** 请求体校验失败:返回 400。 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValidation(MethodArgumentNotValidException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.fail(new ApiError("VALIDATION_ERROR",
                "请求体校验失败",
                e.getBindingResult().getFieldErrors().stream()
                    .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
                    .toList())));
    }

    /**
     * 请求体 JSON 反序列化失败(类型不匹配/格式非法):返回 400。
     *
     * <p>消息带 Jackson 定位的字段与原因(如 workflowDefinitionId 传了非 UUID),
     * 调用方(员工端模型/前端)据此自我纠正;不落兜底 500——那会让模型无从判断。
     */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiResponse<Void>> handleMessageNotReadable(HttpMessageNotReadableException e) {
        log.warn("Request body JSON parse error: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.fail(ApiError.of("JSON_PARSE_ERROR",
                "请求体 JSON 非法: " + e.getMostSpecificCause().getMessage())));
    }

    /** Flowable REST 调用失败:返回 502。 */
    @ExceptionHandler(RestClientException.class)
    public ResponseEntity<ApiResponse<Void>> handleRestClient(RestClientException e) {
        log.error("Flowable REST call failed", e);
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
            .body(ApiResponse.fail(ApiError.of("FLOWABLE_REST_ERROR",
                "调用流程引擎失败:" + e.getMessage())));
    }

    /** 认证中心(SSO 上游)调用失败:返回 502。 */
    @ExceptionHandler(OidcUpstreamException.class)
    public ResponseEntity<ApiResponse<Void>> handleOidcUpstream(OidcUpstreamException e) {
        log.error("OIDC upstream call failed", e);
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
            .body(ApiResponse.fail(ApiError.of("OIDC_UPSTREAM_ERROR",
                "认证中心调用失败:" + e.getMessage())));
    }

    /** Supabase Storage 调用失败(知识库上传/下载/删除):返回 502。 */
    @ExceptionHandler(KbStorageException.class)
    public ResponseEntity<ApiResponse<Void>> handleKbStorage(KbStorageException e) {
        log.error("Supabase Storage call failed", e);
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
            .body(ApiResponse.fail(ApiError.of("STORAGE_ERROR",
                "访问文档存储失败:" + e.getMessage())));
    }

    /** 上传文件超过 multipart 上限:返回 400,消息带具体上限数值。 */
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ApiResponse<Void>> handleMaxUpload(MaxUploadSizeExceededException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.fail(ApiError.of("FILE_TOO_LARGE",
                "上传文件超过大小上限(单文件上限 " + multipartMaxFileMb + "MB)")));
    }

    /** 客户端已断开(页面刷新/跳转/请求取消):连接已断,响应体写不回去,只记一行无堆栈。 */
    @ExceptionHandler(AsyncRequestNotUsableException.class)
    public void handleClientDisconnected(AsyncRequestNotUsableException e) {
        log.debug("Client disconnected before response completed: {}", e.getMessage());
    }

    /**
     * 异步请求超时(如 LLM 流式转发超过 spring.mvc.async.request-timeout):返回 504。
     * 不落兜底 500:超时≠内部错误,504 引导调用方重试而非报障。
     */
    @ExceptionHandler(AsyncRequestTimeoutException.class)
    public ResponseEntity<ApiResponse<Void>> handleAsyncTimeout(AsyncRequestTimeoutException e,
                                                                HttpServletRequest request) {
        log.warn("Async request timeout: {} {}", request.getMethod(), request.getRequestURI());
        return ResponseEntity.status(HttpStatus.GATEWAY_TIMEOUT)
            .body(ApiResponse.fail(ApiError.of("ASYNC_REQUEST_TIMEOUT",
                "请求处理超过时限,请稍后重试;若反复出现请联系管理员")));
    }

    /** 兜底:返回 500。 */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleAny(Exception e) {
        log.error("Unhandled exception", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(ApiResponse.fail(ApiError.of("INTERNAL_ERROR", "服务器内部错误")));
    }

    /** 自定义 not found 业务异常。 */
    public static class NotFoundException extends RuntimeException {
        public NotFoundException(String message) {
            super(message);
        }
    }
}
