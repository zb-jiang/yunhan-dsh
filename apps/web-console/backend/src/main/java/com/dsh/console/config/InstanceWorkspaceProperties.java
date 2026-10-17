package com.dsh.console.config;

import java.nio.file.Path;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 流程实例云工作空间配置(设计 docs/plans/2026-10-14-instance-workspace-design.md §3.3)。
 *
 * <p>绑定 yaml {@code dsh.instance-workspace.*};绑定期 fail-loud 校验非法值。
 * <p>单文件上限的实际硬顶是 {@code spring.servlet.multipart.max-file-size}
 * (KB_MAX_UPLOAD_MB,默认 64MB,与 max-file-mb 默认对齐)——超过硬顶的请求在进入
 * 业务逻辑前即被 multipart 解析拒绝并映射 400 FILE_TOO_LARGE,实际生效上限取两者较小值。
 */
@ConfigurationProperties(prefix = "dsh.instance-workspace")
public record InstanceWorkspaceProperties(
    String root,
    Integer maxFileMb,
    Integer maxInstanceTotalMb,
    Integer maxEntries,
    Integer participantCacheTtlSeconds
) {

    public InstanceWorkspaceProperties {
        if (root == null || root.isBlank()) {
            throw new IllegalStateException(
                "dsh.instance-workspace.root 未配置:请设置 INSTANCE_WORKSPACE_ROOT(实例空间磁盘根目录,"
                    + "相对路径相对 web-console 启动目录解析)");
        }
        if (maxFileMb == null || maxFileMb <= 0) {
            throw new IllegalStateException(
                "dsh.instance-workspace.max-file-mb 非法:必须为正整数(单文件上限 MB)");
        }
        if (maxInstanceTotalMb == null || maxInstanceTotalMb <= 0) {
            throw new IllegalStateException(
                "dsh.instance-workspace.max-instance-total-mb 非法:必须为正整数(单实例总量上限 MB)");
        }
        if (maxEntries == null || maxEntries <= 0) {
            throw new IllegalStateException(
                "dsh.instance-workspace.max-entries 非法:必须为正整数(单实例文件数上限)");
        }
        // 运行中实例可能有新办理人接单,缓存过期后重查引擎自愈;未配置给默认 60 秒
        if (participantCacheTtlSeconds == null) {
            participantCacheTtlSeconds = 60;
        }
        if (participantCacheTtlSeconds <= 0) {
            throw new IllegalStateException(
                "dsh.instance-workspace.participant-cache-ttl-seconds 非法:必须为正整数"
                    + "(运行中实例参与人缓存 TTL 秒)");
        }
    }

    /** 磁盘根目录 Path(相对路径相对启动目录解析)。 */
    public Path rootPath() {
        return Path.of(root);
    }

    /** 单文件上限字节数。 */
    public long maxFileBytes() {
        return maxFileMb * 1024L * 1024L;
    }

    /** 单实例总用量上限字节数。 */
    public long maxInstanceTotalBytes() {
        return maxInstanceTotalMb * 1024L * 1024L;
    }

    /** 运行中实例参与人缓存 TTL 毫秒数(已结束实例长缓存,不受此值限制)。 */
    public long participantCacheTtlMillis() {
        return participantCacheTtlSeconds * 1000L;
    }
}
