package com.dsh.console.instanceworkspace.dto;

import java.time.OffsetDateTime;

/**
 * 实例空间文件元数据(设计 §4.1)。列表与写操作的响应载荷。
 *
 * <p>{@code diskMissing} 为 true 表示元数据行存在但磁盘文件缺失(两侧不一致以
 * 磁盘为准):该文件按不存在处理,下载/删除会 404,列表中标记供调用方辨识。
 *
 * @param relPath          相对路径(/ 分隔)
 * @param sizeBytes        文件字节数
 * @param contentType      内容类型(可空)
 * @param uploadedByLabel  上传人显示名快照(员工 displayName / 'dsh-service')
 * @param sourceTaskId     写入来源节点 id(可空)
 * @param createdAt        首次写入时间
 * @param updatedAt        最近覆盖时间
 * @param diskMissing      磁盘文件是否缺失
 */
public record InstanceWorkspaceFileDto(
    String relPath,
    long sizeBytes,
    String contentType,
    String uploadedByLabel,
    String sourceTaskId,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt,
    boolean diskMissing
) {
}
