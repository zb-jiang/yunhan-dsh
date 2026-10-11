package com.dsh.console.pocket.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.Map;

/**
 * 单条访问审计事件(pocket-access-design §6.7/§7.3)。
 *
 * @param eventType    事件类型(合法全集见 PocketAccessController EVENT_TYPES)
 * @param targetUserId 事件主体 platform_users.id(可空;缺省表示事件主体=上报员工本人)
 * @param details      事件细节要点(必填对象,如 deviceId/ip/reason)
 * @param occurredAt   员工端本地发生时刻 epoch 毫秒(可空;并入 details 保留)
 */
public record PocketAccessEventDto(
    @NotBlank
    String eventType,
    String targetUserId,
    @NotNull
    Map<String, Object> details,
    Long occurredAt
) {
}
