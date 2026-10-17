package com.dsh.flowable.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 服务密钥认证 filter:请求头 {@code X-Service-Key} 与配置的共享密钥
 * ({@code dsh.web-console.service-key},与 web-console、backend profile 同值)
 * 一致时,以 {@code ROLE_SERVICE} 主体建立认证,后续 authorizeHttpRequests
 * 视为 authenticated——供 web-console 服务面链路(backend profile 工具请求
 * 只有 X-Service-Key,无用户 JWT 可透传)。
 *
 * <p>密钥未配置或头缺失/不匹配时不设置认证,请求落到 JWT 通道或被 401
 * 拒绝——不存在放行路径(fail-closed)。无状态,请求结束由
 * SecurityContextHolderFilter 清理。
 */
public class ServiceKeyAuthFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Service-Key";

    private final DshWebConsoleProperties properties;

    public ServiceKeyAuthFilter(DshWebConsoleProperties properties) {
        this.properties = properties;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String presented = request.getHeader(HEADER);
        String expected = properties.serviceKey();
        if (presented != null && !presented.isBlank()
                && expected != null && !expected.isBlank()
                && presented.equals(expected)) {
            SecurityContext context = SecurityContextHolder.createEmptyContext();
            context.setAuthentication(new UsernamePasswordAuthenticationToken(
                "dsh-service", "n/a", AuthorityUtils.createAuthorityList("ROLE_SERVICE")));
            SecurityContextHolder.setContext(context);
        }
        chain.doFilter(request, response);
    }
}
