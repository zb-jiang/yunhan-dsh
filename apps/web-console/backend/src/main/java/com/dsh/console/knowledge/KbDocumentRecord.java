package com.dsh.console.knowledge;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * {@code kb_documents} 行的进程内表示(含全文与 storage_path,不出服务层;
 * 对外一律经 {@link com.dsh.console.knowledge.dto.KbDocumentDto} 摘要化)。
 *
 * @param id             文档 id
 * @param kbId           所属知识库
 * @param folderId       所在文件夹(null = 根)
 * @param name           文档名
 * @param contentType    MIME 类型
 * @param sizeBytes      文件大小
 * @param storagePath    本地存储根目录内的相对路径({appId}/{docId}/document{ext})
 * @param textContent    抽取/OCR 全文(未解析或无文本时为 null)
 * @param parseStatus    pending / ready / failed
 * @param parseError     解析失败原因
 * @param chunkMaxSize   单 chunk 最大字符数(setup guide §3.3.1 第 6 步)
 * @param chunkOverlap   相邻 chunk 重叠字符数
 * @param chunkSeparator 优先切分的分隔符
 * @param uploadedBy     上传者(Supabase Auth user.id)
 * @param createdAt      上传时间
 * @param updatedAt      最近更新时间
 */
public record KbDocumentRecord(
    UUID id,
    UUID kbId,
    UUID folderId,
    String name,
    String contentType,
    long sizeBytes,
    String storagePath,
    String textContent,
    String parseStatus,
    String parseError,
    int chunkMaxSize,
    int chunkOverlap,
    String chunkSeparator,
    String uploadedBy,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt
) {
}
