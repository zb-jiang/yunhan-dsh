package com.expense.sor.web;

import com.expense.sor.auth.OidcClient;
import com.expense.sor.auth.OidcClient.OidcEndpoints;
import com.expense.sor.auth.OidcClient.OidcTokenResult;
import com.expense.sor.config.SsoAuthProperties;
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
 * 认证端点:代理 OIDC 授权码流程(OIDC 模式)。
 *
 * <p>登录页与回调处理在认证前运行,全部端点 permitAll(见 SecurityConfig)。
 * 浏览器不做任何对认证中心的直接 fetch(客户 IdP 的 CORS 无保证):授权跳转
 * 经 {@code /oidc/authorize} 302 整页导航,token/refresh grant 由
 * {@link OidcClient} 在服务端执行。SSO 参数来自部署级环境变量
 * ({@link SsoAuthProperties}),本控制器只是下传通道,不是第二套配置。
 *
 * <p>RP 连接信息(clientId/scopes)由 {@link UiConfigController} 的
 * {@code /api/ui-config} 统一下传,本控制器不再单设 config 端点。端点与员工端
 * platform-user-api、Web Console 的 {@code /api/auth/oidc/*} 对称;各 RP 可共用
 * 同一 client 注册,redirect_uri 各自登记。响应沿用全局信封
 * ({@code EnvelopeAdvice} 包裹为 {@code {"code":0,"data":...}});
 * {@code /oidc/authorize} 是 302 导航,标注 {@code @RawResponse} 豁免信封。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final SsoAuthProperties sso;
    private final OidcClient oidcClient;

    public AuthController(SsoAuthProperties sso, OidcClient oidcClient) {
        this.sso = sso;
        this.oidcClient = oidcClient;
    }

    /**
     * 拼好 RP 参数后 302 跳认证中心授权页。
     *
     * <p>authorization_endpoint 因 provider 而异,经 discovery 解析;整页导航
     * 不受 CORS 限制,浏览器不能直接 fetch discovery。
     *
     * @param codeChallenge PKCE S256 挑战(前端生成)
     * @param state         CSRF 防护随机串(前端生成并比对)
     * @param redirectUri   认证中心登记的本前端回调地址(SPA 根路径)
     * @param prompt        值为 login 时强制认证中心重新认证(换账号场景)
     * @param popup         值为 iframe 时追加 popup=1&popup_type=iframe:认证中心登录页被 iframe
     *                      内嵌,登录成功不 302 而是向父页面 postMessage code/state
     *                      (Casdoor 原生行为,登录页不跳离)
     */
    @RawResponse
    @GetMapping("/oidc/authorize")
    public ResponseEntity<Void> authorize(@RequestParam("code_challenge") String codeChallenge,
                                          @RequestParam("state") String state,
                                          @RequestParam("redirect_uri") String redirectUri,
                                          @RequestParam(value = "prompt", required = false) String prompt,
                                          @RequestParam(value = "popup", required = false) String popup) {
        requireOidcMode("oidc/authorize");
        if (isBlank(codeChallenge) || isBlank(state) || isBlank(redirectUri)) {
            throw new IllegalArgumentException("code_challenge、state、redirect_uri 均为必填");
        }
        OidcEndpoints endpoints = oidcClient.resolveEndpoints(sso.issuer());
        UriComponentsBuilder target = UriComponentsBuilder.fromHttpUrl(endpoints.authorizationEndpoint())
            .queryParam("client_id", sso.clientId())
            .queryParam("response_type", "code")
            .queryParam("redirect_uri", redirectUri)
            .queryParam("scope", sso.scopes())
            .queryParam("state", state)
            .queryParam("code_challenge", codeChallenge)
            .queryParam("code_challenge_method", "S256");
        if ("login".equals(prompt)) {
            target.queryParam("prompt", "login");
        }
        if ("iframe".equals(popup)) {
            target.queryParam("popup", "1").queryParam("popup_type", "iframe");
        }
        return ResponseEntity.status(HttpStatus.FOUND)
            .location(java.net.URI.create(target.build().encode().toString()))
            .build();
    }

    /**
     * 授权码 + PKCE 换 token:Bearer = id_token,现有 JWKS 验签点直接验。
     */
    @PostMapping("/oidc/token")
    public OidcTokenResult token(@RequestBody OidcTokenRequest body) {
        requireOidcMode("oidc/token");
        String code = requireField(body.code(), "code");
        String codeVerifier = requireField(body.codeVerifier(), "codeVerifier");
        String redirectUri = requireField(body.redirectUri(), "redirectUri");
        OidcEndpoints endpoints = oidcClient.resolveEndpoints(sso.issuer());
        return oidcClient.runGrant(endpoints.tokenEndpoint(),
            oidcClient.authorizationCodeForm(code, codeVerifier, redirectUri, sso.clientId()));
    }

    /**
     * refresh_token grant 续期:token 生命周期归认证中心,本端点只透传 grant 不自研续签。
     */
    @PostMapping("/oidc/refresh")
    public OidcTokenResult refresh(@RequestBody OidcRefreshRequest body) {
        requireOidcMode("oidc/refresh");
        String refreshToken = requireField(body.refreshToken(), "refreshToken");
        OidcEndpoints endpoints = oidcClient.resolveEndpoints(sso.issuer());
        return oidcClient.runGrant(endpoints.tokenEndpoint(),
            oidcClient.refreshTokenForm(refreshToken, sso.clientId()));
    }

    private void requireOidcMode(String endpoint) {
        if (!sso.isOidcMode()) {
            throw new IllegalArgumentException(
                endpoint + " 仅在 casdoor/customer-oidc 模式可用(SSO_PROVIDER=" + sso.provider() + ")");
        }
    }

    private String requireField(String value, String name) {
        if (isBlank(value)) {
            throw new IllegalArgumentException(name + " 缺失或格式无效");
        }
        return value;
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    /** {@code /api/auth/oidc/token} 请求体。 */
    public record OidcTokenRequest(String code, String codeVerifier, String redirectUri) {
    }

    /** {@code /api/auth/oidc/refresh} 请求体。 */
    public record OidcRefreshRequest(String refreshToken) {
    }
}
