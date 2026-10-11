package com.dsh.console.pocket;

import com.dsh.console.audit.AuditService;
import com.dsh.console.common.ApiResponse;
import com.dsh.console.pocket.dto.AccessEventsRequest;
import com.dsh.console.pocket.dto.PocketAccessEventDto;
import com.dsh.console.security.AuthContext;
import jakarta.validation.Valid;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 员工 PC pocket 插件的访问审计上报端点(pocket-access-design §7.3 M2)。
 *
 * <p>员工 DSH 的 pocket-access 插件携员工 JWT 批量上报访问事件(≤100 条/批)；
 * 逐条落 public.audit_events(eventType/targetType=pocket_device/targetUserId/operator=上报人)。
 * 事件类型全集须与员工端 packages/enterprise/pocket-access/src/audit.ts 的
 * POCKET_AUDIT_EVENT_TYPES 保持一致。
 */
@RestController
@RequestMapping("/api/pocket")
@PreAuthorize("isAuthenticated()")
public class PocketAccessController {

    /** 合法事件类型全集(与员工端 audit.ts POCKET_AUDIT_EVENT_TYPES 对齐)。 */
    private static final Set<String> EVENT_TYPES = Set.of(
        "POCKET_ENABLED",
        "POCKET_DISABLED",
        "POCKET_DEVICE_PAIRED",
        "POCKET_DEVICE_REVOKED",
        "POCKET_IDENTITY_REJECTED",
        "POCKET_TUNNEL_STARTED",
        "POCKET_TUNNEL_STOPPED",
        "POCKET_LAN_DISABLED_HIT");

    private final AuditService auditService;

    public PocketAccessController(AuditService auditService) {
        this.auditService = auditService;
    }

    /**
     * 批量上报访问审计事件。
     *
     * @param body 事件批(≤100 条,契约见 §7.3)
     * @param auth 上报员工治理上下文(JWT 验证后构造)
     * @return accepted: 实际接收条数
     */
    @PostMapping("/access-events")
    public ApiResponse<Map<String, Integer>> report(
        @Valid @RequestBody AccessEventsRequest body,
        @AuthenticationPrincipal AuthContext auth) {
        int accepted = 0;
        for (PocketAccessEventDto event : body.events()) {
            if (!EVENT_TYPES.contains(event.eventType())) {
                throw new IllegalArgumentException("未知审计事件类型: " + event.eventType());
            }
            Map<String, Object> details = new HashMap<>(event.details());
            if (event.occurredAt() != null) {
                details.putIfAbsent("occurredAt", event.occurredAt());
            }
            auditService.record(
                event.eventType(),
                "pocket_device",
                parseUuidOrNull(event.targetUserId()),
                auth.platformUserId(),
                details);
            accepted++;
        }
        return ApiResponse.ok(Map.of("accepted", accepted));
    }

    /**
     * 解析可选的 UUID 字段;非法值是上报方契约违规,400 fail loud。
     */
    private static UUID parseUuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("targetUserId 不是合法 UUID: " + value, e);
        }
    }
}
