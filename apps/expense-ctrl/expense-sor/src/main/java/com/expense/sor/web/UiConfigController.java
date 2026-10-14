package com.expense.sor.web;

import com.expense.sor.config.SsoAuthProperties;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Web UI 客户端配置端点(匿名可访问,已在 SecurityConfig 放行):
 * GET /api/ui-config 按 SSO 模式统一下传前端所需连接信息(单一下传通道,expense-sor 无 /api/auth/config):
 * - supabase 模式: {mode:"supabase", supabaseUrl, supabaseAnonKey} —— anon key 是设计上公开的
 *   浏览器端客户端密钥(行级安全由 Supabase 负责),不泄露任何服务端密钥(SOR_SERVICE_KEY 绝不出现在此);
 * - oidc 模式: {mode:"oidc", issuer, clientId, scopes} —— 前端仅用其显示登录入口,
 *   授权流程经后端 /api/auth/oidc/* 代理,前端不直连认证中心。
 */
@RestController
public class UiConfigController {

    private final SsoAuthProperties sso;

    public UiConfigController(SsoAuthProperties sso) {
        this.sso = sso;
    }

    @GetMapping("/api/ui-config")
    public Map<String, Object> uiConfig() {
        Map<String, Object> body = new LinkedHashMap<>();
        if (sso.isOidcMode()) {
            body.put("mode", "oidc");
            body.put("issuer", sso.issuer());
            body.put("clientId", sso.clientId());
            body.put("scopes", sso.scopes());
        } else {
            body.put("mode", "supabase");
            body.put("supabaseUrl", sso.supabaseUrl() == null ? "" : sso.supabaseUrl());
            body.put("supabaseAnonKey", sso.supabaseAnonKey() == null ? "" : sso.supabaseAnonKey());
        }
        return body;
    }
}
