package com.dsh.flowable.delegate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.dsh.flowable.config.DshBackendProperties;
import com.dsh.flowable.config.DshWebConsoleProperties;
import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshExtensionPropertiesCache;
import com.dsh.flowable.listener.DshExtensionResolver;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.flowable.common.engine.api.FlowableException;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.flowable.engine.runtime.ProcessInstance;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@link DshBackendTaskDelegate} 全路径测试(design 2026-09-14 §6.3):
 * Standalone H2 引擎部署含 dsh:backendTask 的流程,delegate 走生产解析路径
 * (DshExtensionResolver → parseBackendTask),HTTP client 用桩替换
 * (捕获插值后 prompt,返回固定 result),断言:
 * <ol>
 *   <li>userPrompt {{}} 插值(含缺失值→「空」语义)与 skillRefs 透传;</li>
 *   <li>输出映射写入流程变量(string/array 整体覆盖/object 点路径深入);</li>
 *   <li>未声明 target(根变量或深路径字段)/ 系统注入变量 fail loud(异常上抛给引擎,
 *       async 部署下即 async job 重试语义;同步执行下 Flowable 原样传播
 *       IllegalArgumentException,故断言接受两种形态)。</li>
 * </ol>
 *
 * <p>serviceTask 不开 async(async executor 关闭,同步执行直接触发 delegate);
 * async job 重试节奏是引擎行为,不在本测试范围。resolver 需要引擎的
 * repositoryService 而 beans 又要在 buildProcessEngine 前注册 delegate,
 * 故经 JDK Proxy 延迟注入(repositoryService 在引擎 build 后回填)。
 */
class DshBackendTaskDelegateTest {

    private ProcessEngine processEngine;
    private RuntimeService runtimeService;

    /** 桩捕获:插值后提交的 prompt。 */
    private final AtomicReference<String> capturedPrompt = new AtomicReference<>();

    /** 桩捕获:透传的 skillRefs。 */
    private final AtomicReference<List<String>> capturedSkillRefs = new AtomicReference<>(List.of());

    /** 桩捕获:随 payload 下发的流程实例 id(实例空间关联键)。 */
    private final AtomicReference<String> capturedProcessInstanceId = new AtomicReference<>();

    /** 桩捕获:随 payload 下发的任务知识库(null = 未开通/降级)。 */
    private final AtomicReference<WebConsoleKbClient.KbRef> capturedKb =
        new AtomicReference<>();

    /** 桩返回:知识库解析结果(null = 未开通/降级,知识库用例覆写)。 */
    private final AtomicReference<WebConsoleKbClient.KbRef> stubKbRef = new AtomicReference<>();

    /** 桩返回:backend task 的 result JSON。 */
    private volatile Map<String, Object> stubResult = Map.of();

    /** 运维指标注册表(分析看板 backend task 成功率/时延埋点断言用)。 */
    private final SimpleMeterRegistry meterRegistry = new SimpleMeterRegistry();

    @BeforeEach
    void setUp() {
        AtomicReference<RepositoryService> realRepositoryService = new AtomicReference<>();
        RepositoryService lazyRepositoryService = (RepositoryService) Proxy.newProxyInstance(
            getClass().getClassLoader(), new Class<?>[]{RepositoryService.class},
            (proxy, method, args) -> {
                RepositoryService real = realRepositoryService.get();
                if (real == null) {
                    throw new IllegalStateException("repository service not ready");
                }
                try {
                    return method.invoke(real, args);
                } catch (InvocationTargetException e) {
                    throw e.getCause();
                }
            });
        DshBackendClient stubClient = new DshBackendClient(
            new DshBackendProperties(1, 5), new ObjectMapper()) {
            @Override
            public Map<String, Object> execute(String baseUrl, String prompt,
                                                List<String> skillRefs, String activityId,
                                                String processInstanceId,
                                                WebConsoleKbClient.KbRef kb) {
                assertThat(baseUrl).isEqualTo("http://127.0.0.1:3190");
                capturedPrompt.set(prompt);
                capturedSkillRefs.set(skillRefs);
                capturedProcessInstanceId.set(processInstanceId);
                capturedKb.set(kb);
                return stubResult;
            }
        };
        // 桩:默认未开通知识库(返回 null);知识库用例经 stubKbRef 覆盖
        WebConsoleKbClient stubKbClient = new WebConsoleKbClient(
            new DshWebConsoleProperties("http://127.0.0.1:8080", "sk"), new ObjectMapper()) {
            @Override
            public WebConsoleKbClient.KbRef resolveOrNull(String processDefinitionId, String activityId) {
                return stubKbRef.get();
            }
        };
        DshBackendTaskDelegate delegate = new DshBackendTaskDelegate(
            new DshExtensionResolver(lazyRepositoryService,
                new DshBpmnExtensionParser(), new DshExtensionPropertiesCache()),
            stubClient, stubKbClient, new ObjectMapper(), meterRegistry);

        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-backend-delegate-test");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);
        Map<Object, Object> beans = new HashMap<>();
        beans.put("dshBackendTaskDelegate", delegate);
        configuration.setBeans(beans);

        processEngine = configuration.buildProcessEngine();
        realRepositoryService.set(processEngine.getRepositoryService());
        runtimeService = processEngine.getRuntimeService();
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    @Test
    void happyPathInterpolatesPromptAndWritesMappedVariables() {
        stubResult = Map.of("summary", "摘要文本", "items", List.of(1, 2));
        deployAndStart("happy_path", Map.of("inputWord", "工单#42", "reportList", List.of("旧值")), """
            <process id="happy_path" isExecutable="true">
              <extensionElements>
                <dsh:contextVariables>
                  <dsh:contextVariable name="inputWord" type="string"/>
                  <dsh:contextVariable name="reportSummary" type="string"/>
                  <dsh:contextVariable name="reportList" type="array" itemType="integer"/>
                  <dsh:contextVariable name="missingVar" type="string"/>
                </dsh:contextVariables>
              </extensionElements>
              <startEvent id="start"/>
              <sequenceFlow id="f1" sourceRef="start" targetRef="generate"/>
              <serviceTask id="generate" name="生成" flowable:delegateExpression="${dshBackendTaskDelegate}">
                <extensionElements>
                  <dsh:backendTask backendProfileUrl="http://127.0.0.1:3190"/>
                  <dsh:userPrompt text="基于 {{inputWord}} 与缺失 {{missingVar}} 生成"/>
                  <dsh:skillRef>demo-skill</dsh:skillRef>
                  <dsh:outputMappings>
                    <dsh:mapping source="summary" target="reportSummary"/>
                    <dsh:mapping source="items" target="reportList"/>
                  </dsh:outputMappings>
                </extensionElements>
              </serviceTask>
              <sequenceFlow id="f2" sourceRef="generate" targetRef="wait"/>
              <userTask id="wait" name="停留"/>
              <sequenceFlow id="f3" sourceRef="wait" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        ProcessInstance instance = runtimeService.createProcessInstanceQuery()
            .processDefinitionKey("happy_path").singleResult();
        assertThat(instance).isNotNull();
        // 插值:已声明变量值替换,缺失值→「空」(与 user task 同语义)
        assertThat(capturedPrompt.get()).isEqualTo("基于 工单#42 与缺失 空 生成");
        assertThat(capturedSkillRefs.get()).containsExactly("demo-skill");
        // 实例空间关联键:delegate 传真实流程实例 id(design 2026-10-14 任务2)
        assertThat(capturedProcessInstanceId.get()).isEqualTo(instance.getId());
        assertThat(runtimeService.getVariable(instance.getId(), "reportSummary"))
            .isEqualTo("摘要文本");
        // array 整体覆盖写(不做 user task 多实例 append 聚合)
        assertThat(runtimeService.getVariable(instance.getId(), "reportList"))
            .isEqualTo(List.of(1, 2));
        // 运维埋点:成功路径记录 dsh.backend.task{outcome=success} 计时
        assertThat(meterRegistry.get("dsh.backend.task").tag("outcome", "success").timer().count())
            .isEqualTo(1L);
    }

    @Test
    void resolvedKbIsPassedThroughToBackendPayloadWithoutTouchingPrompt() {
        stubResult = Map.of("summary", "摘要文本");
        stubKbRef.set(new WebConsoleKbClient.KbRef("kb-uuid-1", "差旅工程知识库"));
        deployAndStart("kb_passthrough", Map.of("inputWord", "工单#42"), """
            <process id="kb_passthrough" isExecutable="true">
              <extensionElements>
                <dsh:contextVariables>
                  <dsh:contextVariable name="inputWord" type="string"/>
                </dsh:contextVariables>
              </extensionElements>
              <startEvent id="start"/>
              <sequenceFlow id="f1" sourceRef="start" targetRef="generate"/>
              <serviceTask id="generate" name="生成" flowable:delegateExpression="${dshBackendTaskDelegate}">
                <extensionElements>
                  <dsh:backendTask backendProfileUrl="http://127.0.0.1:3190"/>
                  <dsh:userPrompt text="基于 {{inputWord}} 生成"/>
                </extensionElements>
              </serviceTask>
              <sequenceFlow id="f2" sourceRef="generate" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        // kb 走 payload 结构化字段,不拼进 prompt 文本
        assertThat(capturedPrompt.get()).isEqualTo("基于 工单#42 生成");
        assertThat(capturedKb.get()).isNotNull();
        assertThat(capturedKb.get().kbId()).isEqualTo("kb-uuid-1");
        assertThat(capturedKb.get().kbName()).isEqualTo("差旅工程知识库");
    }

    @Test
    void objectDeepPathMappingWritesNestedField() {
        stubResult = Map.of("data", Map.of("inner", "深层值"));
        deployAndStart("deep_path", Map.of("report", new HashMap<>(Map.of("kept", "保留字段"))), """
            <process id="deep_path" isExecutable="true">
              <extensionElements>
                <dsh:contextVariables>
                  <dsh:contextVariable name="report" type="object">
                    <dsh:field name="inner" type="string"/>
                  </dsh:contextVariable>
                </dsh:contextVariables>
              </extensionElements>
              <startEvent id="start"/>
              <sequenceFlow id="f1" sourceRef="start" targetRef="generate"/>
              <serviceTask id="generate" name="生成" flowable:delegateExpression="${dshBackendTaskDelegate}">
                <extensionElements>
                  <dsh:backendTask backendProfileUrl="http://127.0.0.1:3190"/>
                  <dsh:outputMappings>
                    <dsh:mapping source="data.inner" target="report.inner"/>
                  </dsh:outputMappings>
                </extensionElements>
              </serviceTask>
              <sequenceFlow id="f2" sourceRef="generate" targetRef="wait"/>
              <userTask id="wait" name="停留"/>
              <sequenceFlow id="f3" sourceRef="wait" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        ProcessInstance instance = runtimeService.createProcessInstanceQuery()
            .processDefinitionKey("deep_path").singleResult();
        assertThat(instance).isNotNull();
        @SuppressWarnings("unchecked")
        Map<String, Object> report = (Map<String, Object>)
            runtimeService.getVariable(instance.getId(), "report");
        assertThat(report)
            .containsEntry("inner", "深层值")
            .containsEntry("kept", "保留字段");
    }

    @Test
    void undeclaredFieldPathFailsLoud() {
        // 深路径 target 的字段未在根变量字段清单声明(手改 XML 绕过设计器)→ fail loud
        stubResult = Map.of("data", Map.of("x", 1));
        assertThatThrownBy(() -> deployAndStart("undeclared_field", Map.of(), """
            <process id="undeclared_field" isExecutable="true">
              <extensionElements>
                <dsh:contextVariables>
                  <dsh:contextVariable name="report" type="object">
                    <dsh:field name="inner" type="string"/>
                  </dsh:contextVariable>
                </dsh:contextVariables>
              </extensionElements>
              <startEvent id="start"/>
              <sequenceFlow id="f1" sourceRef="start" targetRef="generate"/>
              <serviceTask id="generate" name="生成" flowable:delegateExpression="${dshBackendTaskDelegate}">
                <extensionElements>
                  <dsh:backendTask backendProfileUrl="http://127.0.0.1:3190"/>
                  <dsh:outputMappings>
                    <dsh:mapping source="data" target="report.noSuchField"/>
                  </dsh:outputMappings>
                </extensionElements>
              </serviceTask>
              <sequenceFlow id="f2" sourceRef="generate" targetRef="end"/>
              <endEvent id="end"/>
            </process>"""))
            .isInstanceOfAny(FlowableException.class, IllegalArgumentException.class)
            .hasMessageContaining("字段路径未在根变量字段清单中声明");
    }

    @Test
    void undeclaredTargetFailsLoud() {
        stubResult = Map.of("x", 1);
        assertThatThrownBy(() -> deployAndStart("undeclared", Map.of(), """
            <process id="undeclared" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="f1" sourceRef="start" targetRef="generate"/>
              <serviceTask id="generate" name="生成" flowable:delegateExpression="${dshBackendTaskDelegate}">
                <extensionElements>
                  <dsh:backendTask backendProfileUrl="http://127.0.0.1:3190"/>
                  <dsh:outputMappings>
                    <dsh:mapping source="x" target="noSuchVar"/>
                  </dsh:outputMappings>
                </extensionElements>
              </serviceTask>
              <sequenceFlow id="f2" sourceRef="generate" targetRef="end"/>
              <endEvent id="end"/>
            </process>"""))
            .isInstanceOfAny(FlowableException.class, IllegalArgumentException.class)
            .hasMessageContaining("target 指向未声明变量: noSuchVar");
    }

    @Test
    void systemSourceTargetRejected() {
        stubResult = Map.of("userId", "u-1");
        assertThatThrownBy(() -> deployAndStart("system_target", Map.of(), """
            <process id="system_target" isExecutable="true">
              <extensionElements>
                <dsh:contextVariables>
                  <dsh:contextVariable name="initiator" type="object" source="system">
                    <dsh:field name="userId" type="string"/>
                    <dsh:field name="name" type="string"/>
                    <dsh:field name="email" type="string"/>
                  </dsh:contextVariable>
                </dsh:contextVariables>
              </extensionElements>
              <startEvent id="start"/>
              <sequenceFlow id="f1" sourceRef="start" targetRef="generate"/>
              <serviceTask id="generate" name="生成" flowable:delegateExpression="${dshBackendTaskDelegate}">
                <extensionElements>
                  <dsh:backendTask backendProfileUrl="http://127.0.0.1:3190"/>
                  <dsh:outputMappings>
                    <dsh:mapping source="userId" target="initiator"/>
                  </dsh:outputMappings>
                </extensionElements>
              </serviceTask>
              <sequenceFlow id="f2" sourceRef="generate" targetRef="end"/>
              <endEvent id="end"/>
            </process>"""))
            .isInstanceOfAny(FlowableException.class, IllegalArgumentException.class)
            .hasMessageContaining("系统注入变量");
    }

    /** 部署流程并启动实例(async 关闭,serviceTask 同步执行 delegate)。 */
    private void deployAndStart(String key, Map<String, Object> variables, String processBody) {
        String xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.ai/bpmn">
            %s
            </definitions>""".formatted(processBody);
        processEngine.getRepositoryService().createDeployment()
            .addString(key + ".bpmn20.xml", xml)
            .deploy();
        runtimeService.startProcessInstanceByKey(key, variables);
    }
}
