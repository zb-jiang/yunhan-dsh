package com.expense.sor.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 应用配置项,均由环境变量注入(见设计文档第 11 节)。
 * SSO 连接信息(supabaseUrl/supabaseAnonKey 与 oidc 模式参数)已移交 SsoAuthProperties,
 * 由 /api/ui-config 统一下发。userDb 系列配置(2026-09-24):
 * platform_users 表所在 PostgreSQL 库(默认 postgres 库 public schema),
 * /api/me 用 JWT sub 匹配 auth_subject 列取 display_name 作为用户显示名。
 */
@ConfigurationProperties(prefix = "app")
public record AppProperties(
        String jwtIssuer,
        String serviceKey,
        String attachmentDir,
        String userDbHost,
        String userDbPort,
        String userDbName,
        String userDbUser,
        String userDbPassword) {

    public boolean hasIssuer() {
        return jwtIssuer != null && !jwtIssuer.isBlank();
    }

    public boolean hasServiceKey() {
        return serviceKey != null && !serviceKey.isBlank();
    }
}
