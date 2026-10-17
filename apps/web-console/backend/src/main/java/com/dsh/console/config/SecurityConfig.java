package com.dsh.console.config;

import com.dsh.console.security.JwtAuthConverter;
import com.dsh.console.security.ServiceKeyAuthFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.client.RestTemplate;

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
     * <p>经 {@code withIssuerLocation} 做 OpenID discovery 推导 JWKS 地址,验签算法集
     * 由 JWKS 中的公钥推导(Supabase Auth 为 ES256,Casdoor 为 RS256)。不用
     * {@code withJwkSetUri} 替代:其默认算法集硬编码 RS256,拒绝 ES256 token。
     * discovery 与 JWKS 拉取统一走注入的带超时 RestOperations——默认 RestTemplate
     * 无超时,issuer 域名网络不可达时 bean 创建静默挂起(TCP 建连后 TLS 握手无响应),
     * Tomcat 永远无法 start。
     * issuer 参数校验在 {@link SsoAuthProperties} 绑定期 fails loud。</p>
     */
    @Bean
    public JwtDecoder jwtDecoder() {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withIssuerLocation(ssoProperties.issuer())
            .restOperations(new RestTemplate(bootstrapRequestFactory()))
            .build();
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(ssoProperties.issuer()));
        return decoder;
    }

    /** discovery/JWKS 拉取专用请求工厂:连接/读取各 5 秒超时,网络不可达时快速报错。 */
    private SimpleClientHttpRequestFactory bootstrapRequestFactory() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(5000);
        factory.setReadTimeout(5000);
        return factory;
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
                // ASYNC/ERROR dispatch 只能由容器内部发起(外部请求恒为 REQUEST dispatch,
                // 攻击面不变),放行它们是 Spring Boot 默认链的兜底:StreamingResponseBody
                // 类端点(LLM 代理、实例工作空间 download)的异步续处理会重跑 filter chain,
                // 而所有 OncePerRequestFilter 默认 shouldNotFilterAsyncDispatch=true 被跳过,
                // 服务密钥认证(filter 现场注入、不存 repository)在 ASYNC dispatch 蒸发,
                // 不放行会 Access Denied 且响应已提交无法回错误页。
                .dispatcherTypeMatchers(jakarta.servlet.DispatcherType.ASYNC, jakarta.servlet.DispatcherType.ERROR).permitAll()
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
