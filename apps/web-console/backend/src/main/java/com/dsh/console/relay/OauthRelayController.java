package com.dsh.console.relay;

import com.dsh.console.common.ApiResponse;
import java.net.URI;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.UriComponentsBuilder;

/**
 * DSH 员工端 Pocket Access 手机端登录的 OAuth relay 中转端点。
 *
 * <p>手机端的回调地址(LAN IP/隧道域名)无法在认证中心枚举登记,redirect_uri 恒指向
 * 本控制器的固定 {@code /callback} 地址(认证中心白名单只需登记一条);认证中心 302
 * 携授权码到达时,按 state(发起时登记的包裹号)查回跳地址并 302 转交回员工端的
 * 授权码回调端点。授权码中转不构成泄密面:PKCE verifier 只在手机端 sessionStorage,
 * relay 拿到授权码也换不了 token;state 随机匹配、5 分钟 TTL、一次性消费。
 *
 * <p>认证边界:两个端点都在登录发生之前运行,走 SecurityConfig 的
 * {@code /api/auth/**} permitAll 名单(与 AuthController 同侧);登记请求经 DSH
 * 员工端 webserver 的 Node 转发(platform-user-api {@code POST /oidc/relay-register})
 * 到达,浏览器不直连本服务,无 CORS 面。
 */
@RestController
@RequestMapping("/api/auth/dsh-relay")
public class OauthRelayController {

    /** 转交回员工端时的回调路径(与 platform-user-api 的 GET /oidc/callback 对齐)。 */
    static final String DSH_CALLBACK_PATH = "/api/enterprise/auth/oidc/callback";

    /** 登记字段长度上限(前端 state 为 base64url 22 字符,宽余量防滥用)。 */
    private static final int FIELD_MAX_LENGTH = 255;

    private final OauthRelayJdbcRepository repository;

    public OauthRelayController(OauthRelayJdbcRepository repository) {
        this.repository = repository;
    }

    /**
     * 登记中转会话:state 兼作包裹号,returnOrigin 为手机端本次访问的 origin
     * (回跳目标只允许 http/https,防 javascript: 之类注入)。
     */
    @PostMapping("/register")
    public ApiResponse<Void> register(@RequestBody RelayRegisterRequest request) {
        String state = requireField(request.state(), "state");
        String returnOrigin = requireField(request.returnOrigin(), "returnOrigin");
        if (!returnOrigin.startsWith("http://") && !returnOrigin.startsWith("https://")) {
            throw new IllegalArgumentException("returnOrigin 仅支持 http/https 地址");
        }
        repository.register(state, returnOrigin);
        return ApiResponse.ok();
    }

    /**
     * 认证中心 302 的落点:按 state 查登记的回跳地址并 302 转交回员工端回调端点
     * (iframe 登录场景由父页面读地址提取授权码,与 loopback 登录同一落点)。
     */
    @GetMapping("/callback")
    public ResponseEntity<Void> callback(@RequestParam("code") String code,
                                         @RequestParam("state") String state) {
        requireField(code, "code");
        requireField(state, "state");
        String returnOrigin = repository.take(state)
            .orElseThrow(() -> new IllegalArgumentException("relay 会话不存在或已过期，请重新发起登录"));
        URI location = UriComponentsBuilder.fromHttpUrl(returnOrigin + DSH_CALLBACK_PATH)
            .queryParam("code", code)
            .queryParam("state", state)
            .encode()
            .build()
            .toUri();
        return ResponseEntity.status(HttpStatus.FOUND).location(location).build();
    }

    private String requireField(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " 缺失或格式无效");
        }
        if (value.length() > FIELD_MAX_LENGTH) {
            throw new IllegalArgumentException(name + " 超过长度上限 " + FIELD_MAX_LENGTH);
        }
        return value;
    }

    /** {@code /register} 请求体。 */
    public record RelayRegisterRequest(String state, String returnOrigin) {
    }
}
