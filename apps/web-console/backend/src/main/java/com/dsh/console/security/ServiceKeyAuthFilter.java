package com.dsh.console.security;

import com.dsh.console.config.ServiceKeyProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Set;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * X-Service-Key 服务间认证过滤器:内网机器(flowable-engine、backend profile
 * 实例)无 Supabase 登录态,凭静态服务密钥访问白名单端点。
 *
 * <p>白名单为「路径前缀 + 允许方法集」条目集合(2026-10 知识库集成 + 2026-10-14
 * 实例工作空间,设计 docs/plans/2026-10-14-instance-workspace-design.md §4.3):
 * {@code GET /api/backend/kb/**}(流程归属知识库解析 + 只读检索/清单/全文,见
 * BackendKbController)、{@code GET|POST|DELETE /api/backend/instances/**}(实例
 * 工作空间文件读写,见 BackendWorkspaceController)。携带头但密钥不符、未配置、
 * 方法不在条目方法集或路径不在任何条目前缀 → 401 fail loud,不静默降级为匿名
 * JWT 路径。无该头的请求原样放行走 JWT 过滤链。
 *
 * <p>认证通过后注入 {@link PreAuthenticatedAuthenticationToken}(principal 固定
 * {@code dsh-service}),满足 {@code /api/**} 的 authenticated 规则;白名单控制器
 * 不使用 {@code @AuthenticationPrincipal AuthContext}(服务身份无员工语义)。
 *
 * <p>不加 {@code @Component}:Spring Boot 会把 Filter bean 再注册进 servlet
 * 容器链造成双跑(OncePerRequestFilter 只防重入不防语义混乱),由 SecurityConfig
 * 构造并只挂 security 链。
 */
public class ServiceKeyAuthFilter extends OncePerRequestFilter {

    /** 服务密钥请求头。 */
    public static final String HEADER = "X-Service-Key";

    /** 白名单条目:路径前缀 + 允许的 HTTP 方法集。 */
    public record ServiceRoute(String prefix, Set<String> methods) {
    }

    /**
     * 服务面白名单条目:知识库只读端点(BackendKbController)与实例工作空间
     * 文件读写端点(BackendWorkspaceController)。新增服务面控制器在此追加条目。
     */
    private static final List<ServiceRoute> SERVICE_ROUTES = List.of(
        new ServiceRoute("/api/backend/kb/", Set.of("GET")),
        new ServiceRoute("/api/backend/instances/", Set.of("GET", "POST", "DELETE")));

    /** 注入 Authentication 的固定 principal。 */
    private static final String SERVICE_PRINCIPAL = "dsh-service";

    private final ServiceKeyProperties properties;

    public ServiceKeyAuthFilter(ServiceKeyProperties properties) {
        this.properties = properties;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String presented = request.getHeader(HEADER);
        if (presented == null) {
            chain.doFilter(request, response);
            return;
        }
        if (!isAllowed(request, presented)) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "X-Service-Key 无效或路径不在白名单");
            return;
        }
        PreAuthenticatedAuthenticationToken authentication = new PreAuthenticatedAuthenticationToken(
            SERVICE_PRINCIPAL, presented, List.of(new SimpleGrantedAuthority("ROLE_DSH_SERVICE")));
        authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
        SecurityContextHolder.getContext().setAuthentication(authentication);
        try {
            chain.doFilter(request, response);
        } finally {
            SecurityContextHolder.clearContext();
        }
    }

    /**
     * 白名单判定:密钥恒时比对一致,且请求命中某条目(路径以条目前缀开头、方法在
     * 条目方法集内);密钥未配置(空白)一律拒绝——机制关闭时携带头即显式失败。
     */
    private boolean isAllowed(HttpServletRequest request, String presented) {
        String configured = properties.serviceKey();
        if (configured == null || configured.isBlank()) {
            return false;
        }
        boolean keyMatches = MessageDigest.isEqual(
            configured.getBytes(StandardCharsets.UTF_8), presented.getBytes(StandardCharsets.UTF_8));
        if (!keyMatches) {
            return false;
        }
        String uri = request.getRequestURI();
        String method = request.getMethod();
        return SERVICE_ROUTES.stream()
            .anyMatch(route -> uri.startsWith(route.prefix())
                && route.methods().contains(method));
    }
}
