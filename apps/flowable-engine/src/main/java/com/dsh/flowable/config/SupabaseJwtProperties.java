package com.dsh.flowable.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 认证中心 JWT 验证配置。
 *
 * <p>绑定 yaml 中 {@code dsh.supabase.*} 字段。
 * 使用 {@link org.springframework.security.oauth2.jwt.NimbusJwtDecoder#withIssuerLocation}
 * 从认证中心 OpenID 发现端点自动拉取 JWKS 验证 ES256/RS256 签名,
 * 不再本地配置 secret。
 * 发证方由部署决定(Supabase Auth / Casdoor / 客户 IdP,认证中心设计 D2):
 * issuer 经 {@code DSH_JWT_ISSUER} 直接指定,未设置时按 Supabase 约定
 * 从 {@code SUPABASE_URL} 推导 {@code <url>/auth/v1}。</p>
 *
 * @param jwtIssuer JWT iss claim,必须是非空 http(s) URL
 */
@ConfigurationProperties(prefix = "dsh.supabase")
public record SupabaseJwtProperties(
    String jwtIssuer
) {
    public SupabaseJwtProperties {
        if (jwtIssuer == null || jwtIssuer.isBlank()) {
            throw new IllegalStateException(
                "dsh.supabase.jwt-issuer 未配置:请设置 DSH_JWT_ISSUER(认证中心 issuer,"
                    + "如 https://<host>/auth/v1),或设置 SUPABASE_URL 以推导缺省值");
        }
        if (!jwtIssuer.startsWith("http://") && !jwtIssuer.startsWith("https://")) {
            throw new IllegalStateException(
                "dsh.supabase.jwt-issuer 必须是 http(s) URL,当前值: " + jwtIssuer);
        }
    }
}
