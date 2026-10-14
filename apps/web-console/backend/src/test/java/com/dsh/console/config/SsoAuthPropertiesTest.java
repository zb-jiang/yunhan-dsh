package com.dsh.console.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/**
 * SSO 配置绑定校验与推导规则:provider 三选一 fails loud、非 supabase 模式
 * issuer/clientId 必填、supabase 模式按 SUPABASE_URL 推导 issuer、scopes 缺省。
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
    void supabaseWithoutAnyUrlFailsLoud() {
        assertThatThrownBy(() -> new SsoAuthProperties("supabase", null, null, null, "", ""))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("SUPABASE_URL");
    }

    @Test
    void customerOidcModeIsOidc() {
        SsoAuthProperties sso = new SsoAuthProperties("customer-oidc",
            "https://idp.example.com", "client", "openid profile email", "", "");

        assertThat(sso.isOidcMode()).isTrue();
        assertThat(sso.scopes()).isEqualTo("openid profile email");
    }
}
