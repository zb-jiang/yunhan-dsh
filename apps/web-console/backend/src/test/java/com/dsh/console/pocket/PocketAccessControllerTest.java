package com.dsh.console.pocket;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import com.dsh.console.audit.AuditService;
import com.dsh.console.common.ApiResponse;
import com.dsh.console.pocket.dto.AccessEventsRequest;
import com.dsh.console.pocket.dto.PocketAccessEventDto;
import com.dsh.console.security.AuthContext;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * {@link PocketAccessController} 上报契约:事件类型白名单外的 400、逐条 record
 * 参数映射(targetType=pocket_device/operator=上报人/occurredAt 并入 details)、
 * 返回 accepted 计数。
 */
class PocketAccessControllerTest {

    private final AuditService auditService = mock(AuditService.class);
    private final PocketAccessController controller = new PocketAccessController(auditService);

    private final AuthContext auth = new AuthContext(
        UUID.randomUUID(), UUID.randomUUID().toString(), "e@corp.com", "emp", "员工", List.of());

    @Test
    void reportRecordsEachEventWithPocketDeviceTargetType() {
        PocketAccessEventDto event = new PocketAccessEventDto(
            "POCKET_DEVICE_PAIRED", null, Map.of("deviceId", "dev-1", "source", "lan"), 1_700_000_000_000L);

        ApiResponse<Map<String, Integer>> response =
            controller.report(new AccessEventsRequest(List.of(event)), auth);

        verify(auditService).record(
            eq("POCKET_DEVICE_PAIRED"),
            eq("pocket_device"),
            eq(null),
            eq(auth.platformUserId()),
            eq(Map.of("deviceId", "dev-1", "source", "lan", "occurredAt", 1_700_000_000_000L)));
        assertThat(response.data()).containsEntry("accepted", 1);
    }

    @Test
    void reportAcceptsBatchAndCountsAccepted() {
        List<PocketAccessEventDto> events = List.of(
            new PocketAccessEventDto("POCKET_ENABLED", null, Map.of(), null),
            new PocketAccessEventDto("POCKET_TUNNEL_STARTED", null, Map.of("mode", "quick"), null));

        ApiResponse<Map<String, Integer>> response =
            controller.report(new AccessEventsRequest(events), auth);

        assertThat(response.data()).containsEntry("accepted", 2);
        verify(auditService, times(2)).record(any(), any(), any(), any(), any());
    }

    @Test
    void reportRejectsUnknownEventType() {
        PocketAccessEventDto event = new PocketAccessEventDto("NOT_A_TYPE", null, Map.of(), null);
        assertThatThrownBy(() -> controller.report(new AccessEventsRequest(List.of(event)), auth))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("NOT_A_TYPE");
    }

    @Test
    void reportRejectsInvalidTargetUserId() {
        PocketAccessEventDto event = new PocketAccessEventDto("POCKET_ENABLED", "not-a-uuid", Map.of(), null);
        assertThatThrownBy(() -> controller.report(new AccessEventsRequest(List.of(event)), auth))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("not-a-uuid");
    }

    @Test
    void reportKeepsExplicitTargetUserId() {
        UUID targetId = UUID.randomUUID();
        PocketAccessEventDto event = new PocketAccessEventDto(
            "POCKET_DEVICE_REVOKED", targetId.toString(), Map.of("deviceId", "dev-1"), null);

        controller.report(new AccessEventsRequest(List.of(event)), auth);

        verify(auditService).record(
            eq("POCKET_DEVICE_REVOKED"), eq("pocket_device"), eq(targetId),
            eq(auth.platformUserId()), eq(Map.of("deviceId", "dev-1")));
    }
}
