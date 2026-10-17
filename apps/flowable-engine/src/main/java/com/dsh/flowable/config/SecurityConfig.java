package com.dsh.flowable.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;
import org.springframework.web.client.RestTemplate;

/**
 * Spring Security 配置:认证中心 JWT 本地验证。
 *
 * <p>认证模型为"认证直连认证中心"(认证中心设计 D2:云汉只做 OIDC RP/RS,
 * 发证方可为 Supabase Auth / Casdoor / 客户 IdP,issuer 由部署配置):
 * <ul>
 *   <li>员工端 DSH enterprise profile / Web Console 后端都直连认证中心完成登录,拿 JWT。</li>
 *   <li>调用 Flowable 引擎 REST 时带 {@code Authorization: Bearer <jwt>},
 *       本服务按配置的 issuer 从 OpenID 发现端点拉 JWKS 在本地验证。</li>
 *   <li>从 JWT 的 {@code sub} claim 提取认证主体(认证中心 user.id / unionId),
 *       作为查询任务 {@code assignee} 的依据。</li>
 * </ul>
 *
 * <p>V1 仅校验 iss + exp + sub;不校验 aud,允许 authenticated token 调用。
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private final SupabaseJwtProperties properties;
    private final DshWebConsoleProperties webConsoleProperties;

    public SecurityConfig(SupabaseJwtProperties properties, DshWebConsoleProperties webConsoleProperties) {
        this.properties = properties;
        this.webConsoleProperties = webConsoleProperties;
    }

    /**
     * 按配置 issuer 构造 NimbusJwtDecoder,支持 ES256/RS256 等非对称算法。
     *
     * <p>经 {@code withIssuerLocation} 做 OpenID discovery 推导 JWKS 地址,验签算法集
     * 由 JWKS 中的公钥推导(Supabase Auth 为 ES256,Casdoor 为 RS256)。不用
     * {@code withJwkSetUri} 替代:其默认算法集硬编码 RS256,拒绝 ES256 token。
     * discovery 与 JWKS 拉取统一走注入的带超时 RestOperations——默认 RestTemplate
     * 无超时,issuer 域名网络不可达时 bean 创建静默挂起(TCP 建连后 TLS 握手无响应),
     * Tomcat 永远无法 start。issuer 参数校验在 {@link SupabaseJwtProperties} 绑定期
     * fails loud。</p>
     */
    @Bean
    public JwtDecoder jwtDecoder() {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withIssuerLocation(properties.jwtIssuer())
            .restOperations(new RestTemplate(bootstrapRequestFactory()))
            .build();
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(properties.jwtIssuer()));
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
     * 安全过滤链:无状态、CSRF 关闭、健康检查放行、其余端点要求认证。
     *
     * <p>路径规则用 {@link AntPathRequestMatcher} 而非字符串形式:本应用有两个 servlet
     * (Spring MVC 的 {@code /} + Flowable REST 的 {@code /process-api/*}),
     * 字符串 requestMatchers 会被构造成 MvcRequestMatcher,多 servlet 场景下
     * Spring Security 无法推断 servlet path,请求时直接抛 IllegalArgumentException。
     * AntPathRequestMatcher 与 servlet 数量无关。
     *
     * <p>{@code /actuator/health} 免认证供部署探活(load balancer / k8s probe);
     * {@code /actuator/metrics/**} 免认证供 web-console 定时轮询采集引擎指标——
     * 轮询方(后台调度线程)没有用户 JWT 可透传,先例是 web-console 的
     * backend-profiles register permitAll("内网服务间信任,第一期");exposure 只开
     * health,metrics 两个端点(application.yml),不含 env/configprops/beans,
     * 指标数值不含敏感信息。
     *
     * <p>{@code /process-api/**} 是 Flowable 官方 REST 端点(参见 Flowable 文档),
     * {@code /dsh/**} 是 DSH 自定义薄封装端点。两类端点接受两条认证通道:用户 JWT
     * (oauth2ResourceServer)或共享服务密钥({@link ServiceKeyAuthFilter},供
     * web-console 服务面链路——backend profile 工具请求只有 X-Service-Key,
     * 无用户 JWT 可透传;fail-closed:密钥未配置时永不放行)。
     */
    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(authz -> authz
                .requestMatchers(AntPathRequestMatcher.antMatcher("/actuator/health")).permitAll()
                .requestMatchers(AntPathRequestMatcher.antMatcher("/actuator/metrics/**")).permitAll()
                .requestMatchers(AntPathRequestMatcher.antMatcher("/process-api/**")).authenticated()
                .requestMatchers(AntPathRequestMatcher.antMatcher("/dsh/**")).authenticated()
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> {}))
            .addFilterBefore(new ServiceKeyAuthFilter(webConsoleProperties), UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
}
