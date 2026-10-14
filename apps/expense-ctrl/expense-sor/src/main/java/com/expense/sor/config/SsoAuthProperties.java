package com.expense.sor.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 认证中心(SSO)配置——部署级唯一 SSO 配置源。
 *
 * <p>与员工端 DSH、Web Console 读同一组 {@code SSO_*} 环境变量
 * (SSO_PROVIDER/SSO_ISSUER/SSO_CLIENT_ID/SSO_SCOPES),同一部署的全部组件接入
 * 同一个 issuer/IdP;发证方由部署决定(Supabase Auth / Casdoor / 客户 IdP,
 * 认证中心设计 D2)。本属性类服务两类消费点:
 * <ul>
 *   <li>RS 验签:{@code SecurityConfig} 在 OIDC 模式用 {@link #issuer()} 经
 *       discovery 拉 JWKS 本地验签;supabase 模式沿用 {@code AppProperties.jwtIssuer}
 *       (SOR_JWT_ISSUER)+ {@code SOR_JWKS_URL} 现状,不经过本类。</li>
 *   <li>RP 登录参数与模式判别:{@code UiConfigController} 经 {@code /api/ui-config}
 *       下发前端,{@code AuthController} 代理授权码流程。</li>
 * </ul>
 *
 * <p>与 Web Console 版本的差异:supabase 模式下 issuer/supabaseUrl 均允许为空
 * ——纯 headless 部署(无 Web UI)不配任何 Supabase 参数也能启动,本类不拦;
 * Web UI 可用性由前端读到空 supabaseUrl 时的"未配置"提示表达。
 *
 * @param provider        认证中心类型 supabase | casdoor | customer-oidc,空按 supabase
 * @param issuer          JWT iss claim,非空时必须是 http(s) URL;supabase 模式允许从 supabaseUrl 推导
 * @param clientId        本前端 RP 在认证中心注册的 client id(与员工端/Web Console 可共用同一 client,redirect_uri 各自登记)
 * @param scopes          OIDC 授权码流程 scopes,空按 {@code openid profile}
 * @param supabaseUrl     Supabase 项目 URL(supabase 模式下发前端直连 Auth;兼作 issuer 推导来源)
 * @param supabaseAnonKey Supabase anon key(supabase 模式前端直连 Auth 使用)
 */
@ConfigurationProperties(prefix = "expense.sso")
public record SsoAuthProperties(
    String provider,
    String issuer,
    String clientId,
    String scopes,
    String supabaseUrl,
    String supabaseAnonKey
) {
    private static final String PROVIDER_SUPABASE = "supabase";

    public SsoAuthProperties {
        if (provider == null || provider.isBlank()) {
            provider = PROVIDER_SUPABASE;
        }
        if (!PROVIDER_SUPABASE.equals(provider) && !"casdoor".equals(provider)
            && !"customer-oidc".equals(provider)) {
            throw new IllegalStateException(
                "expense.sso.provider 非法:必须是 supabase | casdoor | customer-oidc,当前值: " + provider);
        }
        boolean supabaseMode = PROVIDER_SUPABASE.equals(provider);
        if (issuer == null) {
            issuer = "";
        }
        if (!supabaseMode && issuer.isBlank()) {
            throw new IllegalStateException(
                "expense.sso.issuer 未配置:provider 为 " + provider + " 时必须设置 SSO_ISSUER(认证中心 issuer,"
                    + "如 https://<casdoor-host>)");
        }
        if (issuer.isBlank() && supabaseUrl != null && !supabaseUrl.isBlank()) {
            // Supabase 约定:issuer = <SUPABASE_URL>/auth/v1(对齐员工端 resolveSsoSettings 推导)
            issuer = supabaseUrl.replaceAll("/+$", "") + "/auth/v1";
        }
        if (!issuer.isBlank() && !issuer.startsWith("http://") && !issuer.startsWith("https://")) {
            throw new IllegalStateException(
                "expense.sso.issuer 必须是 http(s) URL,当前值: " + issuer);
        }
        if (!supabaseMode && (clientId == null || clientId.isBlank())) {
            throw new IllegalStateException(
                "expense.sso.client-id 未配置:provider 为 " + provider
                    + " 时必须设置 SSO_CLIENT_ID(本前端 RP 在认证中心注册的 client id)");
        }
        if (scopes == null || scopes.isBlank()) {
            scopes = "openid profile";
        }
        if (supabaseUrl == null) {
            supabaseUrl = "";
        }
        if (supabaseAnonKey == null) {
            supabaseAnonKey = "";
        }
    }

    /** 是否 OIDC 授权码模式(casdoor/customer-oidc);supabase 模式前端直连 Supabase Auth。 */
    public boolean isOidcMode() {
        return !PROVIDER_SUPABASE.equals(provider);
    }
}
