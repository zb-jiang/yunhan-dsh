package com.dsh.console.security;

import com.dsh.console.user.UserJdbcRepository;
import com.dsh.console.user.dto.UserDto;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;

/**
 * JWT → Spring Security Authentication 转换器。
 *
 * <p>由 Spring Security 在 JWT 验证通过后调用,从 JWT 的 {@code sub} claim
 * 取认证主体,查 {@code public.platform_users} 取治理状态与平台角色,
 * 构造 {@link AuthContext} 作为 principal。记录不存在时 JIT 插入
 * pending_approval 行(替代表迁本地 PG 前 Supabase auth.users 上的注册 trigger)。
 *
 * <p>如治理记录不存在(JIT 建档后 recheck 仍为空)或 status 非 active,
 * 仍构造 AuthContext(roles=空),由 Controller 路由或方法级 RBAC 注解拒绝访问,
 * 不在此处抛异常(避免 token 验证与治理状态校验耦合)。
 */
@Component
public class JwtAuthConverter implements Converter<Jwt, AbstractAuthenticationToken> {

    private static final Logger log = LoggerFactory.getLogger(JwtAuthConverter.class);

    private final UserJdbcRepository userJdbcRepository;

    public JwtAuthConverter(UserJdbcRepository userJdbcRepository) {
        this.userJdbcRepository = userJdbcRepository;
    }

    @Override
    public AbstractAuthenticationToken convert(Jwt jwt) {
        String authSubject = jwt.getSubject();
        log.info("[JwtAuth] converting JWT sub={}", authSubject);
        Optional<UserDto> user = userJdbcRepository.findByAuthSubject(authSubject);

        if (user.isEmpty()) {
            user = jitInsert(jwt, authSubject);
        }

        if (user.isEmpty()) {
            log.warn("[JwtAuth] no platform_users record for sub={}", authSubject);
            return new AuthAuthenticationToken(new AuthContext(
                null, authSubject, null, null, null, List.of()));
        }
        if (!"active".equalsIgnoreCase(user.get().status())) {
            log.warn("[JwtAuth] user status={} for sub={}, not active",
                user.get().status(), authSubject);
            return new AuthAuthenticationToken(new AuthContext(
                null, authSubject, null, null, null, List.of()));
        }

        UserDto dto = user.get();
        List<String> roles = dto.platformRoles() == null ? List.of() : dto.platformRoles();
        return new AuthAuthenticationToken(new AuthContext(
            dto.id(),
            authSubject,
            dto.email(),
            dto.loginName(),
            dto.displayName(),
            roles));
    }

    /**
     * JIT 建档:JWT 验证通过但 platform_users 无记录时插入 pending_approval 行。
     *
     * <p>替代原 Supabase auth.users 注册 trigger(表迁本地 PG 后 trigger 不再存在)。
     * login_name 取 user_metadata.login_name,兜底 email,再兜底 sub。display_name
     * 取值链:{@code displayName} claim(2026-10-14 实测钉钉登录 token,Casdoor 的
     * {@code name} claim 是登录名,显示名在顶层 displayName claim)→ 标准 OIDC
     * {@code name} claim(其他 IdP 的全名;Supabase 顶层无此 claim)
     * → user_metadata.display_name → email 本地部分 → sub。email claim 缺失
     * (认证中心不下发 email,如钉钉 unionId 登录)仍建档:email 列存 NULL,
     * login_name/display_name 兜底
     * sub(unionId 等认证主体全局唯一,不会撞 login_name 唯一约束)。
     */
    private Optional<UserDto> jitInsert(Jwt jwt, String authSubject) {
        String email = jwt.getClaimAsString("email");
        boolean hasEmail = email != null && !email.isBlank();
        String emailOrSubject = hasEmail ? email : authSubject;
        String localPartOrSubject = hasEmail
            ? (email.contains("@") ? email.substring(0, email.indexOf('@')) : email)
            : authSubject;
        Map<String, Object> metadata = jwt.getClaimAsMap("user_metadata");
        String loginName = metadataString(metadata, "login_name", emailOrSubject);
        // Casdoor 的 name claim 是登录名,显示名在 displayName claim
        String displayName = firstNonBlank(
            localPartOrSubject,
            jwt.getClaimAsString("displayName"),
            jwt.getClaimAsString("name"),
            metadataString(metadata, "display_name", null));
        log.info("[JwtAuth] JIT inserting pending_approval row for sub={}", authSubject);
        userJdbcRepository.insertPending(authSubject, loginName, displayName, hasEmail ? email : null);
        return userJdbcRepository.findByAuthSubject(authSubject);
    }

    private static String metadataString(Map<String, Object> metadata, String key, String fallback) {
        if (metadata == null) {
            return fallback;
        }
        Object value = metadata.get(key);
        return value instanceof String s && !s.isBlank() ? s : fallback;
    }

    /**
     * 返回候选中第一个非空白值,全空时返回兜底值。
     * @param fallback 全部候选为 null 或空白时返回的值
     * @param candidates 按优先级排列的候选值,可含 null/空白
     * @return 第一个非空白候选,否则 fallback
     */
    private static String firstNonBlank(String fallback, String... candidates) {
        for (String candidate : candidates) {
            if (candidate != null && !candidate.isBlank()) {
                return candidate;
            }
        }
        return fallback;
    }

    /**
     * 自定义 AuthenticationToken,持有 AuthContext 与角色列表。
     *
     * <p>已认证状态(非 anonymous),authorities 取自 platform_roles,带 ROLE_ 前缀
     * 以兼容 {@code hasRole()} 表达式。
     */
    public static class AuthAuthenticationToken extends AbstractAuthenticationToken {

        private final AuthContext authContext;

        public AuthAuthenticationToken(AuthContext authContext) {
            super(authoritiesFor(authContext));
            this.authContext = authContext;
            setAuthenticated(true);
        }

        @Override
        public Object getPrincipal() {
            return authContext;
        }

        @Override
        public Object getCredentials() {
            return null;
        }

        private static List<GrantedAuthority> authoritiesFor(AuthContext ctx) {
            if (ctx == null || ctx.roles() == null) {
                return List.of();
            }
            List<GrantedAuthority> auths = new ArrayList<>(ctx.roles().size());
            for (String role : ctx.roles()) {
                if (role != null && !role.isBlank()) {
                    auths.add(new SimpleGrantedAuthority("ROLE_" + role.toUpperCase()));
                }
            }
            return List.copyOf(auths);
        }
    }
}
