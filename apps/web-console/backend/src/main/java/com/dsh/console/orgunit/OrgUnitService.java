package com.dsh.console.orgunit;

import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.orgunit.dto.AddOrgUnitMembersRequest;
import com.dsh.console.orgunit.dto.OrgUnitDto;
import com.dsh.console.orgunit.dto.OrgUnitMemberDto;
import com.dsh.console.orgunit.dto.OrgPositionDto;
import com.dsh.console.orgunit.dto.OrgUnitTreeNode;
import com.dsh.console.orgunit.dto.SaveOrgUnitRequest;
import com.dsh.console.user.UserJdbcRepository;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 组织树治理业务编排(全局维度,system_admin)。
 *
 * <p>组织树是全局共享治理数据(设计 2026-09-19 §2:一套组织架构所有应用共享),
 * 部门数量级小,校验(同名/循环引用/删除守卫)拉全量内存判断。写操作同事务记审计。
 * 指定/更换部门负责人时自动加入 org_unit_members(决策 12:负责人必然有部门归属)。
 */
@Service
public class OrgUnitService {

    private final OrgUnitJdbcRepository orgUnitRepository;
    private final OrgUnitMemberJdbcRepository memberRepository;
    private final UserJdbcRepository userRepository;
    private final AuditService auditService;

    public OrgUnitService(OrgUnitJdbcRepository orgUnitRepository,
                          OrgUnitMemberJdbcRepository memberRepository,
                          UserJdbcRepository userRepository,
                          AuditService auditService) {
        this.orgUnitRepository = orgUnitRepository;
        this.memberRepository = memberRepository;
        this.userRepository = userRepository;
        this.auditService = auditService;
    }

    /**
     * 部门树(嵌套,子部门按 sortOrder、name 排序;负责人显示名批量补齐)。
     *
     * <p>父部门缺失的孤儿节点(仅 SQL 手工操作可产生)按根节点展示,保证可治理。
     */
    public List<OrgUnitTreeNode> tree() {
        List<OrgUnitDto> all = orgUnitRepository.list();
        Map<UUID, String> headNames = userRepository.findNamesByIds(
            all.stream().map(OrgUnitDto::headUserId).filter(Objects::nonNull).toList());
        // 根/孤儿(parentId=null)不进子索引:groupingBy 拒绝 null key,它们也永远不会是任何节点的孩子
        Map<UUID, List<OrgUnitDto>> byParent = all.stream()
            .filter(d -> d.parentId() != null)
            .collect(Collectors.groupingBy(OrgUnitDto::parentId));
        Set<UUID> ids = all.stream().map(OrgUnitDto::id).collect(Collectors.toSet());
        // 孤儿节点(父部门不在现有集合)按根展示
        List<OrgUnitDto> roots = all.stream()
            .filter(d -> d.parentId() == null || !ids.contains(d.parentId()))
            .toList();
        return roots.stream().map(d -> toNode(d, byParent, headNames)).toList();
    }

    private OrgUnitTreeNode toNode(OrgUnitDto dto, Map<UUID, List<OrgUnitDto>> byParent,
                                   Map<UUID, String> headNames) {
        List<OrgUnitDto> children = byParent.getOrDefault(dto.id(), List.of());
        return new OrgUnitTreeNode(
            dto.id(),
            dto.name(),
            dto.parentId(),
            dto.headUserId(),
            dto.headUserId() == null ? null : headNames.get(dto.headUserId()),
            dto.sortOrder(),
            children.stream().map(c -> toNode(c, byParent, headNames)).toList()
        );
    }

    /**
     * 新建部门。
     *
     * <p>校验:父部门存在(非根时)、负责人存在(配置时)、同级同名唯一。
     */
    @Transactional
    public OrgUnitDto create(SaveOrgUnitRequest request, UUID creatorId) {
        validateParentsAndHead(request);
        List<OrgUnitDto> all = orgUnitRepository.list();
        requireSiblingNameUnique(all, request.parentId(), request.name(), null);

        UUID id = orgUnitRepository.insert(request.name(), request.parentId(),
            request.headUserId(), request.sortOrder() == null ? 0 : request.sortOrder());
        if (request.headUserId() != null) {
            // 决策 12:负责人必然有本部门归属,指定即入成员映射(幂等)
            memberRepository.insert(id, request.headUserId());
        }
        auditService.record("ORG_UNIT_CREATE", "org_unit", id, creatorId,
            Map.of("name", request.name()));
        return orgUnitRepository.findById(id)
            .orElseThrow(() -> new NotFoundException("部门不存在: " + id));
    }

    /**
     * 更新部门(全量覆盖)。
     *
     * <p>校验:部门存在、父部门/负责人存在、同级同名唯一(排除自己)、
     * 循环引用(新父不能是自己或自己的后代)。
     */
    @Transactional
    public OrgUnitDto update(UUID id, SaveOrgUnitRequest request, UUID updaterId) {
        OrgUnitDto existing = orgUnitRepository.findById(id)
            .orElseThrow(() -> new NotFoundException("部门不存在: " + id));
        validateParentsAndHead(request);
        List<OrgUnitDto> all = orgUnitRepository.list();
        requireSiblingNameUnique(all, request.parentId(), request.name(), id);

        // 循环引用:新父不能是自己或自己的后代
        if (id.equals(request.parentId())) {
            throw new IllegalArgumentException("父部门不能是部门自己: " + id);
        }
        Set<UUID> descendants = collectDescendants(all, id);
        if (request.parentId() != null && descendants.contains(request.parentId())) {
            throw new IllegalArgumentException(
                "父部门「%s」是本部门的后代,会造成组织树循环引用".formatted(request.parentId()));
        }
        // 覆盖父部门时,新父若正是现父的幂等更新也照常执行

        orgUnitRepository.update(id, request.name(), request.parentId(), request.headUserId(),
            request.sortOrder() == null ? existing.sortOrder() : request.sortOrder());
        if (request.headUserId() != null) {
            // 决策 12:更换负责人同样保证其有本部门归属(幂等;旧负责人不自动移出)
            memberRepository.insert(id, request.headUserId());
        }
        auditService.record("ORG_UNIT_UPDATE", "org_unit", id, updaterId,
            Map.of("name", request.name()));
        return orgUnitRepository.findById(id)
            .orElseThrow(() -> new NotFoundException("部门不存在: " + id));
    }

    /**
     * 删除部门。
     *
     * <p>守卫:无子部门、无成员(org_unit_members 引用计数)。
     */
    @Transactional
    public void delete(UUID id, UUID deleterId) {
        OrgUnitDto existing = orgUnitRepository.findById(id)
            .orElseThrow(() -> new NotFoundException("部门不存在: " + id));
        List<OrgUnitDto> all = orgUnitRepository.list();
        boolean hasChildren = all.stream().anyMatch(d -> id.equals(d.parentId()));
        if (hasChildren) {
            throw new IllegalStateException(
                "部门「%s」下仍有子部门,先删除或移走子部门".formatted(existing.name()));
        }
        int members = memberRepository.countByOrgUnit(id);
        if (members > 0) {
            throw new IllegalStateException(
                "部门「%s」名下仍有 %d 名成员,先在成员面板移出成员".formatted(existing.name(), members));
        }
        orgUnitRepository.delete(id);
        auditService.record("ORG_UNIT_DELETE", "org_unit", id, deleterId,
            Map.of("name", existing.name()));
    }

    /**
     * 部门成员明细(部门管理页成员面板)。
     */
    @Transactional(readOnly = true)
    public List<OrgUnitMemberDto> members(UUID orgUnitId) {
        requireOrgUnitExists(orgUnitId);
        return memberRepository.listMembersByOrgUnit(orgUnitId);
    }

    /**
     * 批量加入成员(幂等:已在本部门的 id 跳过)。
     *
     * <p>校验:部门存在、用户存在;审计 ORG_UNIT_MEMBER_ADD。
     */
    @Transactional
    public List<OrgUnitMemberDto> addMembers(UUID orgUnitId, AddOrgUnitMembersRequest request,
                                             UUID operatorId) {
        OrgUnitDto unit = requireOrgUnitExists(orgUnitId);
        for (UUID userId : request.userIds().stream().distinct().toList()) {
            if (userRepository.findById(userId).isEmpty()) {
                throw new NotFoundException("用户不存在: " + userId);
            }
            memberRepository.insert(orgUnitId, userId);
        }
        auditService.record("ORG_UNIT_MEMBER_ADD", "org_unit", orgUnitId, operatorId,
            Map.of("name", unit.name(), "count", request.userIds().size()));
        return memberRepository.listMembersByOrgUnit(orgUnitId);
    }

    /**
     * 移出单个成员。
     *
     * <p>守卫:负责人不可移出(决策 12:负责人必然有本部门归属),先更换负责人再移出;
     * 审计 ORG_UNIT_MEMBER_REMOVE。
     */
    @Transactional
    public List<OrgUnitMemberDto> removeMember(UUID orgUnitId, UUID userId, UUID operatorId) {
        OrgUnitDto unit = requireOrgUnitExists(orgUnitId);
        if (userId.equals(unit.headUserId())) {
            throw new IllegalStateException(
                "用户是部门「%s」的负责人,先更换负责人再移出".formatted(unit.name()));
        }
        memberRepository.deleteMember(orgUnitId, userId);
        auditService.record("ORG_UNIT_MEMBER_REMOVE", "org_unit", orgUnitId, operatorId,
            Map.of("name", unit.name(), "userId", userId.toString()));
        return memberRepository.listMembersByOrgUnit(orgUnitId);
    }

    /** 部门存在性守卫(成员端点共用)。 */
    private OrgUnitDto requireOrgUnitExists(UUID orgUnitId) {
        return orgUnitRepository.findById(orgUnitId)
            .orElseThrow(() -> new NotFoundException("部门不存在: " + orgUnitId));
    }

    /**
     * 当前用户的组织位置清单(发起身份选择用,design 2026-09-19 §5.1)。
     *
     * <p>每个位置含部门 id/名称与到根的部门名路径(根在前,展示"总公司/华东区/A 部门");
     * 员工在组织树中的全部隶属都返回,前端/AI 据此决定是否询问发起身份。
     */
    public List<OrgPositionDto> positionsForUser(UUID platformUserId) {
        List<OrgUnitDto> all = orgUnitRepository.list();
        Map<UUID, OrgUnitDto> byId = all.stream()
            .collect(Collectors.toMap(OrgUnitDto::id, d -> d));
        return memberRepository.listByUser(platformUserId).stream()
            .map(m -> {
                OrgUnitDto unit = byId.get(m.orgUnitId());
                List<String> path = new ArrayList<>();
                OrgUnitDto cur = unit;
                while (cur != null && path.size() < 100) {
                    path.add(0, cur.name());
                    cur = cur.parentId() == null ? null : byId.get(cur.parentId());
                }
                return new OrgPositionDto(m.orgUnitId(),
                    unit == null ? m.name() : unit.name(), path);
            })
            .toList();
    }

    /** 校验父部门与负责人存在性(null 跳过)。 */
    private void validateParentsAndHead(SaveOrgUnitRequest request) {
        if (request.parentId() != null) {
            orgUnitRepository.findById(request.parentId())
                .orElseThrow(() -> new NotFoundException("父部门不存在: " + request.parentId()));
        }
        if (request.headUserId() != null
                && userRepository.findById(request.headUserId()).isEmpty()) {
            throw new NotFoundException("部门负责人用户不存在: " + request.headUserId());
        }
    }

    /** 同级同名唯一(内存;excludeId 用于更新时排除自己)。 */
    private void requireSiblingNameUnique(List<OrgUnitDto> all, UUID parentId,
                                          String name, UUID excludeId) {
        boolean duplicated = all.stream().anyMatch(d ->
            Objects.equals(d.parentId(), parentId)
                && d.name().equals(name)
                && !d.id().equals(excludeId));
        if (duplicated) {
            throw new IllegalArgumentException("同级已存在同名部门: " + name);
        }
    }

    /** 收集部门自身及全部后代(内存 DFS)。 */
    private Set<UUID> collectDescendants(List<OrgUnitDto> all, UUID rootId) {
        Map<UUID, List<UUID>> childrenByParent = new HashMap<>();
        for (OrgUnitDto d : all) {
            if (d.parentId() != null) {
                childrenByParent.computeIfAbsent(d.parentId(), k -> new ArrayList<>()).add(d.id());
            }
        }
        Set<UUID> visited = new HashSet<>();
        java.util.Deque<UUID> stack = new java.util.ArrayDeque<>();
        stack.push(rootId);
        while (!stack.isEmpty()) {
            UUID cur = stack.pop();
            for (UUID child : childrenByParent.getOrDefault(cur, List.of())) {
                if (visited.add(child)) {
                    stack.push(child);
                }
            }
        }
        return visited;
    }
}
