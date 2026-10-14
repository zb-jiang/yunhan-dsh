package com.expense.sor.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/**
 * SSO 配置绑定校验与推导规则:provider 三选一 fails loud、非 supabase 模式
 * issuer/clientId 必填、supabase 模式按 SUPABASE_URL 推导 issuer、scopes 缺省。
 *
 * <p>与 Web Console 版本的差异:supabase 模式下 issuer/supabaseUrl 全空不抛异常
 * ——expense-sor 存在纯 headless 部署(不配任何 Supabase 参数),不拦;
 * RS 验签 issuer 由 SOR_JWT_ISSUER(AppProperties.jwtIssuer)承接。
 */
class SsoAuthPropertiesTest {

    @Test
    void defaultsToSupabaseAndDerivesIssuerFromSupabaseUrl() {
        SsoAuthProperties sso = new SsoAuthProperties(null, null, null, null,
            "https://demo.supabase.co/", "anon-key");

        assertThat(sso.provider()).isEqualTo("supabase");
        assertThat(sso.issuer()).isEqualTo("https://demo.supabase.co/auth/v1");
        assertThat(sso.scopes()).isEqualTo("openid profile");
        assertThat(sso.isOidcMode()).isFalse();
    }

    @Test
    void explicitIssuerKeptInSupabaseMode() {
        SsoAuthProperties sso = new SsoAuthProperties("supabase",
            "https://custom.example.com/auth/v1", null, null,
            "https://demo.supabase.co", "anon-key");

        assertThat(sso.issuer()).isEqualTo("https://custom.example.com/auth/v1");
    }

    @Test
    void casdoorModeRequiresIssuer() {
        assertThatThrownBy(() -> new SsoAuthProperties("casdoor", "", "client", null, "", ""))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("SSO_ISSUER");
    }

    @Test
    void casdoorModeRequiresClientId() {
        assertThatThrownBy(() -> new SsoAuthProperties("casdoor",
            "https://casdoor.example.com", "", null, "", ""))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("SSO_CLIENT_ID");
    }

    @Test
    void rejectsUnknownProvider() {
        assertThatThrownBy(() -> new SsoAuthProperties("auth0", null, null, null, null, null))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("supabase | casdoor | customer-oidc");
    }

    @Test
    void rejectsNonHttpIssuer() {
        assertThatThrownBy(() -> new SsoAuthProperties("casdoor",
            "casdoor.example.com", "client", null, "", ""))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("http(s) URL");
    }

    @Test
    void supabaseWithoutAnyUrlAllowedForHeadless() {
        // 与 Web Console fails-loud 不同:expense-sor 纯 headless 部署不配任何
        // Supabase 参数也须能启动,issuer 留空由 SOR_JWT_ISSUER 承接 RS 验签
        assertThatCode(() -> new SsoAuthProperties("supabase", null, null, null, "", ""))
            .doesNotThrowAnyException();

        SsoAuthProperties sso = new SsoAuthProperties("supabase", null, null, null, "", "");
        assertThat(sso.issuer()).isEmpty();
        assertThat(sso.isOidcMode()).isFalse();
    }

    @Test
    void customerOidcModeIsOidc() {
        SsoAuthProperties sso = new SsoAuthProperties("customer-oidc",
            "https://idp.example.com", "client", "openid profile email", "", "");

        assertThat(sso.isOidcMode()).isTrue();
        assertThat(sso.scopes()).isEqualTo("openid profile email");
    }
}
