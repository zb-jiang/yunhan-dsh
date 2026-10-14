package com.dsh.console.config;

import com.dsh.console.security.JwtAuthConverter;
import com.dsh.console.security.ServiceKeyAuthFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtDecoders;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Spring Security 配置:认证中心 JWT 本地验证。
 *
 * <p>认证模型为"认证直连认证中心"(认证中心设计 D2:云汉只做 OIDC RP/RS,
 * 发证方可为 Supabase Auth / Casdoor / 客户 IdP,issuer 由部署配置):
 * <ul>
 *   <li>员工端 / Web Console 前端直连认证中心完成登录,拿 JWT。</li>
 *   <li>调用本服务 API 时带 {@code Authorization: Bearer <jwt>},
 *       本服务按配置的 issuer 从 OpenID 发现端点拉 JWKS 在本地验证。</li>
 *   <li>JWT 验证通过后,通过 {@link JwtAuthConverter} 从 {@code sub} claim
 *       查 {@code public.platform_users} 取治理状态与平台角色,
 *       构造 {@link com.dsh.console.security.AuthContext}。</li>
 * </ul>
 *
 * <p>{@link EnableMethodSecurity} 启用 {@code @PreAuthorize} 方法级 RBAC,
 * 用于区分 {@code platform_admin} 与 {@code app_admin} 权限。
 *
 * <p>V1 仅校验 iss + exp + sub;不校验 aud,允许 authenticated token 调用。
 */
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    private final SsoAuthProperties ssoProperties;
    private final JwtAuthConverter jwtAuthConverter;
    private final ServiceKeyProperties serviceKeyProperties;

    public SecurityConfig(SsoAuthProperties ssoProperties, JwtAuthConverter jwtAuthConverter,
                          ServiceKeyProperties serviceKeyProperties) {
        this.ssoProperties = ssoProperties;
        this.jwtAuthConverter = jwtAuthConverter;
        this.serviceKeyProperties = serviceKeyProperties;
    }

    /**
     * 按配置 issuer 构造 NimbusJwtDecoder,支持 ES256/RS256 等非对称算法。
     *
     * <p>通过 issuer 的 {@code /.well-known/openid-configuration} 发现端点
     * 动态获取 JWKS 公钥验证(Supabase Auth 默认 ES256,Casdoor 默认 RS256)。
     * issuer 参数校验在 {@link SsoAuthProperties} 绑定期 fails loud。</p>
     */
    @Bean
    public JwtDecoder jwtDecoder() {
        JwtDecoder decoder = JwtDecoders.fromIssuerLocation(ssoProperties.issuer());
        OAuth2TokenValidator<Jwt> withIssuer = JwtValidators.createDefaultWithIssuer(ssoProperties.issuer());
        if (decoder instanceof org.springframework.security.oauth2.jwt.NimbusJwtDecoder nimbus) {
            nimbus.setJwtValidator(withIssuer);
        }
        return decoder;
    }

    /**
     * 安全过滤链:无状态、CSRF 关闭、所有 API 端点要求认证。
     *
     * <p>{@code /api/**} 是 Web Console 自定义 REST 端点。
     * 静态资源({@code /**} 下的 index.html、assets)由 Spring Boot 默认 ResourceHandler 处理,
     * 不要求认证(前端登录页可访问)。
     */
    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
        .csrf(csrf -> csrf.disable())
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        // 登录页在 Modal iframe 内嵌认证中心，扫码等第三方路径回跳本站 redirect_uri 时
        // iframe 重新加载本站 index.html，必须允许同源嵌入；Spring Security 默认 DENY
        // 会让 Chrome 拒绝渲染（「localhost 拒绝了我们的连接请求」）。SAMEORIGIN 不放开外站嵌入。
        .headers(headers -> headers.frameOptions(frame -> frame.sameOrigin()))
        .authorizeHttpRequests(authz -> authz
                .requestMatchers("/api/health").permitAll()
                // 登录页/回调处理在认证前运行:SSO 连接信息下发 + OIDC 授权码流程代理
                .requestMatchers("/api/auth/**").permitAll()
                // DSH backend profile 实例调用(无 Supabase 登录态,内网服务间信任,
                // design 2026-09-14 §5.3):注册/心跳 + skill 归属拉取
                .requestMatchers("/api/backend-profiles/register", "/api/backend-profiles/skills").permitAll()
                .requestMatchers("/api/**").authenticated()
                .anyRequest().permitAll()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthConverter)))
            // X-Service-Key 服务间认证(JWT 之前):命中白名单注入服务身份,
            // 其余带该头的请求由过滤器直接 401,不再走 JWT 路径。
            // 就地构造而非 Filter bean:避免 Spring Boot 把它再注册进 servlet 容器链双跑
            .addFilterBefore(new ServiceKeyAuthFilter(serviceKeyProperties),
                BearerTokenAuthenticationFilter.class);
        return http.build();
    }
}
