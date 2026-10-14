package com.dsh.console.user;

import com.dsh.console.user.dto.UserDto;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.platform_users} 表数据访问。
 *
 * <p>读操作为主,写操作集中在 JIT 建档({@link #insertPending})与
 * 审批/禁用/锁定/平台角色更新。
 */
@Repository
public class UserJdbcRepository {

    private static final String SELECT_BASE = """
        SELECT id, auth_subject, login_name, display_name, email, status,
               platform_roles, created_at, created_by,
               approved_at, approved_by,
               disabled_at, disabled_by, disabled_reason,
               locked_at, locked_by, locked_reason
        FROM public.platform_users
        """;

    private final JdbcClient jdbcClient;

    public UserJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * 按 Supabase Auth user.id(auth_subject)查用户。用于 JWT 验证后查询治理状态。
     */
    public Optional<UserDto> findByAuthSubject(String authSubject) {
        return jdbcClient.sql(SELECT_BASE + " WHERE auth_subject = :authSubject")
            .param("authSubject", authSubject)
            .query(UserRowMapper.INSTANCE)
            .optional();
    }

    /**
     * JIT 建档:JWT 验证通过但 platform_users 无记录时插入 pending_approval 行。
     *
     * <p>替代原 Supabase auth.users 注册 trigger(表迁本地 PG 后 trigger 不再存在)。
     * login_name/display_name 由调用方决定兜底值;id 由 gen_random_uuid() 默认生成;
     * 并发重复插入由 auth_subject 唯一约束 + ON CONFLICT DO NOTHING 兜底,返回 0 表示记录已存在。
     *
     * @param authSubject 认证主体(JWT sub)
     * @param loginName   登录名(非空)
     * @param displayName 显示名(非空)
     * @param email       邮箱(可空,认证中心不下发 email 时为 NULL;非空时唯一)
     * @return 插入行数;0 表示 auth_subject 已有记录
     */
    public int insertPending(String authSubject, String loginName, String displayName, String email) {
        return jdbcClient.sql("""
            INSERT INTO public.platform_users (auth_subject, login_name, display_name, email, status)
            VALUES (:authSubject, :loginName, :displayName, :email, 'pending_approval')
            ON CONFLICT (auth_subject) DO NOTHING
            """)
            .param("authSubject", authSubject)
            .param("loginName", loginName)
            .param("displayName", displayName)
            .param("email", email)
            .update();
    }

    /**
     * 批量按 auth_subject 查显示名(实例/任务列表的发起人/办理人列展示用)。
     *
     * <p>远端 Supabase RTT 高,列表解析逐人单查是 N+1;本方法一次查完一页涉及的
     * 全部用户。auth_subject 唯一,重复行理论不存在。缺失的 subject 不出现在返回 Map。
     */
    public Map<String, String> findDisplayNamesByAuthSubjects(Collection<String> authSubjects) {
        if (authSubjects == null || authSubjects.isEmpty()) {
            return Map.of();
        }
        return jdbcClient.sql(
                "SELECT auth_subject, display_name FROM public.platform_users WHERE auth_subject = ANY(:subjects)")
            .param("subjects", authSubjects.toArray(new String[0]))
            .query((rs, rowNum) -> Map.entry(rs.getString("auth_subject"), rs.getString("display_name")))
            .list()
            .stream()
            .collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
    }

    /**
     * 按主键查用户。
     */
    public Optional<UserDto> findById(UUID id) {
        return jdbcClient.sql(SELECT_BASE + " WHERE id = :id")
            .param("id", id)
            .query(UserRowMapper.INSTANCE)
            .optional();
    }

    /**
     * 分页查所有用户(按创建时间倒序)。
     */
    public List<UserDto> list(int offset, int limit) {
        return jdbcClient.sql(SELECT_BASE + " ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
            .param("limit", limit)
            .param("offset", offset)
            .query(UserRowMapper.INSTANCE)
            .list();
    }

    /**
     * 按状态过滤分页查用户。
     */
    public List<UserDto> listByStatus(String status, int offset, int limit) {
        return jdbcClient.sql(SELECT_BASE + " WHERE status = :status ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
            .param("status", status)
            .param("limit", limit)
            .param("offset", offset)
            .query(UserRowMapper.INSTANCE)
            .list();
    }

    /**
     * 审批用户:status → active,记录审批人与审批时间。
     */
    public int approve(UUID userId, UUID approverId) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET status = 'active',
                approved_at = now(),
                approved_by = :approverId,
                platform_roles = CASE
                    WHEN COALESCE(array_length(platform_roles, 1), 0) = 0
                    THEN ARRAY['normal_user']::text[]
                    ELSE platform_roles
                END
            WHERE id = :userId AND status = 'pending_approval'
            """)
            .param("userId", userId)
            .param("approverId", approverId)
            .update();
    }

    /**
     * 禁用用户:status → disabled,记录禁用人与时间及原因。
     */
    public int disable(UUID userId, UUID disablerId, String reason) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET status = 'disabled', disabled_at = now(), disabled_by = :disablerId, disabled_reason = :reason
            WHERE id = :userId AND status != 'disabled'
            """)
            .param("userId", userId)
            .param("disablerId", disablerId)
            .param("reason", reason)
            .update();
    }

    /**
     * 锁定用户:status → locked,记录锁定人与时间及原因。
     */
    public int lock(UUID userId, UUID lockerId, String reason) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET status = 'locked', locked_at = now(), locked_by = :lockerId, locked_reason = :reason
            WHERE id = :userId AND status != 'locked'
            """)
            .param("userId", userId)
            .param("lockerId", lockerId)
            .param("reason", reason)
            .update();
    }

    /**
     * 激活用户(从 disabled/locked 恢复 active)。
     */
    public int activate(UUID userId) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET status = 'active'
            WHERE id = :userId AND status IN ('disabled', 'locked')
            """)
            .param("userId", userId)
            .update();
    }

    /**
     * 更新平台角色(覆盖写)。
     */
    public int updateRoles(UUID userId, List<String> roles) {
        return jdbcClient.sql("""
            UPDATE public.platform_users
            SET platform_roles = :roles
            WHERE id = :userId
            """)
            .param("userId", userId)
            .param("roles", roles == null ? List.of() : roles.toArray(new String[0]))
            .update();
    }

    /**
     * 批量按主键查显示名(部门树负责人列展示用,一次查齐避免逐节点回查)。
     *
     * <p>缺失的 id 不出现在返回 Map。
     */
    public Map<UUID, String> findNamesByIds(Collection<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return Map.of();
        }
        return jdbcClient.sql(
                "SELECT id, display_name FROM public.platform_users WHERE id = ANY(:ids)")
            .param("ids", ids.toArray(new UUID[0]))
            .query((rs, rowNum) -> Map.entry(rs.getObject("id", UUID.class), rs.getString("display_name")))
            .list()
            .stream()
            .collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
    }

    /**
     * 统计给定 ID 集合中状态为 active 的用户数(应用唯一活跃管理员守卫)。
     */
    public int countActiveIn(List<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return 0;
        }
        return jdbcClient.sql("""
            SELECT COUNT(*) FROM public.platform_users
            WHERE status = 'active' AND id = ANY(:ids)
            """)
            .param("ids", ids.toArray(new UUID[0]))
            .query(Integer.class)
            .single();
    }

    /**
     * RowMapper:snake_case 列 → camelCase 字段,处理 TEXT[] → List<String>。
     */
    static class UserRowMapper implements RowMapper<UserDto> {
        static final UserRowMapper INSTANCE = new UserRowMapper();

        @Override
        public UserDto mapRow(ResultSet rs, int rowNum) throws SQLException {
            return new UserDto(
                rs.getObject("id", UUID.class),
                rs.getString("auth_subject"),
                rs.getString("login_name"),
                rs.getString("display_name"),
                rs.getString("email"),
                rs.getString("status"),
                toStringList(rs.getArray("platform_roles")),
                rs.getObject("created_at", java.time.OffsetDateTime.class),
                rs.getObject("created_by", UUID.class),
                rs.getObject("approved_at", java.time.OffsetDateTime.class),
                rs.getObject("approved_by", UUID.class),
                rs.getObject("disabled_at", java.time.OffsetDateTime.class),
                rs.getObject("disabled_by", UUID.class),
                rs.getString("disabled_reason"),
                rs.getObject("locked_at", java.time.OffsetDateTime.class),
                rs.getObject("locked_by", UUID.class),
                rs.getString("locked_reason"),
                List.of()
            );
        }

        private static List<String> toStringList(Array array) throws SQLException {
            if (array == null) {
                return List.of();
            }
            Object[] objArr = (Object[]) array.getArray();
            List<String> result = new ArrayList<>(objArr.length);
            for (Object o : objArr) {
                result.add(o == null ? null : o.toString());
            }
            return List.copyOf(result);
        }
    }
}
