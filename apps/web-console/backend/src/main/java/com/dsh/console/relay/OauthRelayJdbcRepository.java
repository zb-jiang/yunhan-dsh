package com.dsh.console.relay;

import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * {@code public.oauth_relay_sessions} 表数据访问(local-pg-setup-guide §3.8)。
 *
 * <p>DSH 员工端 Pocket Access 手机端登录的中转会话:发起登录时按 state(兼作
 * 包裹号)登记回跳地址,认证中心 302 回落点按 state 取回并一次性消费。会话行
 * 只有回跳地址,不含授权码/令牌/用户信息,泄密面为零(PKCE verifier 只在手机端)。
 */
@Repository
public class OauthRelayJdbcRepository {

    /** 会话有效期:登录往返(含扫码)最慢 5 分钟,过期登记作废。 */
    private static final String TTL = "INTERVAL '5 minutes'";

    private final JdbcClient jdbcClient;

    public OauthRelayJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * 登记中转会话(state 重复登记 = 覆盖回跳地址并刷新 TTL);顺手删除过期行,
     * 不维护独立清理任务。
     */
    public void register(String state, String returnOrigin) {
        jdbcClient.sql("DELETE FROM public.oauth_relay_sessions WHERE created_at < now() - " + TTL)
            .update();
        jdbcClient.sql("""
            INSERT INTO public.oauth_relay_sessions (state, return_origin)
            VALUES (:state, :returnOrigin)
            ON CONFLICT (state) DO UPDATE SET
                return_origin = EXCLUDED.return_origin,
                created_at = now()
            """)
            .param("state", state)
            .param("returnOrigin", returnOrigin)
            .update();
    }

    /**
     * 按包裹号取回回跳地址并删除(一次性消费)。单条 SQL 原子完成 TTL 校验+消费,
     * 同一 state 的并发回调不会双取。
     *
     * @return 回跳地址;会话不存在或已过期时为空。
     */
    public Optional<String> take(String state) {
        return jdbcClient.sql(
                "DELETE FROM public.oauth_relay_sessions WHERE state = :state AND created_at > now() - " + TTL
                    + " RETURNING return_origin")
            .param("state", state)
            .query((rs, rowNum) -> rs.getString("return_origin"))
            .optional();
    }
}
