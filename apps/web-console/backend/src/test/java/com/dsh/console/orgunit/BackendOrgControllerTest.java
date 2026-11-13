package com.dsh.console.orgunit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.orgunit.dto.BackendOrgUnitMemberDto;
import com.dsh.console.orgunit.dto.OrgUnitTreeNode;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * {@link BackendOrgController} 服务身份端点:树/成员直通 {@link OrgUnitService}
 * 服务变体,响应形状对齐员工端;部门不存在 404 透传。
 */
class BackendOrgControllerTest {

    private static final UUID ORG_UNIT_ID = UUID.randomUUID();

    private final OrgUnitService orgUnitService = mock(OrgUnitService.class);
    private final BackendOrgController controller = new BackendOrgController(orgUnitService);

    @Test
    void treeDelegatesToServiceTree() {
        OrgUnitTreeNode node = new OrgUnitTreeNode(ORG_UNIT_ID, "教学服务部", null,
            null, null, 0, List.of());
        when(orgUnitService.tree()).thenReturn(List.of(node));

        List<OrgUnitTreeNode> result = controller.tree().data();

        assertThat(result).containsExactly(node);
        verify(orgUnitService).tree();
    }

    @Test
    void membersDelegateToServiceVariant() {
        BackendOrgUnitMemberDto member = new BackendOrgUnitMemberDto(UUID.randomUUID(),
            "zhangsan", "张三", "active", "auth0|abc123");
        when(orgUnitService.membersForService(ORG_UNIT_ID)).thenReturn(List.of(member));

        List<BackendOrgUnitMemberDto> result = controller.members(ORG_UNIT_ID).data();

        assertThat(result).containsExactly(member);
        assertThat(result.get(0).userId()).isNotNull();
        assertThat(result.get(0).authSubject()).isEqualTo("auth0|abc123");
        verify(orgUnitService).membersForService(ORG_UNIT_ID);
    }

    @Test
    void membersPropagatesNotFoundForUnknownUnit() {
        when(orgUnitService.membersForService(ORG_UNIT_ID))
            .thenThrow(new NotFoundException("部门不存在"));

        assertThatThrownBy(() -> controller.members(ORG_UNIT_ID))
            .isInstanceOf(NotFoundException.class);
    }
}
