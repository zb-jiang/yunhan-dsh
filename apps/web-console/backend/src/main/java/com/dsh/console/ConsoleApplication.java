package com.dsh.console;

import com.dsh.console.config.SsoAuthProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * DSH Web Console 后端启动类。
 *
 * <p>独立 Spring Boot 服务,职责:
 * <ul>
 *   <li>JWT 本地验证(直连 Supabase Auth 拿 JWT 后由本服务用 Supabase JWT Secret 验签)。</li>
 *   <li>JDBC 直连 Postgres {@code public} schema,CRUD 治理元数据(platform_users / applications /
 *       app_roles / app_memberships / workflow_definitions / audit_events)。</li>
 *   <li>调 Flowable 引擎 REST 部署 BPMN / 发起实例 / 查任务 / 管理员干预。</li>
 *   <li>所有写操作经 {@link com.dsh.console.audit.AuditAdvice} 切面写审计事件。</li>
 *   <li>分析看板(设计 2026-09-25):定时轮询引擎 {@code /actuator/metrics} 落
 *       {@code dsh_metrics_sample} 表 + 每日过期清理({@code @EnableScheduling})。</li>
 * </ul>
 *
 * <p>{@link ConfigurationPropertiesScan} 扫描 {@link SsoAuthProperties} 等配置类。
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class ConsoleApplication {

    public static void main(String[] args) {
        NativeLibs.preload();
        SpringApplication.run(ConsoleApplication.class, args);
    }
}
