package com.dsh.console.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 认证中心(SSO)配置——部署级唯一 SSO 配置源。
 *
 * <p>同一部署的员工端 DSH 与 Web Console 读同一组 {@code SSO_*} 环境变量
 * (SSO_PROVIDER/SSO_ISSUER/SSO_CLIENT_ID/SSO_SCOPES),全部组件接入同一个
 * issuer/IdP;发证方由部署决定(Supabase Auth / Casdoor / 客户 IdP,
 * 认证中心设计 D2)。本属性类同时服务两类消费点:
 * <ul>
 *   <li>RS 验签:{@code SecurityConfig} 用 {@link #issuer()} 从 OpenID 发现
 *       端点拉 JWKS 本地验签(经 {@code JwtDecoders.fromIssuerLocation},
 *       JWKS 地址由 discovery 文档给出,Casdoor 无 {@code .json} 后缀也能用)。</li>
 *   <li>RP 登录参数:{@code AuthController} 经 {@code /api/auth/config} 向
 *       前端下发 {@code /api/auth/oidc/*} 端点所需的 clientId/scopes。</li>
 * </ul>
 *
 * <p>绑定 yaml 中 {@code dsh.sso.*} 字段;兼容旧部署的 {@code DSH_JWT_ISSUER}
 * 由 yaml 默认链 {@code ${SSO_ISSUER:${DSH_JWT_ISSUER:...}}} 降级承接。
 * 绑定期 fails loud:issuer 缺失/非法、OIDC 模式缺 clientId 均拒绝启动。
 * 校验与推导规则对齐员工端共享模型 {@code resolveSsoSettings}(platform-user 包)。</p>
 *
 * @param provider         认证中心类型 supabase | casdoor | customer-oidc,空按 supabase
 * @param issuer           JWT iss claim,必须是非空 http(s) URL;supabase 模式允许从 supabaseUrl 推导
 * @param clientId         Web Console 前端 RP 在认证中心注册的 client id(与员工端可共用同一 client,redirect_uri 各自登记)
 * @param scopes           OIDC 授权码流程 scopes,空按 {@code openid profile}
 * @param supabaseUrl      Supabase 项目 URL(supabase 模式下发前端直连 Auth;兼作 issuer 推导来源)
 * @param supabaseAnonKey  Supabase anon key(supabase 模式前端直连 Auth 使用)
 */
@ConfigurationProperties(prefix = "dsh.sso")
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
                "dsh.sso.provider 非法:必须是 supabase | casdoor | customer-oidc,当前值: " + provider);
        }
        boolean supabaseMode = PROVIDER_SUPABASE.equals(provider);
        if (issuer == null) {
            issuer = "";
        }
        if (!supabaseMode && issuer.isBlank()) {
            throw new IllegalStateException(
                "dsh.sso.issuer 未配置:provider 为 " + provider + " 时必须设置 SSO_ISSUER(认证中心 issuer,"
                    + "如 https://<casdoor-host>)");
        }
        if (issuer.isBlank() && supabaseUrl != null && !supabaseUrl.isBlank()) {
            // Supabase 约定:issuer = <SUPABASE_URL>/auth/v1(对齐员工端 resolveSsoSettings 推导)
            issuer = supabaseUrl.replaceAll("/+$", "") + "/auth/v1";
        }
        if (issuer.isBlank()) {
            throw new IllegalStateException(
                "dsh.sso.issuer 未配置:请设置 SSO_ISSUER(认证中心 issuer,如 https://<host>/auth/v1),"
                    + "或设置 SUPABASE_URL 以推导缺省值");
        }
        if (!issuer.startsWith("http://") && !issuer.startsWith("https://")) {
            throw new IllegalStateException(
                "dsh.sso.issuer 必须是 http(s) URL,当前值: " + issuer);
        }
        if (!supabaseMode && (clientId == null || clientId.isBlank())) {
            throw new IllegalStateException(
                "dsh.sso.client-id 未配置:provider 为 " + provider
                    + " 时必须设置 SSO_CLIENT_ID(Web Console 前端 RP 在认证中心注册的 client id)");
        }
        if (scopes == null || scopes.isBlank()) {
            scopes = "openid profile";
        }
    }

    /** 是否 OIDC 授权码模式(casdoor/customer-oidc);supabase 模式前端直连 Supabase Auth。 */
    public boolean isOidcMode() {
        return !PROVIDER_SUPABASE.equals(provider);
    }
}
