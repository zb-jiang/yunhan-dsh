package com.dsh.console.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.knowledge.dto.BackendKbResolveDto;
import com.dsh.console.knowledge.dto.KnowledgeBaseDto;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@link BackendKbController} 服务身份端点:resolve 按 published_procdef_id 直查、
 * miss 时按 BPMN key 段回退;应用未开通知识库 404;检索/全文直通服务变体。
 */
class BackendKbControllerTest {

    private static final UUID APP_ID = UUID.randomUUID();
    private static final UUID KB_ID = UUID.randomUUID();

    private final KnowledgeService knowledgeService = mock(KnowledgeService.class);
    private final WorkflowDefinitionJdbcRepository workflowRepository =
        mock(WorkflowDefinitionJdbcRepository.class);
    private final BackendKbController controller =
        new BackendKbController(knowledgeService, workflowRepository);

    private KnowledgeBaseDto kb;

    @BeforeEach
    void setUp() {
        kb = new KnowledgeBaseDto(KB_ID, APP_ID, "差旅工程知识库", OffsetDateTime.now());
    }

    private WorkflowDefinitionDto definition(UUID appId) {
        return new WorkflowDefinitionDto(UUID.randomUUID(), appId, "报销流程", null, "published",
            null, null, null, null, "expense_flow", OffsetDateTime.now(), null,
            OffsetDateTime.now(), null);
    }

    @Test
    void resolveByProcdefIdDirectHit() {
        String procdefId = "expense_flow:3:" + UUID.randomUUID();
        when(workflowRepository.findByProcdefId(procdefId)).thenReturn(Optional.of(definition(APP_ID)));
        when(knowledgeService.findKbByAppForService(APP_ID)).thenReturn(Optional.of(kb));

        BackendKbResolveDto result = controller.resolve(procdefId).data();

        assertThat(result.kbId()).isEqualTo(KB_ID);
        assertThat(result.kbName()).isEqualTo("差旅工程知识库");
    }

    @Test
    void resolveFallsBackToBpmnKeyWhenProcdefMiss() {
        String procdefId = "expense_flow:2:" + UUID.randomUUID();
        when(workflowRepository.findByProcdefId(procdefId)).thenReturn(Optional.empty());
        when(workflowRepository.findByBpmnProcessKey("expense_flow"))
            .thenReturn(Optional.of(definition(APP_ID)));
        when(knowledgeService.findKbByAppForService(APP_ID)).thenReturn(Optional.of(kb));

        BackendKbResolveDto result = controller.resolve(procdefId).data();

        assertThat(result.kbId()).isEqualTo(KB_ID);
    }

    @Test
    void resolveThrowsNotFoundWhenAppHasNoKb() {
        String procdefId = "expense_flow:3:" + UUID.randomUUID();
        when(workflowRepository.findByProcdefId(procdefId)).thenReturn(Optional.of(definition(APP_ID)));
        when(knowledgeService.findKbByAppForService(APP_ID)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> controller.resolve(procdefId))
            .isInstanceOf(NotFoundException.class)
            .hasMessageContaining("未开通知识库");
    }

    @Test
    void resolveThrowsNotFoundWhenWorkflowUnknown() {
        when(workflowRepository.findByProcdefId("ghost_flow:1:x")).thenReturn(Optional.empty());
        when(workflowRepository.findByBpmnProcessKey("ghost_flow")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> controller.resolve("ghost_flow:1:x"))
            .isInstanceOf(NotFoundException.class);
    }

    @Test
    void readEndpointsDelegateToServiceVariants() {
        UUID kbId = UUID.randomUUID();
        UUID docId = UUID.randomUUID();
        when(knowledgeService.listFoldersForService(kbId)).thenReturn(List.of());
        when(knowledgeService.listDocumentsForService(eq(kbId), eq(null), anyBoolean(), eq(null), eq(null)))
            .thenReturn(List.of());

        controller.listFolders(kbId);
        controller.listDocuments(kbId, null, false, null, null);

        verify(knowledgeService).listFoldersForService(kbId);
        verify(knowledgeService).listDocumentsForService(kbId, null, false, null, null);
    }

    @Test
    void searchDelegatesToServiceVariant() {
        UUID kbId = UUID.randomUUID();
        when(knowledgeService.searchChunksForService(kbId, "报销标准", null, null)).thenReturn(List.of());

        controller.search(kbId, "报销标准", null, null);

        verify(knowledgeService).searchChunksForService(kbId, "报销标准", null, null);
    }
}
