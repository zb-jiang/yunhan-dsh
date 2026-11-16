package com.dsh.console.orgunit;

import com.dsh.console.orgunit.dto.OrgUnitMemberDto;
import com.dsh.console.orgunit.dto.UserOrgUnitDto;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.org_unit_members} 员工×部门多对多映射表数据访问(setup guide §11)。
 *
 * <p>审批路由的成员判定(sameLine/fixedUnit)与发起身份选择都按本表;
 * 治理读写只走 JDBC 超级用户(RLS 不配 authenticated 策略,同 org_units)。
 * 员工归属部门数为个位数量级,覆盖写(删全量+重插)即可,不做差量。
 */
@Repository
public class OrgUnitMemberJdbcRepository {

    private final JdbcClient jdbcClient;

    public OrgUnitMemberJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * 按用户查全部所属部门(含名称,用户管理页部门标签/身份下拉用)。
     */
    public List<UserOrgUnitDto> listByUser(UUID userId) {
        return jdbcClient.sql("""
                SELECT u.id, u.name
                FROM public.org_unit_members m
                JOIN public.org_units u ON u.id = m.org_unit_id
                WHERE m.user_id = :userId
                ORDER BY u.sort_order, u.name
                """)
            .param("userId", userId)
            .query((rs, rowNum) -> new UserOrgUnitDto(
                rs.getObject("id", UUID.class), rs.getString("name")))
            .list();
    }

    /**
     * 批量按用户查所属部门(列表页一次查齐,避免逐行 N+1)。
     *
     * <p>缺失的用户不出现在返回 Map。
     */
    public Map<UUID, List<UserOrgUnitDto>> mapByUsers(Collection<UUID> userIds) {
        if (userIds == null || userIds.isEmpty()) {
            return Map.of();
        }
        Map<UUID, List<UserOrgUnitDto>> result = new LinkedHashMap<>();
        jdbcClient.sql("""
                SELECT m.user_id, u.id, u.name
                FROM public.org_unit_members m
                JOIN public.org_units u ON u.id = m.org_unit_id
                WHERE m.user_id = ANY(:userIds)
                ORDER BY u.sort_order, u.name
                """)
            .param("userIds", userIds.toArray(new UUID[0]))
            .query((rs, rowNum) -> Map.entry(
                rs.getObject("user_id", UUID.class),
                new UserOrgUnitDto(rs.getObject("id", UUID.class), rs.getString("name"))))
            .list()
            .forEach(e -> result.computeIfAbsent(e.getKey(), k -> new ArrayList<>()).add(e.getValue()));
        return result;
    }

    /**
     * 按用户查全部所属部门 id(发起身份解析:0/唯一/多分支判定)。
     */
    public List<UUID> findOrgUnitIdsByUser(UUID userId) {
        return jdbcClient.sql(
                "SELECT org_unit_id FROM public.org_unit_members WHERE user_id = :userId")
            .param("userId", userId)
            .query(UUID.class)
            .list();
    }

    /**
     * 按 Supabase Auth user.id(auth_subject)查全部所属部门 id(启动链路单查询,
     * 不先查 platform_users 再回表)。
     */
    public List<UUID> findOrgUnitIdsByAuthSubject(String authSubject) {
        return jdbcClient.sql("""
                SELECT m.org_unit_id
                FROM public.org_unit_members m
                JOIN public.platform_users p ON p.id = m.user_id
                WHERE p.auth_subject = :authSubject
                """)
            .param("authSubject", authSubject)
            .query(UUID.class)
            .list();
    }

    /**
     * 加入部门(幂等:已在映射中则跳过)。部门负责人指定时自动入成员用(设计决策 12)。
     */
    public void insert(UUID orgUnitId, UUID userId) {
        jdbcClient.sql("""
                INSERT INTO public.org_unit_members (org_unit_id, user_id)
                VALUES (:orgUnitId, :userId)
                ON CONFLICT DO NOTHING
                """)
            .param("orgUnitId", orgUnitId)
            .param("userId", userId)
            .update();
    }

    /**
     * 覆盖写用户的全部部门归属(删全量+重插;部门存在性与 head 守卫由 Service 校验)。
     */
    public void replaceForUser(UUID userId, List<UUID> orgUnitIds) {
        jdbcClient.sql("DELETE FROM public.org_unit_members WHERE user_id = :userId")
            .param("userId", userId)
            .update();
        for (UUID orgUnitId : orgUnitIds) {
            insert(orgUnitId, userId);
        }
    }

    /**
     * 统计部门名下成员数(部门删除守卫)。
     */
    public int countByOrgUnit(UUID orgUnitId) {
        return jdbcClient.sql(
                "SELECT COUNT(*) FROM public.org_unit_members WHERE org_unit_id = :orgUnitId")
            .param("orgUnitId", orgUnitId)
            .query(Integer.class)
            .single();
    }

    /**
     * 部门当前成员的用户 id 清单(用户编辑页"移出本部门将解除负责人"守卫用)。
     */
    public List<UUID> listUserIdsByOrgUnit(UUID orgUnitId) {
        return jdbcClient.sql(
                "SELECT user_id FROM public.org_unit_members WHERE org_unit_id = :orgUnitId")
            .param("orgUnitId", orgUnitId)
            .query(UUID.class)
            .list();
    }

    /**
     * 部门成员明细(关联 platform_users 带登录名/显示名/状态;部门管理页成员面板用)。
     */
    public List<OrgUnitMemberDto> listMembersByOrgUnit(UUID orgUnitId) {
        return jdbcClient.sql("""
                SELECT m.user_id, p.login_name, p.display_name, p.status
                FROM public.org_unit_members m
                JOIN public.platform_users p ON p.id = m.user_id
                WHERE m.org_unit_id = :orgUnitId
                ORDER BY p.display_name, p.login_name
                """)
            .param("orgUnitId", orgUnitId)
            .query((rs, rowNum) -> new OrgUnitMemberDto(
                rs.getObject("user_id", UUID.class), rs.getString("login_name"),
                rs.getString("display_name"), rs.getString("status")))
            .list();
    }

    /**
     * 移出单个成员(幂等:映射不存在则 0 行)。
     */
    public void deleteMember(UUID orgUnitId, UUID userId) {
        jdbcClient.sql(
                "DELETE FROM public.org_unit_members WHERE org_unit_id = :orgUnitId AND user_id = :userId")
            .param("orgUnitId", orgUnitId)
            .param("userId", userId)
            .update();
    }
}
