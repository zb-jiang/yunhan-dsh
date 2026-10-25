package com.dsh.console.knowledge.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 知识库(一个应用一个库,local-pg-setup-guide §3.3 {@code knowledge_bases} 表)。
 *
 * @param id            知识库 id
 * @param applicationId 所属应用
 * @param name          名称(默认「{应用名} 知识库」)
 * @param createdAt     创建时间
 */
public record KnowledgeBaseDto(
    UUID id,
    UUID applicationId,
    String name,
    OffsetDateTime createdAt
) {
}
