package com.dsh.console.pocket.dto;

import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * 批量访问审计上报请求(pocket-access-design §7.3)。
 *
 * @param events 事件批(1..100 条)
 */
public record AccessEventsRequest(
    @NotEmpty @Size(max = 100)
    List<PocketAccessEventDto> events
) {
}
