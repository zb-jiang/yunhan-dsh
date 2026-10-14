package com.dsh.console.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;

import com.dsh.console.auth.OidcClient.OidcEndpoints;
import com.dsh.console.auth.OidcClient.OidcTokenResult;
import com.dsh.console.common.ApiResponse;
import com.dsh.console.config.SsoAuthProperties;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.MultiValueMap;

/**
 * AuthController 四端点行为测试:config 按 provider 分支只下发对应字段;
 * authorize/token/refresh 在 supabase 模式拒绝(不触上游)、缺参拒绝、
 * OIDC 模式经 discovery 端点走授权码/刷新 grant(表单内容直接断言,
 * 覆盖 PKCE code_verifier 与 client_id 绑定)。
 */
class AuthControllerTest {

    private static final String ISSUER = "https://idp.example.com";
    private static final String CLIENT_ID = "dsh-web-client";
    private static final String TOKEN_ENDPOINT = "https://idp.example.com/login/oauth/access_token";
    private static final String REDIRECT_URI = "http://localhost:8080/";

    private OidcClient oidcClient;
    private SsoAuthProperties supabase;
    private SsoAuthProperties casdoor;
    private AuthController controller;

    @BeforeEach
    void setUp() {
        // spy 真实 OidcClient:表单构造(authorizationCodeForm/refreshTokenForm)走真实实现,
        // 仅 stub 网络侧 resolveEndpoints/runGrant
        oidcClient = spy(new OidcClient());
        supabase = new SsoAuthProperties("supabase", "", "", "", "https://demo.supabase.co", "anon-key");
        casdoor = new SsoAuthProperties("casdoor", ISSUER, CLIENT_ID, "", "", "");
        controller = new AuthController(casdoor, oidcClient);
    }

    @Test
    void configSupabaseBranchReturnsSupabaseFields() {
        AuthController.AuthConfigResponse config =
            new AuthController(supabase, oidcClient).config().data();

        assertThat(config.mode()).isEqualTo("supabase");
        assertThat(config.url()).isEqualTo("https://demo.supabase.co");
        assertThat(config.anonKey()).isEqualTo("anon-key");
        assertThat(config.issuer()).isNull();
        assertThat(config.clientId()).isNull();
        assertThat(config.scopes()).isNull();
    }

    @Test
    void configOidcBranchReturnsRpFields() {
        AuthController.AuthConfigResponse config = controller.config().data();

        assertThat(config.mode()).isEqualTo("oidc");
        assertThat(config.issuer()).isEqualTo(ISSUER);
        assertThat(config.clientId()).isEqualTo(CLIENT_ID);
        assertThat(config.scopes()).isEqualTo("openid profile");
        assertThat(config.url()).isNull();
        assertThat(config.anonKey()).isNull();
    }

    @Test
    void authorizeRejectsSupabaseMode() {
        assertThatThrownBy(() -> new AuthController(supabase, oidcClient)
            .authorize("challenge", "st-1", REDIRECT_URI, null, null))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("oidc/authorize")
            .hasMessageContaining("SSO_PROVIDER=supabase");
        verify(oidcClient, never()).resolveEndpoints(anyString());
    }

    @Test
    void authorizeRejectsMissingParams() {
        assertThatThrownBy(() -> controller.authorize("challenge", " ", REDIRECT_URI, null, null))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("均为必填");
        verify(oidcClient, never()).resolveEndpoints(anyString());
    }

    @Test
    void authorizeRedirectsToAuthorizationEndpointWithRpParams() {
        stubEndpoints();

        ResponseEntity<Void> response = controller.authorize(
            "challenge-abc", "st-123", REDIRECT_URI, null, null);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.FOUND);
        String location = response.getHeaders().getLocation().toString();
        assertThat(location).startsWith("https://idp.example.com/login/oauth/authorize");
        assertThat(location).contains("client_id=" + CLIENT_ID);
        assertThat(location).contains("response_type=code");
        assertThat(location).contains("redirect_uri=" + REDIRECT_URI);
        assertThat(location).contains("scope=openid%20profile");
        assertThat(location).contains("state=st-123");
        assertThat(location).contains("code_challenge=challenge-abc");
        assertThat(location).contains("code_challenge_method=S256");
        assertThat(location).doesNotContain("prompt=");
        assertThat(location).doesNotContain("popup=");
    }

    @Test
    void authorizeForwardsPromptLogin() {
        stubEndpoints();

        ResponseEntity<Void> response = controller.authorize(
            "challenge-abc", "st-123", REDIRECT_URI, "login", null);

        assertThat(response.getHeaders().getLocation().toString()).contains("prompt=login");
    }

    @Test
    void authorizeForwardsIframePopup() {
        stubEndpoints();

        ResponseEntity<Void> response = controller.authorize(
            "challenge-abc", "st-123", REDIRECT_URI, null, "iframe");

        String location = response.getHeaders().getLocation().toString();
        assertThat(location).contains("popup=1");
        assertThat(location).contains("popup_type=iframe");
    }

    @Test
    void tokenRejectsSupabaseMode() {
        assertThatThrownBy(() -> new AuthController(supabase, oidcClient)
            .token(new AuthController.OidcTokenRequest("c", "v", "r")))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("oidc/token")
            .hasMessageContaining("SSO_PROVIDER=supabase");
    }

    @Test
    void tokenRejectsMissingFields() {
        assertThatThrownBy(() -> controller
            .token(new AuthController.OidcTokenRequest(null, "verifier", REDIRECT_URI)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("code");
        assertThatThrownBy(() -> controller
            .token(new AuthController.OidcTokenRequest("code", "", REDIRECT_URI)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("codeVerifier");
    }

    @Test
    void tokenGrantsWithAuthorizationCodeForm() {
        stubEndpoints();
        List<MultiValueMap<String, String>> forms = captureGrantForms();

        ApiResponse<OidcTokenResult> response = controller.token(
            new AuthController.OidcTokenRequest("auth-code", "verifier-xyz", REDIRECT_URI));

        assertThat(response.success()).isTrue();
        assertThat(response.data().token()).isEqualTo("id-token");
        assertThat(response.data().refreshToken()).isEqualTo("refresh-token");
        assertThat(response.data().expiresIn()).isEqualTo(3600L);
        verify(oidcClient).runGrant(eq(TOKEN_ENDPOINT), any());
        MultiValueMap<String, String> form = forms.get(0);
        assertThat(form.getFirst("grant_type")).isEqualTo("authorization_code");
        assertThat(form.getFirst("code")).isEqualTo("auth-code");
        assertThat(form.getFirst("code_verifier")).isEqualTo("verifier-xyz");
        assertThat(form.getFirst("redirect_uri")).isEqualTo(REDIRECT_URI);
        assertThat(form.getFirst("client_id")).isEqualTo(CLIENT_ID);
    }

    @Test
    void refreshGrantsWithRefreshTokenForm() {
        stubEndpoints();
        List<MultiValueMap<String, String>> forms = captureGrantForms();

        ApiResponse<OidcTokenResult> response = controller.refresh(
            new AuthController.OidcRefreshRequest("rt-123"));

        assertThat(response.success()).isTrue();
        assertThat(response.data().token()).isEqualTo("id-token");
        verify(oidcClient).runGrant(eq(TOKEN_ENDPOINT), any());
        MultiValueMap<String, String> form = forms.get(0);
        assertThat(form.getFirst("grant_type")).isEqualTo("refresh_token");
        assertThat(form.getFirst("refresh_token")).isEqualTo("rt-123");
        assertThat(form.getFirst("client_id")).isEqualTo(CLIENT_ID);
    }

    @Test
    void refreshRejectsMissingToken() {
        assertThatThrownBy(() -> controller.refresh(new AuthController.OidcRefreshRequest("")))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("refreshToken");
        verify(oidcClient, never()).resolveEndpoints(anyString());
    }

    private void stubEndpoints() {
        doReturn(new OidcEndpoints("https://idp.example.com/login/oauth/authorize", TOKEN_ENDPOINT))
            .when(oidcClient).resolveEndpoints(ISSUER);
    }

    private List<MultiValueMap<String, String>> captureGrantForms() {
        List<MultiValueMap<String, String>> forms = new ArrayList<>();
        doAnswer(invocation -> {
            forms.add(invocation.getArgument(1));
            return new OidcTokenResult("id-token", "refresh-token", 3600);
        }).when(oidcClient).runGrant(anyString(), any());
        return forms;
    }
}
