package com.dsh.console.instanceworkspace;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * 实例空间元数据表 {@code public.instance_workspace_files}(setup guide 建表,设计 §3.2)
 * 的数据访问。磁盘文件是事实源,本表供列表快查、配额求和与应用归属缓存。
 *
 * <p>连接角色为 postgres(表 owner),不受 RLS 限制,写权限由服务层校验兜底。
 */
@Repository
public class InstanceWorkspaceJdbcRepository {

    private final JdbcClient jdbcClient;

    public InstanceWorkspaceJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /** 元数据行,对应表列;{@code applicationId} 为实例归属缓存。 */
    public record FileRow(
        UUID id,
        String instanceId,
        UUID applicationId,
        String relPath,
        long sizeBytes,
        String contentType,
        String uploadedBy,
        String uploadedByLabel,
        String sourceTaskId,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt
    ) {
    }

    private static final RowMapper<FileRow> ROW_MAPPER = (rs, rowNum) -> new FileRow(
        rs.getObject("id", UUID.class),
        rs.getString("instance_id"),
        rs.getObject("application_id", UUID.class),
        rs.getString("rel_path"),
        rs.getLong("size_bytes"),
        rs.getString("content_type"),
        rs.getString("uploaded_by"),
        rs.getString("uploaded_by_label"),
        rs.getString("source_task_id"),
        rs.getObject("created_at", OffsetDateTime.class),
        rs.getObject("updated_at", OffsetDateTime.class));

    private static final String SELECT_COLUMNS = """
            id, instance_id, application_id, rel_path, size_bytes, content_type,
            uploaded_by, uploaded_by_label, source_task_id, created_at, updated_at
        """;

    /**
     * 实例归属缓存:任取该实例一行读 application_id(UNIQUE 约束保证同实例归属一致)。
     */
    public Optional<UUID> findApplicationIdByInstance(String instanceId) {
        return jdbcClient.sql("""
                SELECT application_id FROM public.instance_workspace_files
                WHERE instance_id = :instanceId
                LIMIT 1
                """)
            .param("instanceId", instanceId)
            .query((rs, rowNum) -> rs.getObject("application_id", UUID.class))
            .optional();
    }

    /** 列实例全部文件(设计 §4.1:全量列表,量级受 max-entries 配置约束)。 */
    public List<FileRow> listByInstance(String instanceId) {
        return jdbcClient.sql("""
                SELECT %s FROM public.instance_workspace_files
                WHERE instance_id = :instanceId
                ORDER BY rel_path
                """.formatted(SELECT_COLUMNS))
            .param("instanceId", instanceId)
            .query(ROW_MAPPER)
            .list();
    }

    /** 按路径取单行。 */
    public Optional<FileRow> findByPath(String instanceId, String relPath) {
        return jdbcClient.sql("""
                SELECT %s FROM public.instance_workspace_files
                WHERE instance_id = :instanceId AND rel_path = :relPath
                """.formatted(SELECT_COLUMNS))
            .param("instanceId", instanceId)
            .param("relPath", relPath)
            .query(ROW_MAPPER)
            .optional();
    }

    /**
     * 写入/覆盖(upsert):新文件插入并缓存归属;同 relPath 覆盖更新大小/类型/上传人与
     * 来源节点,created_at 保持首次写入时间。先落盘成功后才调用。
     */
    public FileRow upsert(String instanceId, UUID applicationId, String relPath, long sizeBytes,
                          String contentType, String uploadedBy, String uploadedByLabel,
                          String sourceTaskId) {
        return jdbcClient.sql("""
                INSERT INTO public.instance_workspace_files
                    (instance_id, application_id, rel_path, size_bytes, content_type,
                     uploaded_by, uploaded_by_label, source_task_id)
                VALUES (:instanceId, :appId, :relPath, :sizeBytes, :contentType,
                        :uploadedBy, :uploadedByLabel, :sourceTaskId)
                ON CONFLICT (instance_id, rel_path) DO UPDATE SET
                    size_bytes = EXCLUDED.size_bytes,
                    content_type = EXCLUDED.content_type,
                    uploaded_by = EXCLUDED.uploaded_by,
                    uploaded_by_label = EXCLUDED.uploaded_by_label,
                    source_task_id = EXCLUDED.source_task_id,
                    updated_at = now()
                RETURNING %s
                """.formatted(SELECT_COLUMNS))
            .param("instanceId", instanceId)
            .param("appId", applicationId)
            .param("relPath", relPath)
            .param("sizeBytes", sizeBytes)
            .param("contentType", contentType)
            .param("uploadedBy", uploadedBy)
            .param("uploadedByLabel", uploadedByLabel)
            .param("sourceTaskId", sourceTaskId)
            .query(ROW_MAPPER)
            .single();
    }

    /** 删除单行(先删行再删盘);返回是否有行被删。 */
    public boolean delete(String instanceId, String relPath) {
        return jdbcClient.sql("""
                DELETE FROM public.instance_workspace_files
                WHERE instance_id = :instanceId AND rel_path = :relPath
                """)
            .param("instanceId", instanceId)
            .param("relPath", relPath)
            .update() > 0;
    }

    /** 实例用量求和(配额校验;无行为 0)。 */
    public long totalBytes(String instanceId) {
        Long total = jdbcClient.sql("""
                SELECT COALESCE(SUM(size_bytes), 0) FROM public.instance_workspace_files
                WHERE instance_id = :instanceId
                """)
            .param("instanceId", instanceId)
            .query(Long.class)
            .single();
        return total == null ? 0L : total;
    }

    /** 实例文件行数(文件数配额校验)。 */
    public long countByInstance(String instanceId) {
        return jdbcClient.sql("""
                SELECT COUNT(*) FROM public.instance_workspace_files
                WHERE instance_id = :instanceId
                """)
            .param("instanceId", instanceId)
            .query(Long.class)
            .single();
    }

    /**
     * 当前用户是否为应用 active 成员(口径与 RLS 一致,与 KnowledgeJdbcRepository 同源)。
     */
    public boolean isActiveMember(UUID appId, String authSubject) {
        return Boolean.TRUE.equals(jdbcClient.sql("""
                SELECT EXISTS (
                  SELECT 1 FROM public.app_memberships m
                  JOIN public.platform_users pu ON pu.id = m.user_id
                  WHERE m.app_id = :appId AND m.status = 'active'
                    AND pu.status = 'active' AND pu.auth_subject = :authSubject
                )
                """)
            .param("appId", appId)
            .param("authSubject", authSubject)
            .query(Boolean.class)
            .single());
    }
}
