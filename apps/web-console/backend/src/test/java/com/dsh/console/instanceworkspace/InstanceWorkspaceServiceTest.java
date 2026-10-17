package com.dsh.console.instanceworkspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.audit.AuditService;
import com.dsh.console.config.InstanceWorkspaceProperties;
import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.security.AuthContext;
import com.dsh.console.security.PlatformRole;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;

/**
 * 实例参与人鉴权闸门测试(设计 docs/plans/2026-10-14-instance-workspace-design.md
 * §1.3,2026-10-17 修订):员工面两级闸门第二级,参与人=发起人+历任/现任办理人
 * +两级管理员。覆盖:非参与人 403、发起人(startUserId 与 dsh_applicant_user_id
 * 变量回退两条路)、办理人(含会签未办理收没人,deleteReason 非空不过滤)、
 * system_admin/应用管理员直通不触发引擎调用、进程内缓存命中后同一实例只查一次引擎。
 */
class InstanceWorkspaceServiceTest {

    private static final String INSTANCE = "inst-1";
    private static final String XIAOWANG = "user-xiaowang";
    private static final String ZHANGSAN = "user-zhangsan";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private InstanceWorkspaceJdbcRepository repository;
    private ApplicationJdbcRepository appRepository;
    private FlowableRestClient flowableRestClient;
    private InstanceWorkspaceService service;

    @BeforeEach
    void setUp() {
        repository = mock(InstanceWorkspaceJdbcRepository.class);
        appRepository = mock(ApplicationJdbcRepository.class);
        flowableRestClient = mock(FlowableRestClient.class);
        service = new InstanceWorkspaceService(
            new InstanceWorkspaceProperties("./build/instance-workspace-test", 64, 512, 2000, 60),
            repository, flowableRestClient, mock(WorkflowDefinitionJdbcRepository.class),
            appRepository, mock(AuditService.class));
    }

    @Test
    void nonParticipantGets403() {
        UUID appId = UUID.randomUUID();
        mockMemberAccess(appId, ZHANGSAN);
        stubEngineParticipants(historicInstance(null), variables(null), tasks(XIAOWANG));

        assertThatThrownBy(() -> service.list(auth(ZHANGSAN), INSTANCE))
            .isInstanceOf(AccessDeniedException.class)
            .hasMessageContaining("您不是该流程实例的参与人");
    }

    @Test
    void starterAllowedViaStartUserId() {
        UUID appId = UUID.randomUUID();
        mockMemberAccess(appId, XIAOWANG);
        stubEngineParticipants(historicInstance(XIAOWANG), variables(null), tasks());

        assertThat(service.list(auth(XIAOWANG), INSTANCE)).isEmpty();
    }

    @Test
    void starterAllowedViaApplicantVariableFallback() {
        // REST 启动的生产实例不写 flowable startUserId,回退历史变量 dsh_applicant_user_id
        UUID appId = UUID.randomUUID();
        mockMemberAccess(appId, XIAOWANG);
        stubEngineParticipants(historicInstance(null), variables(XIAOWANG), tasks());

        assertThat(service.list(auth(XIAOWANG), INSTANCE)).isEmpty();
    }

    @Test
    void assigneeAllowed() {
        UUID appId = UUID.randomUUID();
        mockMemberAccess(appId, ZHANGSAN);
        stubEngineParticipants(historicInstance(null), variables(null), tasks(XIAOWANG, ZHANGSAN));

        assertThat(service.list(auth(ZHANGSAN), INSTANCE)).isEmpty();
    }

    @Test
    void countersignReceiverWithoutSubmissionCounted() {
        // 会签提前收工时其余待办被引擎自动删除,历史任务仍留 assignee(deleteReason 非空),计入参与人
        UUID appId = UUID.randomUUID();
        mockMemberAccess(appId, XIAOWANG);
        JsonNode receivedButDeleted = tasksWithDeleteReason(XIAOWANG, "多实例完成条件已满足,待办自动删除");
        stubEngineParticipants(historicInstance(null), variables(null), receivedButDeleted);

        assertThat(service.list(auth(XIAOWANG), INSTANCE)).isEmpty();
    }

    @Test
    void systemAdminBypassesEngineCalls() {
        UUID appId = UUID.randomUUID();
        when(repository.findApplicationIdByInstance(INSTANCE)).thenReturn(Optional.of(appId));

        assertThat(service.list(authWithUser(UUID.randomUUID(), ZHANGSAN,
            List.of(PlatformRole.SYSTEM_ADMIN)), INSTANCE)).isEmpty();
        verify(flowableRestClient, never()).getHistoricProcessInstance(any());
    }

    @Test
    void appAdminBypassesEngineCalls() {
        UUID adminUserId = UUID.randomUUID();
        UUID appId = UUID.randomUUID();
        when(repository.findApplicationIdByInstance(INSTANCE)).thenReturn(Optional.of(appId));
        when(appRepository.findById(appId)).thenReturn(Optional.of(app(appId, adminUserId)));

        assertThat(service.list(authWithUser(adminUserId, ZHANGSAN, List.of()), INSTANCE))
            .isEmpty();
        verify(flowableRestClient, never()).getHistoricProcessInstance(any());
    }

    @Test
    void participantCacheHitAvoidsRepeatedEngineQueries() {
        UUID appId = UUID.randomUUID();
        mockMemberAccess(appId, XIAOWANG);
        stubEngineParticipants(historicInstance(null), variables(null), tasks(XIAOWANG));

        assertThat(service.list(auth(XIAOWANG), INSTANCE)).isEmpty();
        // 缓存 TTL 内:办理人放行与第三人 403 都复用同一份参与人集合,引擎只查一次
        assertThat(service.list(auth(XIAOWANG), INSTANCE)).isEmpty();
        assertThatThrownBy(() -> service.list(auth(ZHANGSAN), INSTANCE))
            .isInstanceOf(AccessDeniedException.class);
        verify(flowableRestClient, times(1)).getHistoricProcessInstance(INSTANCE);
        verify(flowableRestClient, times(1)).listHistoricTasks(INSTANCE);
    }

    // ---------- 桩与构造 ----------

    private void mockMemberAccess(UUID appId, String subject) {
        when(repository.findApplicationIdByInstance(INSTANCE)).thenReturn(Optional.of(appId));
        when(repository.isActiveMember(appId, subject)).thenReturn(true);
    }

    private void stubEngineParticipants(JsonNode historic, JsonNode variables, JsonNode tasks) {
        when(flowableRestClient.getHistoricProcessInstance(INSTANCE)).thenReturn(historic);
        when(flowableRestClient.listHistoricVariables(INSTANCE)).thenReturn(variables);
        when(flowableRestClient.listHistoricTasks(INSTANCE)).thenReturn(tasks);
    }

    /** 历史实例桩;startUserId 传 null 表示字段缺失(模拟 REST 启动的生产实例)。 */
    private static JsonNode historicInstance(String startUserId) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("processDefinitionId", "proc:1:uuid");
        if (startUserId != null) {
            node.put("startUserId", startUserId);
        }
        return node;
    }

    /** 历史变量桩;applicantId 传 null 表示无发起人变量。 */
    private static JsonNode variables(String applicantId) {
        ArrayNode array = MAPPER.createArrayNode();
        if (applicantId != null) {
            ObjectNode variable = array.addObject();
            variable.put("variableName", "dsh_applicant_user_id");
            variable.put("value", applicantId);
        }
        return array;
    }

    /** 历史任务桩:每个 assignee 一条(deleteReason 为空=正常办理)。 */
    private static JsonNode tasks(String... assignees) {
        ArrayNode array = MAPPER.createArrayNode();
        for (String assignee : assignees) {
            ObjectNode task = array.addObject();
            if (assignee != null) {
                task.put("assignee", assignee);
            }
        }
        return array;
    }

    /** 会签未办理收没人场景:历史任务带非空 deleteReason(引擎自动删除),assignee 保留。 */
    private static JsonNode tasksWithDeleteReason(String assignee, String deleteReason) {
        ArrayNode array = MAPPER.createArrayNode();
        ObjectNode task = array.addObject();
        task.put("assignee", assignee);
        task.put("deleteReason", deleteReason);
        return array;
    }

    private static AuthContext auth(String authSubject) {
        return authWithUser(UUID.randomUUID(), authSubject, List.of());
    }

    private static AuthContext authWithUser(UUID platformUserId, String authSubject,
                                            List<String> roles) {
        return new AuthContext(platformUserId, authSubject, "a@b.c", "login", "显示名", roles);
    }

    private static ApplicationDto app(UUID appId, UUID adminUserId) {
        return new ApplicationDto(appId, "测试应用", null, null, null, "active",
            List.of(adminUserId), OffsetDateTime.now(), null, null, null);
    }
}
