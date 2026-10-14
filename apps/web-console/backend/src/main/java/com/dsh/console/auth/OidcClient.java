package com.dsh.console.auth;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.http.converter.StringHttpMessageConverter;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;

/**
 * OIDC 协议客户端:discovery 解析与 token 交换,替浏览器直连认证中心。
 *
 * <p>授权码流程中浏览器只做整页导航(302 跳授权页、回 redirect_uri),不做
 * fetch——客户 IdP 的 CORS 无保证。discovery 与 grant 由本客户端在服务端执行,
 * 与员工端 platform-user-api 的同名实现对称。
 *
 * <p>discovery 结果按 issuer 缓存(端点地址部署期内稳定);grant 不缓存,每次
 * 透传。所有上游失败抛 {@link OidcUpstreamException}(502)。
 */
@Component
public class OidcClient {

    /** 上游调用超时:认证中心应秒级可达,5s 覆盖内网与公网常见延迟(对齐员工端)。 */
    private static final Duration UPSTREAM_TIMEOUT = Duration.ofSeconds(5);

    private final RestClient restClient;
    private final ObjectMapper objectMapper = new ObjectMapper();

    /** issuer → 发现文档解析结果;volatile 配置改 issuer 换 key,天然隔离。 */
    private final Map<String, OidcEndpoints> discoveryCache = new ConcurrentHashMap<>();

    public OidcClient() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) UPSTREAM_TIMEOUT.toMillis());
        factory.setReadTimeout((int) UPSTREAM_TIMEOUT.toMillis());
        this.restClient = RestClient.builder()
            .requestFactory(factory)
            .messageConverters(converters -> {
                converters.removeIf(c -> c instanceof StringHttpMessageConverter);
                converters.add(0, new StringHttpMessageConverter(StandardCharsets.UTF_8));
            })
            .build();
    }

    /** 发现文档解析出的端点(逐 provider 不同,如 Casdoor /login/oauth/authorize)。 */
    public record OidcEndpoints(String authorizationEndpoint, String tokenEndpoint) {
    }

    /**
     * token 端点成功响应(按消费面裁剪):Bearer 用 id_token
     * (access_token 在 Casdoor 默认 HS256 HMAC,过不了 JWKS 验签)。
     *
     * @param token        id_token
     * @param refreshToken 续期用 refresh_token,provider 未发时空串
     * @param expiresIn    过期秒数,provider 未返回时 0(前端不做本地倒计时)
     */
    public record OidcTokenResult(String token, String refreshToken, long expiresIn) {
    }

    /**
     * 经 OIDC discovery 解析认证中心的授权/令牌端点(一次发现、一并缓存)。
     *
     * <p>标准 OIDC 发现文档是 supabase 之外各 provider 的公共约定,硬编码端点
     * 路径会绑死单一 provider。失败不缓存,下次调用重试。
     *
     * @throws OidcUpstreamException 发现文档不可达、非 JSON 或缺端点字段
     */
    public OidcEndpoints resolveEndpoints(String issuer) {
        return discoveryCache.computeIfAbsent(issuer, key -> discover(key));
    }

    /**
     * 执行一次授权码/刷新 grant:POST token endpoint(form-urlencoded)并解析响应。
     *
     * @throws OidcUpstreamException 上游非 2xx、响应非 JSON 或缺 id_token
     *                               (scopes 必须含 openid 才会签发 id_token)
     */
    public OidcTokenResult runGrant(String tokenEndpoint, MultiValueMap<String, String> form) {
        String text;
        try {
            text = restClient.post()
                .uri(tokenEndpoint)
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .body(form)
                .retrieve()
                .body(String.class);
        } catch (RuntimeException e) {
            throw new OidcUpstreamException("token endpoint 调用失败: " + tokenEndpoint, e);
        }
        return parseGrantResponse(tokenEndpoint, text);
    }

    /** 构造 authorization_code grant 的表单(code+PKCE)。 */
    public MultiValueMap<String, String> authorizationCodeForm(String code, String codeVerifier,
                                                              String redirectUri, String clientId) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "authorization_code");
        form.add("code", code);
        form.add("code_verifier", codeVerifier);
        form.add("redirect_uri", redirectUri);
        form.add("client_id", clientId);
        return form;
    }

    /** 构造 refresh_token grant 的表单。 */
    public MultiValueMap<String, String> refreshTokenForm(String refreshToken, String clientId) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "refresh_token");
        form.add("refresh_token", refreshToken);
        form.add("client_id", clientId);
        return form;
    }

    private OidcEndpoints discover(String issuer) {
        String discoveryUrl = issuer.replaceAll("/+$", "") + "/.well-known/openid-configuration";
        JsonNode document;
        try {
            document = restClient.get()
                .uri(discoveryUrl)
                .accept(MediaType.APPLICATION_JSON)
                .retrieve()
                .body(JsonNode.class);
        } catch (RuntimeException e) {
            throw new OidcUpstreamException("OIDC discovery 不可达: " + discoveryUrl, e);
        }
        if (document == null) {
            throw new OidcUpstreamException("OIDC discovery 响应为空: " + discoveryUrl);
        }
        String authorizationEndpoint = textField(document, "authorization_endpoint", issuer);
        String tokenEndpoint = textField(document, "token_endpoint", issuer);
        return new OidcEndpoints(authorizationEndpoint, tokenEndpoint);
    }

    private String textField(JsonNode document, String field, String issuer) {
        JsonNode value = document.path(field);
        if (!value.isTextual() || value.asText().isBlank()) {
            throw new OidcUpstreamException(
                "OIDC discovery 文档缺 " + field + " 字段: issuer=" + issuer);
        }
        return value.asText();
    }

    private OidcTokenResult parseGrantResponse(String tokenEndpoint, String text) {
        JsonNode parsed;
        try {
            parsed = objectMapper.readTree(text);
        } catch (JsonProcessingException e) {
            throw new OidcUpstreamException(
                "token endpoint 响应非 JSON: " + snippet(text), e);
        }
        JsonNode idToken = parsed.path("id_token");
        if (!idToken.isTextual() || idToken.asText().isBlank()) {
            throw new OidcUpstreamException(
                "token endpoint 响应缺 id_token(SSO_SCOPES 必须含 openid): " + tokenEndpoint);
        }
        JsonNode refreshToken = parsed.path("refresh_token");
        JsonNode expiresIn = parsed.path("expires_in");
        return new OidcTokenResult(
            idToken.asText(),
            refreshToken.isTextual() ? refreshToken.asText() : "",
            expiresIn.canConvertToLong() ? expiresIn.asLong() : 0);
    }

    private String snippet(String text) {
        return text == null ? "" : text.substring(0, Math.min(text.length(), 200));
    }
}
