package com.dsh.console.orgunit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.orgunit.dto.AddOrgUnitMembersRequest;
import com.dsh.console.orgunit.dto.OrgUnitDto;
import com.dsh.console.orgunit.dto.OrgUnitTreeNode;
import com.dsh.console.orgunit.dto.OrgPositionDto;
import com.dsh.console.orgunit.dto.SaveOrgUnitRequest;
import com.dsh.console.orgunit.dto.UserOrgUnitDto;
import com.dsh.console.user.UserJdbcRepository;
import com.dsh.console.user.dto.UserDto;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 组织树治理的多对多成员映射行为测试(design 2026-09-19 决策 12/§5.1):
 * 指定/更换负责人自动入 org_unit_members;删除守卫按成员计数;
 * positionsForUser 计算到根路径。
 */
class OrgUnitServiceTest {

    private OrgUnitJdbcRepository orgUnitRepository;
    private OrgUnitMemberJdbcRepository memberRepository;
    private UserJdbcRepository userRepository;
    private OrgUnitService service;

    @BeforeEach
    void setUp() {
        orgUnitRepository = mock(OrgUnitJdbcRepository.class);
        memberRepository = mock(OrgUnitMemberJdbcRepository.class);
        userRepository = mock(UserJdbcRepository.class);
        service = new OrgUnitService(orgUnitRepository, memberRepository,
            userRepository, mock(AuditService.class));
    }

    @Test
    void createWithHeadInsertsHeadIntoMembers() {
        UUID headUserId = UUID.randomUUID();
        UUID createdId = UUID.randomUUID();
        when(orgUnitRepository.insert(any(), any(), any(), anyInt())).thenReturn(createdId);
        when(orgUnitRepository.findById(createdId)).thenReturn(
            Optional.of(unit(createdId, "A 部门", null, headUserId)));
        when(userRepository.findById(headUserId)).thenReturn(Optional.of(mock(UserDto.class)));

        service.create(new SaveOrgUnitRequest("A 部门", null, headUserId, 0), UUID.randomUUID());

        verify(memberRepository).insert(createdId, headUserId);
    }

    @Test
    void createWithoutHeadSkipsMemberInsert() {
        UUID createdId = UUID.randomUUID();
        when(orgUnitRepository.insert(any(), any(), any(), anyInt())).thenReturn(createdId);
        when(orgUnitRepository.findById(createdId)).thenReturn(
            Optional.of(unit(createdId, "A 部门", null, null)));
        when(orgUnitRepository.list()).thenReturn(List.of());

        service.create(new SaveOrgUnitRequest("A 部门", null, null, 0), UUID.randomUUID());

        verify(memberRepository, never()).insert(any(), any());
    }

    @Test
    void updateChangingHeadInsertsNewHead() {
        UUID deptId = UUID.randomUUID();
        UUID oldHead = UUID.randomUUID();
        UUID newHead = UUID.randomUUID();
        when(orgUnitRepository.findById(deptId)).thenReturn(
            Optional.of(unit(deptId, "A 部门", null, oldHead)));
        when(orgUnitRepository.list()).thenReturn(List.of());
        when(userRepository.findById(newHead)).thenReturn(Optional.of(mock(UserDto.class)));

        service.update(deptId, new SaveOrgUnitRequest("A 部门", null, newHead, 0), UUID.randomUUID());

        verify(memberRepository).insert(deptId, newHead);
    }

    @Test
    void deleteBlockedWhileMembersExist() {
        UUID deptId = UUID.randomUUID();
        when(orgUnitRepository.findById(deptId)).thenReturn(
            Optional.of(unit(deptId, "A 部门", null, null)));
        when(orgUnitRepository.list()).thenReturn(List.of());
        when(memberRepository.countByOrgUnit(deptId)).thenReturn(2);

        assertThatThrownBy(() -> service.delete(deptId, UUID.randomUUID()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("仍有 2 名成员");
    }

    @Test
    void addMembersDeduplicatesAndReturnsFullList() {
        UUID deptId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        when(orgUnitRepository.findById(deptId)).thenReturn(
            Optional.of(unit(deptId, "A 部门", null, null)));
        when(userRepository.findById(userId)).thenReturn(Optional.of(mock(UserDto.class)));
        when(memberRepository.listMembersByOrgUnit(deptId)).thenReturn(List.of());

        service.addMembers(deptId, new AddOrgUnitMembersRequest(List.of(userId, userId)), UUID.randomUUID());

        // 同一 id 重复传入只入一次(幂等)
        verify(memberRepository).insert(deptId, userId);
    }

    @Test
    void addMembersRejectsUnknownUser() {
        UUID deptId = UUID.randomUUID();
        when(orgUnitRepository.findById(deptId)).thenReturn(
            Optional.of(unit(deptId, "A 部门", null, null)));
        when(userRepository.findById(any())).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.addMembers(
                deptId, new AddOrgUnitMembersRequest(List.of(UUID.randomUUID())), UUID.randomUUID()))
            .isInstanceOf(NotFoundException.class)
            .hasMessageContaining("用户不存在");
    }

    @Test
    void removeMemberRejectsHead() {
        // 决策 12:负责人必然有本部门归属,先更换负责人再移出
        UUID deptId = UUID.randomUUID();
        UUID headUserId = UUID.randomUUID();
        when(orgUnitRepository.findById(deptId)).thenReturn(
            Optional.of(unit(deptId, "A 部门", null, headUserId)));

        assertThatThrownBy(() -> service.removeMember(deptId, headUserId, UUID.randomUUID()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("负责人")
            .hasMessageContaining("先更换");
        verify(memberRepository, never()).deleteMember(any(), any());
    }

    @Test
    void removeMemberDeletesAndReturnsRemainingList() {
        UUID deptId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        when(orgUnitRepository.findById(deptId)).thenReturn(
            Optional.of(unit(deptId, "A 部门", null, null)));
        when(memberRepository.listMembersByOrgUnit(deptId)).thenReturn(List.of());

        service.removeMember(deptId, userId, UUID.randomUUID());

        verify(memberRepository).deleteMember(deptId, userId);
    }

    @Test
    void positionsForUserComputesPathToRoot() {
        UUID rootId = UUID.randomUUID();
        UUID regionId = UUID.randomUUID();
        UUID deptId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        when(orgUnitRepository.list()).thenReturn(List.of(
            unit(rootId, "总公司", null, null),
            unit(regionId, "华东区", rootId, null),
            unit(deptId, "A 部门", regionId, null)));
        when(memberRepository.listByUser(userId)).thenReturn(List.of(
            new UserOrgUnitDto(deptId, "A 部门")));

        List<OrgPositionDto> positions = service.positionsForUser(userId);

        assertThat(positions).hasSize(1);
        assertThat(positions.get(0).orgUnitId()).isEqualTo(deptId);
        assertThat(positions.get(0).orgUnitName()).isEqualTo("A 部门");
        assertThat(positions.get(0).pathToRoot()).containsExactly("总公司", "华东区", "A 部门");
    }

    @Test
    void treeTreatsNullParentAsRootWithoutFailing() {
        // 回归:根部门 parentId=null,groupingBy(null key) 曾抛 NPE(element cannot be mapped to a null key)
        UUID rootId = UUID.randomUUID();
        UUID deptId = UUID.randomUUID();
        when(orgUnitRepository.list()).thenReturn(List.of(
            unit(rootId, "总公司", null, null),
            unit(deptId, "A 部门", rootId, null)));
        when(userRepository.findNamesByIds(any())).thenReturn(Map.of());

        List<OrgUnitTreeNode> tree = service.tree();

        assertThat(tree).hasSize(1);
        assertThat(tree.get(0).id()).isEqualTo(rootId);
        assertThat(tree.get(0).parentId()).isNull();
        assertThat(tree.get(0).children()).hasSize(1);
        assertThat(tree.get(0).children().get(0).id()).isEqualTo(deptId);
    }

    private static OrgUnitDto unit(UUID id, String name, UUID parentId, UUID headUserId) {
        return new OrgUnitDto(id, name, parentId, headUserId, 0, OffsetDateTime.now());
    }
}
