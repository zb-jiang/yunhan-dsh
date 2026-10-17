package com.dsh.flowable.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.flowable.config.DshBackendProperties;
import com.dsh.flowable.delegate.DshBackendClient;
import com.dsh.flowable.delegate.DshBackendTaskDelegate;
import com.dsh.flowable.delegate.WebConsoleKbClient;
import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshBpmnParseHandler;
import com.dsh.flowable.listener.DshExtensionPropertiesCache;
import com.dsh.flowable.listener.DshExtensionResolver;
import com.dsh.flowable.listener.DshProcessValidator;
import com.dsh.flowable.listener.DshVotingEndListener;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.flowable.common.engine.impl.history.HistoryLevel;
import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.flowable.engine.impl.cfg.StandaloneProcessEngineConfiguration;
import org.flowable.engine.parse.BpmnParseHandler;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.validation.ProcessValidatorFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * ServiceTask(普通自动节点与 DSH backend task)会签计票端到端测试
 * (2026-09-15 三种 task 统一计票):parse 时生成完成条件 + 挂 end listener →
 * 每实例完成时(delegate 已写表决变量)计票 → 达到通过/否决票数提前收。
 *
 * <p>用 Standalone 内存引擎按生产同路径注册 DshBpmnParseHandler(pre)与
 * DshProcessValidator;两种份数来源都覆盖:普通自动节点用集合形式
 * (collection/elementVariable,前端属性面板形态),backend task 用计数形式
 * (loopCardinality + 每实例绑定 dsh:backendProfile)。
 */
class DshServiceTaskVotingRuleTest {

    private ProcessEngine processEngine;

    /** 普通自动节点测试 delegate 的调用次数(早收断言:未达实例不应执行)。 */
    private final AtomicInteger voteDelegateInvocations = new AtomicInteger();

    /** 每次调用收到的元素值(collection 形式)或 null(计数形式按 loopCounter 取)。 */
    private List<Object> elementVotes;

    /** backend task 桩 client 捕获的每实例 profile URL(断言逐实例绑定)。 */
    private final List<String> capturedProfileUrls = new ArrayList<>();

    /** 真实 repositoryService 引擎 build 后回填(listener/delegate 经 Proxy 延迟引用)。 */
    private final java.util.concurrent.atomic.AtomicReference<RepositoryService>
        realRepositoryService = new java.util.concurrent.atomic.AtomicReference<>();

    @BeforeEach
    void setUp() {
        StandaloneProcessEngineConfiguration configuration = new StandaloneProcessEngineConfiguration();
        configuration.setJdbcUrl("jdbc:h2:mem:dsh-service-voting-test");
        configuration.setJdbcDriver(org.h2.Driver.class.getName());
        configuration.setJdbcUsername("sa");
        configuration.setJdbcPassword("");
        configuration.setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE);
        configuration.setAsyncExecutorActivate(false);
        configuration.setHistoryLevel(HistoryLevel.FULL);

        configuration.setPreBpmnParseHandlers(
            new ArrayList<>(List.<BpmnParseHandler>of(new DshBpmnParseHandler())));
        configuration.setProcessValidator(
            new DshProcessValidator(new ProcessValidatorFactory().createDefaultProcessValidator()));

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
        DshExtensionResolver resolver = new DshExtensionResolver(
            lazyRepositoryService, new DshBpmnExtensionParser(), new DshExtensionPropertiesCache());

        Map<Object, Object> beans = new HashMap<>();
        beans.put("dshVotingEndListener", new DshVotingEndListener(resolver));
        beans.put("voteDelegate", (JavaDelegate) this::voteDelegateExecute);
        beans.put("dshBackendTaskDelegate", backendTaskDelegate(resolver));
        configuration.setBeans(beans);

        processEngine = configuration.buildProcessEngine();
        realRepositoryService.set(processEngine.getRepositoryService());
    }

    @AfterEach
    void tearDown() {
        processEngine.close();
    }

    /**
     * 普通自动节点的定制 delegate 替身:集合形式读引擎注入的当前元素("vote"),
     * 计数形式按 {@code loopCounter} 从 {@link #elementVotes} 取;写入表决变量
     * approved(值为 null 的用例验证「表决值缺失不计票」)。
     */
    private void voteDelegateExecute(DelegateExecution execution) {
        voteDelegateInvocations.incrementAndGet();
        Object vote = execution.getVariable("vote");
        if (vote == null && elementVotes != null) {
            Object counter = execution.getVariableLocal(
                com.dsh.flowable.listener.DshBpmnParseHandler.LOOP_COUNTER_VARIABLE);
            if (counter instanceof Number n && n.intValue() < elementVotes.size()) {
                vote = elementVotes.get(n.intValue());
            }
        }
        if (vote != null) {
            execution.setVariable("approved", vote);
        }
    }

    /** backend task 桩:记录每实例调用的 profile URL,返回固定 result JSON。 */
    private DshBackendTaskDelegate backendTaskDelegate(DshExtensionResolver resolver) {
        DshBackendClient stubClient = new DshBackendClient(
            new DshBackendProperties(1, 5), new ObjectMapper()) {
            @Override
            public Map<String, Object> execute(String baseUrl, String prompt,
                                               List<String> skillRefs, String activityId,
                                               String processInstanceId,
                                               WebConsoleKbClient.KbRef kb) {
                capturedProfileUrls.add(baseUrl);
                return Map.of("approved", true);
            }
        };
        // 知识库解析桩:恒返回 null(本测试不涉及知识库,行为等同未开通)
        WebConsoleKbClient stubKbClient = new WebConsoleKbClient(
            new com.dsh.flowable.config.DshWebConsoleProperties("http://127.0.0.1:8080", "sk"),
            new ObjectMapper()) {
            @Override
            public WebConsoleKbClient.KbRef resolveOrNull(String processDefinitionId, String activityId) {
                return null;
            }
        };
        return new DshBackendTaskDelegate(resolver, stubClient, stubKbClient, new ObjectMapper(),
            new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
    }

    @Test
    void parallelCollectionPassVotesCompleteEarly() {
        deploy("""
            <process id="parallel_collection" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="ai"/>
              <serviceTask id="ai" name="AI 评审" flowable:delegateExpression="${voteDelegate}">
                <extensionElements>
                  <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="false"
                    flowable:collection="voteList" flowable:elementVariable="vote"/>
              </serviceTask>
              <sequenceFlow id="flow2" sourceRef="ai" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        // 3 个元素两票通过即收:第 3 个元素对应的实例被早收跳过
        ProcessInstance instance = processEngine.getRuntimeService().startProcessInstanceByKey(
            "parallel_collection", Map.of("voteList", List.of(true, true, false)));

        assertThatProcessEnded(instance.getId());
        assertThat(voteDelegateInvocations.get()).isEqualTo(2);
        assertThat(passCount(instance.getId())).isEqualTo(2L);
    }

    @Test
    void sequentialRejectVotesCompleteEarly() {
        elementVotes = List.of(false, false, true);
        deploy("""
            <process id="sequential_cardinality" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="ai"/>
              <serviceTask id="ai" name="AI 评审" flowable:delegateExpression="${voteDelegate}">
                <extensionElements>
                  <dsh:votingRule variable="approved" passValue="true" passCount="2" rejectCount="2"/>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="true">
                  <loopCardinality>3</loopCardinality>
                </multiInstanceLoopCharacteristics>
              </serviceTask>
              <sequenceFlow id="flow2" sourceRef="ai" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        ProcessInstance instance = processEngine.getRuntimeService()
            .startProcessInstanceByKey("sequential_cardinality");

        // 前两份否决即收:第 3 个实例不再执行
        assertThatProcessEnded(instance.getId());
        assertThat(voteDelegateInvocations.get()).isEqualTo(2);
        assertThat(processEngine.getHistoryService().createHistoricVariableInstanceQuery()
            .processInstanceId(instance.getId())
            .variableName("dsh_rejectCount_ai")
            .singleResult().getValue()).isEqualTo(2L);
    }

    @Test
    void missingVoteCreatesCountersAndCompletesAllInstances() {
        // 表决值全部缺失:计数变量在首次完成前创建为 0(完成条件求值不因变量缺失报错),
        // 全部实例完成、流程正常结束(List.of 不允许 null 元素,用 Arrays.asList)
        elementVotes = java.util.Arrays.asList(null, null, null);
        deploy("""
            <process id="missing_votes" isExecutable="true">
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="ai"/>
              <serviceTask id="ai" name="AI 评审" flowable:delegateExpression="${voteDelegate}">
                <extensionElements>
                  <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="true">
                  <loopCardinality>3</loopCardinality>
                </multiInstanceLoopCharacteristics>
              </serviceTask>
              <sequenceFlow id="flow2" sourceRef="ai" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        ProcessInstance instance = processEngine.getRuntimeService()
            .startProcessInstanceByKey("missing_votes");

        assertThatProcessEnded(instance.getId());
        assertThat(voteDelegateInvocations.get()).isEqualTo(3);
        assertThat(passCount(instance.getId())).isEqualTo(0L);
        assertThat(processEngine.getHistoryService().createHistoricVariableInstanceQuery()
            .processInstanceId(instance.getId())
            .variableName("dsh_rejectCount_ai")
            .singleResult().getValue()).isEqualTo(0L);
    }

    @Test
    void backendTaskMultiInstanceBindsProfilePerInstanceAndVotes() {
        // 3 实例各绑一个 profile,投票经输出映射写入 approved;2 票通过提前收
        deploy("""
            <process id="backend_multi" isExecutable="true">
              <extensionElements>
                <dsh:contextVariables>
                  <dsh:contextVariable name="approved" type="boolean"/>
                </dsh:contextVariables>
              </extensionElements>
              <startEvent id="start"/>
              <sequenceFlow id="flow1" sourceRef="start" targetRef="aiReview"/>
              <serviceTask id="aiReview" name="多 AI 会诊"
                  flowable:delegateExpression="${dshBackendTaskDelegate}">
                <extensionElements>
                  <dsh:backendTask>
                    <dsh:backendProfile url="http://profile-1"/>
                    <dsh:backendProfile url="http://profile-2"/>
                    <dsh:backendProfile url="http://profile-3"/>
                  </dsh:backendTask>
                  <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
                  <dsh:outputMappings>
                    <dsh:mapping source="approved" target="approved"/>
                  </dsh:outputMappings>
                </extensionElements>
                <multiInstanceLoopCharacteristics isSequential="false">
                  <loopCardinality>3</loopCardinality>
                </multiInstanceLoopCharacteristics>
              </serviceTask>
              <sequenceFlow id="flow2" sourceRef="aiReview" targetRef="end"/>
              <endEvent id="end"/>
            </process>""");

        ProcessInstance instance = processEngine.getRuntimeService()
            .startProcessInstanceByKey("backend_multi");

        assertThatProcessEnded(instance.getId());
        // 实例按序号取各自 profile;2 票通过提前收,第 3 个实例不再执行
        assertThat(capturedProfileUrls).containsExactly("http://profile-1", "http://profile-2");
        assertThat(processEngine.getHistoryService().createHistoricVariableInstanceQuery()
            .processInstanceId(instance.getId())
            .variableName("dsh_passCount_aiReview")
            .singleResult().getValue()).isEqualTo(2L);
    }

    private void assertThatProcessEnded(String processInstanceId) {
        assertThat(processEngine.getRuntimeService().createProcessInstanceQuery()
            .processInstanceId(processInstanceId).count()).isZero();
    }

    private Object passCount(String processInstanceId) {
        return processEngine.getHistoryService().createHistoricVariableInstanceQuery()
            .processInstanceId(processInstanceId)
            .variableName("dsh_passCount_ai")
            .singleResult().getValue();
    }

    private void deploy(String processBody) {
        processEngine.getRepositoryService().createDeployment()
            .addString("service-voting-process.bpmn20.xml", bpmn(processBody))
            .deploy();
    }

    private static String bpmn(String processBody) {
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.ai/bpmn">
            %s
            </definitions>""".formatted(processBody);
    }
}
