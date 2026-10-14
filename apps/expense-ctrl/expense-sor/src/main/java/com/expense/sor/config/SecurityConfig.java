package com.expense.sor.config;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtDecoders;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * 安全配置(设计文档 §4):
 * - 所有 /api/** 除 /api/health 外均需认证
 * - 认证方式一:上游认证中心签发的 JWT(从 JWKS 地址拉公钥本地验签,校验签名/iss/exp,不校验 aud)
 * - 认证方式二:X-Service-Key 服务间调用(见 ServiceKeyAuthFilter)
 */
@Configuration
@EnableWebSecurity
@EnableConfigurationProperties({AppProperties.class, SsoAuthProperties.class})
public class SecurityConfig {

    @Bean
    public JwtDecoder jwtDecoder(SsoAuthProperties sso, AppProperties props,
            @Value("${spring.security.oauth2.resourceserver.jwt.jwk-set-uri:}") String jwksUrl) {
        if (sso.isOidcMode()) {
            // OIDC 模式(casdoor/customer-oidc):issuer 经 discovery 拉 JWKS(对齐 web-console 已验证写法);
            // fromIssuerLocation 默认 RS256(Casdoor 与主流客户 IdP 均适用),issuer 校验由
            // createDefaultWithIssuer 承担(不校验 aud)
            JwtDecoder decoder = JwtDecoders.fromIssuerLocation(sso.issuer());
            if (decoder instanceof NimbusJwtDecoder nimbus) {
                nimbus.setJwtValidator(JwtValidators.createDefaultWithIssuer(sso.issuer()));
            }
            return decoder;
        }
        // D3:验签必须校验 iss+exp+sub;issuer 缺失时拒绝启动,而非静默放行任意签发方
        if (!props.hasIssuer()) {
            throw new IllegalStateException(
                "SOR_JWT_ISSUER 未配置:请设置为认证中心 issuer(如 https://<host>/auth/v1)");
        }
        if (jwksUrl == null || jwksUrl.isBlank()) {
            return token -> {
                throw new BadJwtException("JWT 验签未配置:请设置 SOR_JWKS_URL");
            };
        }
        // 默认只接受 RS256;上游认证中心(Supabase Auth)签发 ES256,不放开会全部 401。
        // 同时保留 RS256 兼容自测认证中心(tools/test-auth)
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwksUrl)
                .jwsAlgorithms(algs -> algs.add(SignatureAlgorithm.ES256))
                .build();
        List<OAuth2TokenValidator<Jwt>> validators = new ArrayList<>();
        validators.add(new JwtTimestampValidator());
        validators.add(new JwtIssuerValidator(props.jwtIssuer()));
        // 注意:按设计文档要求不校验 aud
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(validators));
        return decoder;
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http, JwtDecoder decoder,
            ServiceKeyAuthFilter serviceKeyFilter) throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            // iframe 内嵌登录(对齐 web-console):redirect_uri 回环页在同一 origin 下
            // 由父页面 onLoad 读取,默认 X-Frame-Options DENY 会拒绝其渲染
            .headers(headers -> headers.frameOptions(frame -> frame.sameOrigin()))
            .authorizeHttpRequests(a -> a
                .requestMatchers("/api/health").permitAll()
                // Web UI 静态资源与登录页客户端配置端点放行(2026-09-24);
                // /api/ui-config 仅下发 SSO 连接信息(mode/issuer/clientId 或 Supabase 公开参数),不涉及业务数据
                .requestMatchers("/", "/index.html", "/favicon.ico", "/css/**", "/js/**", "/api/ui-config").permitAll()
                // SSO 授权码流程代理端点(OIDC 模式):authorize 302/token/refresh,认证前运行
                .requestMatchers("/api/auth/**").permitAll()
                .anyRequest().authenticated())
            .addFilterBefore(serviceKeyFilter, org.springframework.security.oauth2.server.resource.web.BearerTokenAuthenticationFilter.class)
            .oauth2ResourceServer(o -> o
                .jwt(j -> j.decoder(decoder))
                .authenticationEntryPoint(unauthorizedEntryPoint())
                .accessDeniedHandler(accessDeniedHandler()));
        return http.build();
    }

    private AuthenticationEntryPoint unauthorizedEntryPoint() {
        return (request, response, ex) -> writeError(response, HttpStatus.UNAUTHORIZED.value(), 1401,
                "UNAUTHORIZED", ex instanceof AuthenticationException ? ex.getMessage() : null);
    }

    private AccessDeniedHandler accessDeniedHandler() {
        return (request, response, ex) -> writeError(response, HttpStatus.FORBIDDEN.value(), 1403,
                "FORBIDDEN", null);
    }

    /**
     * 输出统一错误信封 {"code":..., "message":..., "details":{...}}(设计文档 §7/§10)。
     */
    static void writeError(HttpServletResponse response, int httpStatus, int code, String message, String reason)
            throws IOException {
        response.setStatus(httpStatus);
        response.setContentType("application/json;charset=UTF-8");
        StringBuilder sb = new StringBuilder();
        sb.append("{\"code\":").append(code).append(",\"message\":\"").append(message).append("\"");
        if (reason != null && !reason.isBlank()) {
            sb.append(",\"details\":{\"reason\":\"")
              .append(reason.replace("\\", "\\\\").replace("\"", "'")).append("\"}");
        }
        sb.append("}");
        response.getWriter().write(sb.toString());
    }
}
