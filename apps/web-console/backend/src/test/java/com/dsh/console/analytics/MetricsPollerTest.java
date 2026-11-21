package com.dsh.console.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.dsh.console.analytics.MetricsJdbcRepository.MetricSample;
import com.dsh.console.audit.AuditService;
import com.dsh.console.config.AnalyticsProperties;
import com.dsh.console.runtime.FlowableRestClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * {@link MetricsPoller} 回归测试(设计 2026-09-25 §8.5):mock 引擎 metrics JSON,
 * 断言批量插入与 statistic 拆行、白名单外不采集、tag 指标按 availableTags 逐值展开、
 * 阈值告警写审计事件且 2h 去重。
 */
class MetricsPollerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private MetricsJdbcRepository repository;
    private AuditService auditService;
    private AnalyticsProperties properties;
    private MetricsPoller poller;

    /** 各指标名 → 引擎响应 JSON(桩数据源)。 */
    private final Map<String, String> stubResponses = new java.util.HashMap<>();

    @BeforeEach
    void setUp() {
        repository = mock(MetricsJdbcRepository.class);
        auditService = mock(AuditService.class);
        properties = new AnalyticsProperties();
        properties.setMetrics(List.of("dsh.flowable.jobs.deadletter", "dsh.backend.task"));
        properties.setAlerts(Map.of("dsh.flowable.jobs.deadletter", 0.0));
        FlowableRestClient stubClient = new FlowableRestClient(null, JSON) {
            @Override
            public com.fasterxml.jackson.databind.JsonNode getEngineMetric(String metricName,
                                                                           String tagFilter) {
                String key = tagFilter == null ? metricName : metricName + "#" + tagFilter;
                String response = stubResponses.get(key);
                return response == null ? null : read(response);
            }
        };
        poller = new MetricsPoller(stubClient, repository, auditService, properties);
    }

    @Test
    void pollsWhitelistedMetricsAndInsertsPerStatistic() {
        stubResponses.put("dsh.flowable.jobs.deadletter", """
            {"name":"dsh.flowable.jobs.deadletter","measurements":[{"statistic":"VALUE","value":2.0}]}
            """);

        poller.poll();

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<MetricSample>> captor = ArgumentCaptor.forClass(List.class);
        verify(repository, times(1)).insertBatch(captor.capture(), any(OffsetDateTime.class));
        assertThat(captor.getValue())
            .hasSize(1)
            .first()
            .satisfies(s -> {
                assertThat(s.metric()).isEqualTo("dsh.flowable.jobs.deadletter");
                assertThat(s.statistic()).isEqualTo("VALUE");
                assertThat(s.value()).isEqualTo(2.0);
            });
        // 白名单外指标(dsh.flowable.jobs.async 未配置)不采集
        verify(repository, times(1)).insertBatch(anyList(), any(OffsetDateTime.class));
    }

    @Test
    void expandsTaggedMetricPerOutcome() {
        stubResponses.put("dsh.backend.task", """
            {"name":"dsh.backend.task",
             "measurements":[{"statistic":"COUNT","value":10.0}],
             "availableTags":[{"tag":"outcome","values":["success","failed"]}]}
            """);
        stubResponses.put("dsh.backend.task#outcome:success", """
            {"name":"dsh.backend.task","measurements":[
              {"statistic":"COUNT","value":9.0},{"statistic":"TOTAL_TIME","value":4.5E9}]}
            """);
        stubResponses.put("dsh.backend.task#outcome:failed", """
            {"name":"dsh.backend.task","measurements":[
              {"statistic":"COUNT","value":1.0},{"statistic":"TOTAL_TIME","value":2.0E8}]}
            """);

        poller.poll();

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<MetricSample>> captor = ArgumentCaptor.forClass(List.class);
        // 两个 tag 展开各 1 次(deadletter 本用例无桩响应,不落库)
        verify(repository, times(2)).insertBatch(captor.capture(), any(OffsetDateTime.class));
        List<String> storedNames = captor.getAllValues().stream()
            .flatMap(List::stream).map(MetricSample::metric).toList();
        assertThat(storedNames).contains(
            "dsh.backend.task{outcome=success}", "dsh.backend.task{outcome=failed}");
    }

    @Test
    void alertFiresOnThresholdBreachAndDedupesWithinWindow() {
        stubResponses.put("dsh.flowable.jobs.deadletter", """
            {"name":"dsh.flowable.jobs.deadletter","measurements":[{"statistic":"VALUE","value":2.0}]}
            """);

        // 无历史告警 → 写审计事件
        when(repository.lastAlertAt("dsh.flowable.jobs.deadletter")).thenReturn(null);
        poller.poll();
        verify(auditService, times(1)).record(eq(MetricsPoller.ALERT_EVENT_TYPE),
            eq("engine_metric"), eq(null), eq(null), any());

        // 2h 内已有告警 → 去重不重写
        when(repository.lastAlertAt("dsh.flowable.jobs.deadletter"))
            .thenReturn(OffsetDateTime.now(ZoneOffset.UTC).minusMinutes(30));
        poller.poll();
        verify(auditService, times(1)).record(eq(MetricsPoller.ALERT_EVENT_TYPE),
            eq("engine_metric"), eq(null), eq(null), any());
    }

    @Test
    void alertSkipsWhenValueWithinThreshold() {
        stubResponses.put("dsh.flowable.jobs.deadletter", """
            {"name":"dsh.flowable.jobs.deadletter","measurements":[{"statistic":"VALUE","value":0.0}]}
            """);
        poller.poll();
        verify(auditService, never()).record(eq(MetricsPoller.ALERT_EVENT_TYPE),
            eq("engine_metric"), any(), any(), any());
    }

    @Test
    void singleMetricFailureDoesNotBreakOtherMetrics() {
        // deadletter 缺响应(getEngineMetric 抛异常)→ 仅 WARN,白名单其他指标继续采集
        properties.setMetrics(List.of("dsh.flowable.jobs.deadletter", "dsh.task.escalation"));
        stubResponses.put("dsh.task.escalation", """
            {"name":"dsh.task.escalation","measurements":[{"statistic":"COUNT","value":5.0}]}
            """);
        poller.poll();
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<MetricSample>> captor = ArgumentCaptor.forClass(List.class);
        verify(repository, times(1)).insertBatch(captor.capture(), any(OffsetDateTime.class));
        assertThat(captor.getValue()).hasSize(1);
        assertThat(captor.getValue().get(0).metric()).isEqualTo("dsh.task.escalation");
    }

    private static com.fasterxml.jackson.databind.JsonNode read(String json) {
        try {
            return JSON.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
