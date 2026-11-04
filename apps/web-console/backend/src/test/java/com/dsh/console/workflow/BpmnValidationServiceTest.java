package com.dsh.console.workflow;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.backendprofile.BackendProfileJdbcRepository;
import com.dsh.console.backendprofile.dto.BackendProfileDto;
import com.dsh.console.orgunit.OrgUnitJdbcRepository;
import com.dsh.console.role.AppRoleJdbcRepository;
import com.dsh.console.role.dto.AppRoleDto;
import com.dsh.console.skillhub.SkillHubRestClient;
import com.dsh.console.skillhub.dto.SkillHubSkillDto;
import com.dsh.console.workflow.dto.BpmnValidationResult;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Process Context 发布校验五查中 system 声明相关的规则测试:
 * initiator 结构精确校验、输出映射 target 禁改、来源闭环把 system 计入来源;
 * skillRef 引用存在性校验(SkillHub namespace 绑定);
 * userTask 多实例 wiring 校验(配候选角色必须有多实例 + 禁 loopCardinality);
 * 以及 DSH backend task 专属校验(design 2026-09-14 §4:URL 注册表存在性 /
 * delegate 固定绑定 / async 强制)。
 * 组织维度审批路由校验(design 2026-09-19 §5,任务 3.3):orgScope/virtualRole
 * 枚举合法、虚拟角色互斥、fixedUnit 必填且部门存在。
 * 超时升级策略校验(与办理人组织路由对称):升级目标三选一互斥、虚拟角色/
 * 范围属性对齐、escalateToRoleId 应用归属。
 */
class BpmnValidationServiceTest {

    private BpmnValidationService service;
    private ApplicationJdbcRepository appRepository;
    private SkillHubRestClient skillHubRestClient;
    private BackendProfileJdbcRepository profileRepository;
    private AppRoleJdbcRepository roleRepository;
    private OrgUnitJdbcRepository orgUnitRepository;

    @BeforeEach
    void setUp() {
        roleRepository = mock(AppRoleJdbcRepository.class);
        when(roleRepository.listByApp(any(UUID.class))).thenReturn(List.of());
        appRepository = mock(ApplicationJdbcRepository.class);
        skillHubRestClient = mock(SkillHubRestClient.class);
        profileRepository = mock(BackendProfileJdbcRepository.class);
        orgUnitRepository = mock(OrgUnitJdbcRepository.class);
        service = new BpmnValidationService(roleRepository, appRepository, skillHubRestClient,
            profileRepository, orgUnitRepository);
    }

    /** 最小可执行流程骨架:节点标识用例按需替换 start/task/end 的 id/name。 */
    private String nodeIdentifierBpmn(String taskElement) {
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="validation_test_process" isExecutable="true">
                <startEvent id="start" name="开始"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="task"/>
            %s
                <sequenceFlow id="flow2" sourceRef="task" targetRef="end"/>
                <endEvent id="end" name="结束"/>
              </process>
            </definitions>
            """.formatted(taskElement);
    }

    @Test
    void nodeWithoutNameIsRejected() {
        BpmnValidationResult result = service.validate(nodeIdentifierBpmn(
            "<userTask id=\"task\"/>"), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e ->
            e.contains("userTask[id=task] 缺少 name"));
    }

    @Test
    void nodeWithoutIdIsRejected() {
        BpmnValidationResult result = service.validate(nodeIdentifierBpmn(
            "<userTask name=\"任务\"/>"), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e ->
            e.contains("userTask[name=任务] 缺少 id"));
    }

    @Test
    void nodesWithIdAndNamePassIdentifierCheck() {
        BpmnValidationResult result = service.validate(nodeIdentifierBpmn(
            "<userTask id=\"task\" name=\"任务\"/>"), UUID.randomUUID());
        assertThat(result.errors()).noneMatch(e -> e.contains("缺少 id") || e.contains("缺少 name"));
    }

    @Test
    void nonExecutableProcessIsRejected() {
        BpmnValidationResult result = service.validate(
            nodeIdentifierBpmn("<userTask id=\"task\" name=\"任务\"/>")
                .replace("isExecutable=\"true\"", "isExecutable=\"false\""),
            UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("isExecutable 必须为 true"));
    }

    @Test
    void processMissingExecutableAttributeIsRejected() {
        BpmnValidationResult result = service.validate(
            nodeIdentifierBpmn("<userTask id=\"task\" name=\"任务\"/>")
                .replace(" isExecutable=\"true\"", ""),
            UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("isExecutable 必须为 true"));
    }

    // ===== userTask 办理人来源必填 + 单 process 约束(2026-11-03 修复清单 #4 #5) =====

    @Test
    void userTaskWithoutCandidateSourceIsRejected() {
        // 无 candidateUsers/candidateGroups 也无 dsh:assignmentRule → 发布拒绝
        BpmnValidationResult result = service.validate(nodeIdentifierBpmn(
            "<userTask id=\"task\" name=\"任务\"/>"), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e ->
            e.contains("userTask[id=task, name=任务] 未配置办理人来源"));
    }

    @Test
    void multiProcessFileIsRejected() {
        BpmnValidationResult result = service.validate("""
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="process_one" isExecutable="true">
                <startEvent id="start1" name="开始"/>
                <userTask id="task1" name="任务一" flowable:candidateUsers="user-a"/>
                <sequenceFlow id="f1" sourceRef="start1" targetRef="task1"/>
                <sequenceFlow id="f2" sourceRef="task1" targetRef="end1"/>
                <endEvent id="end1" name="结束"/>
              </process>
              <process id="process_two" isExecutable="true">
                <startEvent id="start2" name="开始"/>
                <userTask id="task2" name="任务二" flowable:candidateUsers="user-a"/>
                <sequenceFlow id="f3" sourceRef="start2" targetRef="task2"/>
                <sequenceFlow id="f4" sourceRef="task2" targetRef="end2"/>
                <endEvent id="end2" name="结束"/>
              </process>
            </definitions>""", UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("包含 2 个 <process>(process_one, process_two)"))
            .anyMatch(e -> e.contains("拆分成多个文件"));
    }

    @Test
    void standardInitiatorDeclarationPassesWithPromptAndConditionReferences() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="initiator" type="object" source="system">
                <dsh:field name="userId" type="string"/>
                <dsh:field name="name" type="string"/>
                <dsh:field name="email" type="string"/>
              </dsh:contextVariable>
            </dsh:contextVariables>
            """, """
            <dsh:userPrompt text="你当前的申请人为{{initiator.name}}"/>
            """, "${initiator.userId == 'sub-1'}"), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void systemSourceOnlySupportsInitiator() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="operator" type="object" source="system"/>
            </dsh:contextVariables>
            """, "", null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("仅支持 initiator"));
    }

    @Test
    void initiatorMustBeObjectType() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="initiator" type="string" source="system"/>
            </dsh:contextVariables>
            """, "", null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("必须为 object 类型"));
    }

    @Test
    void initiatorFieldsMustBeExactlyUserIdNameEmail() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="initiator" type="object" source="system">
                <dsh:field name="userId" type="string"/>
                <dsh:field name="name" type="string"/>
              </dsh:contextVariable>
            </dsh:contextVariables>
            """, "", null), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("userId/name/email"))
            .anyMatch(e -> e.contains("initiator"));
    }

    @Test
    void outputMappingTargetToSystemVariableIsRejected() {
        BpmnValidationResult result = service.validate(bpmn("""
            <dsh:contextVariables>
              <dsh:contextVariable name="initiator" type="object" source="system">
                <dsh:field name="userId" type="string"/>
                <dsh:field name="name" type="string"/>
                <dsh:field name="email" type="string"/>
              </dsh:contextVariable>
            </dsh:contextVariables>
            """, """
            <dsh:userPrompt text="确认"/>
            <dsh:outputMappings>
              <dsh:mapping source="applicant" target="initiator"/>
            </dsh:outputMappings>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("指向系统注入变量"));
    }

    @Test
    void promptReferencingInitiatorWithoutDeclarationFails() {
        BpmnValidationResult result = service.validate(bpmn(
            "", """
            <dsh:userPrompt text="你当前的申请人为{{initiator.name}}"/>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("引用未声明变量: initiator"));
    }

    // ===== userTask 多实例 wiring(候选角色必须多实例 + 禁 loopCardinality) =====

    @Test
    void assignmentRuleWithoutMultiInstanceFails() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:assignmentRule candidateRoleId="role-1"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("配了审批规则但没有多实例"));
    }

    @Test
    void userTaskLoopCardinalityFails() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <multiInstanceLoopCharacteristics isSequential="false">
                <loopCardinality>3</loopCardinality>
              </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("loopCardinality"));
    }

    @Test
    void candidateRoleWithParallelMultiInstancePasses() {
        UUID roleId = UUID.randomUUID();
        when(roleRepository.listByApp(any(UUID.class))).thenReturn(List.of(
            new AppRoleDto(roleId, UUID.randomUUID(), "审批角色", null, "active", null, null, null)));
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:assignmentRule candidateRoleId="%s"/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false">
                <completionCondition>${nrOfCompletedInstances &gt;= 1}</completionCondition>
              </multiInstanceLoopCharacteristics>
            """.formatted(roleId)), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    // ===== 组织维度审批路由(design 2026-09-19 §5,任务 3.3) =====

    @Test
    void virtualRoleRuleWithMultiInstancePasses() {
        // 虚拟角色:无 candidateRoleId/orgScope/fixedUnitId,纯 virtualRole + 多实例 → 通过
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:assignmentRule virtualRole="parent"/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false"/>
            """), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void virtualRoleCoexistingWithRoleAndScopeFails() {
        // 虚拟角色锁定同行政线:与 candidateRoleId / orgScope / fixedUnitId 并存 → 拒绝
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:assignmentRule virtualRole="parent" candidateRoleId="role-1"
                                    orgScope="global" fixedUnitId="unit-1"/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false"/>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("不能与 candidateRoleId 并存"))
            .anyMatch(e -> e.contains("不能再配 orgScope"))
            .anyMatch(e -> e.contains("不能配 fixedUnitId"));
    }

    @Test
    void invalidOrgScopeAndVirtualRoleEnumsFail() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:assignmentRule orgScope="宇宙" virtualRole="上三级"/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false"/>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("orgScope 不合法: 宇宙"))
            .anyMatch(e -> e.contains("virtualRole 不合法: 上三级"));
    }

    @Test
    void fixedUnitScopeRequiresExistingDepartment() {
        // 缺 fixedUnitId
        BpmnValidationResult missing = service.validate(
            orgScopeBpmn("fixedUnit", null), UUID.randomUUID());
        assertThat(missing.errors()).anyMatch(e -> e.contains("缺少 fixedUnitId"));

        // 部门不存在
        UUID unitId = UUID.randomUUID();
        when(orgUnitRepository.findById(unitId)).thenReturn(Optional.empty());
        BpmnValidationResult unknown = service.validate(
            orgScopeBpmn("fixedUnit", unitId.toString()), UUID.randomUUID());
        assertThat(unknown.errors()).anyMatch(e -> e.contains("指定部门不存在"));

        // 非法 UUID
        BpmnValidationResult malformed = service.validate(
            orgScopeBpmn("fixedUnit", "not-a-uuid"), UUID.randomUUID());
        assertThat(malformed.errors()).anyMatch(e -> e.contains("不是合法的部门 id"));

        // 部门存在 + 角色 active → 通过
        UUID roleId = UUID.randomUUID();
        when(roleRepository.listByApp(any(UUID.class))).thenReturn(List.of(
            new AppRoleDto(roleId, UUID.randomUUID(), "财务", null, "active", null, null, null)));
        when(orgUnitRepository.findById(unitId)).thenReturn(Optional.of(
            new com.dsh.console.orgunit.dto.OrgUnitDto(unitId, "财务部", null, null, 0, null)));
        BpmnValidationResult ok = service.validate(
            orgScopeBpmn("fixedUnit", unitId.toString(), roleId), UUID.randomUUID());
        assertThat(ok.errors()).isEmpty();
    }

    @Test
    void explicitScopeWithoutTargetRoleFails() {
        BpmnValidationResult result = service.validate(orgScopeBpmn("sameLine", null), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("缺少 candidateRoleId"));
    }

    @Test
    void fixedUnitIdOutsideFixedUnitScopeFails() {
        BpmnValidationResult result = service.validate(
            orgScopeBpmn("global", UUID.randomUUID().toString()), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("仅在指定部门(fixedUnit)范围有效"));
    }

    @Test
    void virtualRoleWithoutMultiInstanceFails() {
        // 组织维度节点同样必须多实例(与引擎 hasDshCandidateRole 判定对齐)
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:assignmentRule virtualRole="parent"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("配了审批规则但没有多实例"));
    }

    @Test
    void gatewayConditionReferencingApplicantOrgUnitIsExempt() {
        // 条件表达式引用启动注入的申请人主部门变量(design 2026-09-19 §5.1)→ 豁免
        BpmnValidationResult result = service.validate("""
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="org_validation_test" isExecutable="true">
                <startEvent id="start" name="开始"/>
                <userTask id="task" name="任务"/>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="decide">
                  <conditionExpression>${dsh_applicant_org_unit_id != null}</conditionExpression>
                </sequenceFlow>
                <exclusiveGateway id="decide"/>
              </process>
            </definitions>""", UUID.randomUUID());
        assertThat(result.errors())
            .noneMatch(e -> e.contains("引用未声明变量"));
    }

    // ===== 超时升级策略(与办理人组织路由对称) =====

    @Test
    void timeoutEscalationTargetMustBeSingle() {
        // 用户 ID 与虚拟角色并存 → 三选一拒绝
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToUserId="u-1"
                                   escalateToVirtualRole="parent"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("必须三选一"));
    }

    @Test
    void timeoutEscalationVirtualRoleEnumAndScopeAttrs() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToVirtualRole="上三级"
                                   escalateOrgScope="sameLine"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("升级目标虚拟角色不合法: 上三级"))
            .anyMatch(e -> e.contains("不应配 escalateOrgScope/fixedUnitId"));
    }

    @Test
    void timeoutEscalationUserIdRejectsScopeAttrs() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToUserId="u-1"
                                   escalateOrgScope="global"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("升级目标用户直接指派"));
    }

    @Test
    void timeoutEscalationWithoutTargetRejectsScopeAttrs() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateFixedUnitId="unit-1"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("未配置升级目标"));
    }

    @Test
    void timeoutEscalationRoleScopeValidation() {
        // orgScope 枚举
        BpmnValidationResult badScope = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToRoleId="role-1"
                                   escalateOrgScope="宇宙"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(badScope.errors()).anyMatch(e -> e.contains("escalateOrgScope 不合法: 宇宙"));

        // fixedUnitId 出现在非 fixedUnit 范围
        BpmnValidationResult strayUnit = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToRoleId="role-1"
                                   escalateOrgScope="global" escalateFixedUnitId="unit-1"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(strayUnit.errors()).anyMatch(e -> e.contains("仅在指定部门(fixedUnit)范围有效"));

        // fixedUnit 范围缺 escalateFixedUnitId
        BpmnValidationResult missingUnit = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToRoleId="role-1"
                                   escalateOrgScope="fixedUnit"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(missingUnit.errors()).anyMatch(e -> e.contains("缺少 escalateFixedUnitId"));

        // 指定部门不存在
        UUID unitId = UUID.randomUUID();
        BpmnValidationResult unknownUnit = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToRoleId="role-1"
                                   escalateOrgScope="fixedUnit" escalateFixedUnitId="%s"/>
              </extensionElements>
            """.formatted(unitId)), UUID.randomUUID());
        assertThat(unknownUnit.errors()).anyMatch(e -> e.contains("指定部门不存在"));

        // 部门存在 + 角色属于本应用且 active → 通过
        UUID roleId = UUID.randomUUID();
        when(roleRepository.listByApp(any(UUID.class))).thenReturn(List.of(
            new AppRoleDto(roleId, UUID.randomUUID(), "升级角色", null, "active", null, null, null)));
        when(orgUnitRepository.findById(unitId)).thenReturn(Optional.of(
            new com.dsh.console.orgunit.dto.OrgUnitDto(unitId, "财务部", null, null, 0, null)));
        BpmnValidationResult ok = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToRoleId="%s"
                                   escalateOrgScope="fixedUnit" escalateFixedUnitId="%s"/>
              </extensionElements>
            """.formatted(roleId, unitId)), UUID.randomUUID());
        assertThat(ok.errors()).isEmpty();
    }

    @Test
    void timeoutEscalationRoleIdOwnership() {
        // escalateToRoleId 不属于本应用 → 拒绝(与 assignmentRule.candidateRoleId 同规)
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:timeoutPolicy duration="PT1H" escalateToRoleId="role-1"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("escalateToRoleId 不属于本应用: role-1"));
    }

    /**
     * 构造含 orgScope 实体角色 userTask 的 BPMN(带多实例)。
     *
     * @param orgScope   审批范围;null 表示不写该属性
     * @param fixedUnitId 指定部门 id;null 表示不写该属性
     */
    private String orgScopeBpmn(String orgScope, String fixedUnitId) {
        return orgScopeBpmn(orgScope, fixedUnitId, null);
    }

    /**
     * 构造含 orgScope 实体角色 userTask 的 BPMN(带多实例)。
     *
     * @param orgScope    审批范围;null 表示不写该属性
     * @param fixedUnitId 指定部门 id;null 表示不写该属性
     * @param roleId     实体角色 id;null 表示不写 candidateRoleId
     */
    private String orgScopeBpmn(String orgScope, String fixedUnitId, UUID roleId) {
        StringBuilder attrs = new StringBuilder();
        if (roleId != null) {
            attrs.append(" candidateRoleId=\"").append(roleId).append("\"");
        }
        if (orgScope != null) {
            attrs.append(" orgScope=\"").append(orgScope).append("\"");
        }
        if (fixedUnitId != null) {
            attrs.append(" fixedUnitId=\"").append(fixedUnitId).append("\"");
        }
        return userTaskBpmn("""
              <extensionElements>
                <dsh:assignmentRule%s/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false"/>
            """.formatted(attrs));
    }

    /** 构造含单个 userTask 的最小 BPMN,userTask 内部内容(多实例/扩展元素)自由拼装。 */
    private String userTaskBpmn(String userTaskInner) {
        return userTaskBpmn("", userTaskInner);
    }

    /**
     * 构造含单个 userTask 的最小 BPMN。
     *
     * @param processInner process 级内容(contextVariables 声明等;空串表示无)
     * @param userTaskInner userTask 内部内容(多实例/扩展元素)
     */
    private String userTaskBpmn(String processInner, String userTaskInner) {
        String processBlock = processInner.isBlank() ? "" : """
              %s
            """.formatted(processInner);
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="validation_test_process" isExecutable="true">
            %s
                <startEvent id="start" name="开始"/>
                <userTask id="task" name="任务" flowable:candidateUsers="user-a,user-b">
            %s
                </userTask>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="end"/>
                <endEvent id="end" name="结束"/>
              </process>
            </definitions>""".formatted(processBlock, userTaskInner);
    }

    // ===== 会签计票 votingRule(design 2026-09-15 §4.3) =====

    @Test
    void validVotingRulePasses() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <dsh:contextVariables>
                <dsh:contextVariable name="approved" type="boolean"/>
              </dsh:contextVariables>
            """, """
              <extensionElements>
                <dsh:outputMappings>
                  <dsh:mapping source="approved" target="approved"/>
                </dsh:outputMappings>
                <dsh:votingRule variable="approved" passValue="true" passCount="3" rejectCount="2"/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false"/>
            """), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void votingRuleVariableNotInOutputMappingsFails() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:votingRule variable="approved" passValue="true" passCount="3"/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false"/>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("不在本节点输出映射 target 中"));
    }

    @Test
    void votingRuleMissingRequiredAttributesFails() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:outputMappings>
                  <dsh:mapping source="approved" target="approved"/>
                </dsh:outputMappings>
                <dsh:votingRule variable="approved" passCount="0" rejectCount="x"/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false"/>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("缺少 passValue"))
            .anyMatch(e -> e.contains("passCount 必须为 >=1 的整数"))
            .anyMatch(e -> e.contains("rejectCount 必须为 >=1 的整数"));
    }

    @Test
    void votingRuleWithoutMultiInstanceFails() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:outputMappings>
                  <dsh:mapping source="approved" target="approved"/>
                </dsh:outputMappings>
                <dsh:votingRule variable="approved" passValue="true" passCount="3"/>
              </extensionElements>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("配了 votingRule(会签计票)但没有多实例"));
    }

    @Test
    void votingRuleWithManualCompletionConditionFails() {
        BpmnValidationResult result = service.validate(userTaskBpmn("""
              <extensionElements>
                <dsh:outputMappings>
                  <dsh:mapping source="approved" target="approved"/>
                </dsh:outputMappings>
                <dsh:votingRule variable="approved" passValue="true" passCount="3"/>
              </extensionElements>
              <multiInstanceLoopCharacteristics isSequential="false">
                <completionCondition>${nrOfCompletedInstances &gt;= 3}</completionCondition>
              </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("与手写 completionCondition 并存"));
    }

    @Test
    void gatewayConditionReferencingRuntimeCountersIsExempt() {
        // 网关条件引用运行时注入的计票/候选人变量(按任务 id 动态命名,不在声明面)→ 豁免
        BpmnValidationResult result = service.validate("""
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="validation_test_process" isExecutable="true">
                <startEvent id="start" name="开始"/>
                <userTask id="task" name="任务"/>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="decide">
                  <conditionExpression>${dsh_passCount_task &gt;= 3}</conditionExpression>
                </sequenceFlow>
                <exclusiveGateway id="decide"/>
              </process>
            </definitions>""", UUID.randomUUID());
        assertThat(result.errors())
            .noneMatch(e -> e.contains("引用未声明变量"));
    }

    // ===== skillRef 引用存在性(SkillHub namespace 绑定) =====

    @Test
    void skillRefWithoutBoundNamespaceFails() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(null)));
        BpmnValidationResult result = service.validate(bpmn("", """
            <dsh:skillRef>approval-helper</dsh:skillRef>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("未绑定 SkillHub namespace"));
    }

    @Test
    void skillRefNotInPublishedListFails() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app("enterprise")));
        when(skillHubRestClient.listNamespaceSkills("enterprise")).thenReturn(List.of(
            new SkillHubSkillDto("other-skill", "1.0.0", "其他技能", "2026-09-01T00:00:00Z")));
        BpmnValidationResult result = service.validate(bpmn("", """
            <dsh:skillRef>approval-helper</dsh:skillRef>
            """, null), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("已发布清单"))
            .anyMatch(e -> e.contains("approval-helper"));
    }

    @Test
    void noSkillRefSkipsSkillHubValidation() {
        // 无 skillRef 时未绑 namespace 也不报错(不触发 SkillHub 校验)
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app(null)));
        BpmnValidationResult result = service.validate(bpmn("", """
            <dsh:userPrompt text="确认"/>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void skillHubUnavailableFails() {
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app("enterprise")));
        when(skillHubRestClient.listNamespaceSkills("enterprise"))
            .thenThrow(new IllegalStateException("dsh.skillhub.api-token 未配置"));
        BpmnValidationResult result = service.validate(bpmn("", """
            <dsh:skillRef>approval-helper</dsh:skillRef>
            """, null), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("SkillHub 不可达或未配置"));
    }

    // ===== ServiceTask 多实例与三种 task 统一计票(2026-09-15) =====

    @Test
    void plainServiceTaskMultiInstanceMissingCollectionAndElementVariableFail() {
        BpmnValidationResult result = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", "", """
            <multiInstanceLoopCharacteristics isSequential="false"/>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("缺少 flowable:collection"))
            .anyMatch(e -> e.contains("缺少 flowable:elementVariable"));
    }

    @Test
    void plainServiceTaskCollectionMustBeDeclaredArrayVariable() {
        // 未声明
        BpmnValidationResult undeclared = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="invoice" type="string"/>
            """, """
            <multiInstanceLoopCharacteristics isSequential="false"
                flowable:collection="invoiceList" flowable:elementVariable="item"/>
            """), UUID.randomUUID());
        assertThat(undeclared.errors())
            .anyMatch(e -> e.contains("collection 引用未声明变量: invoiceList"));
        // 声明但非 array
        BpmnValidationResult notArray = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="invoiceList" type="string"/>
            """, """
            <multiInstanceLoopCharacteristics isSequential="false"
                flowable:collection="invoiceList" flowable:elementVariable="item"/>
            """), UUID.randomUUID());
        assertThat(notArray.errors())
            .anyMatch(e -> e.contains("必须是 array 类型") && e.contains("invoiceList"));
        // ${} 表达式形态拒绝(画布写纯变量名)
        BpmnValidationResult expressionForm = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="invoiceList" type="array" itemType="string"/>
            """, """
            <multiInstanceLoopCharacteristics isSequential="false"
                flowable:collection="${invoiceList}" flowable:elementVariable="item"/>
            """), UUID.randomUUID());
        assertThat(expressionForm.errors())
            .anyMatch(e -> e.contains("纯变量名"));
    }

    @Test
    void plainServiceTaskElementVariableCollisionRejected() {
        BpmnValidationResult result = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="invoiceList" type="array" itemType="string"/>
            """, """
            <multiInstanceLoopCharacteristics isSequential="false"
                flowable:collection="invoiceList" flowable:elementVariable="invoiceList"/>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("elementVariable=invoiceList 与已声明上下文变量重名"));
    }

    @Test
    void plainServiceTaskLoopCardinalityAndStandardLoopRejected() {
        BpmnValidationResult cardinality = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", "", """
            <multiInstanceLoopCharacteristics isSequential="false">
              <loopCardinality>5</loopCardinality>
            </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(cardinality.errors())
            .anyMatch(e -> e.contains("只支持集合形式"));

        BpmnValidationResult standardLoop = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", "", """
            <standardLoopCharacteristics/>
            """), UUID.randomUUID());
        assertThat(standardLoop.errors())
            .anyMatch(e -> e.contains("不支持循环重做"));
    }

    @Test
    void plainServiceTaskVotingRuleVariableMustBeDeclared() {
        BpmnValidationResult result = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="invoiceList" type="array" itemType="string"/>
            """, """
            <extensionElements>
              <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
            </extensionElements>
            <multiInstanceLoopCharacteristics isSequential="false"
                flowable:collection="invoiceList" flowable:elementVariable="item"/>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("votingRule.variable=approved 不是已声明的上下文变量"));
    }

    @Test
    void plainServiceTaskVotingRuleRequiresMultiInstanceAndRejectsManualCondition() {
        // 无多实例
        BpmnValidationResult noMi = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="approved" type="boolean"/>
            """, """
            <extensionElements>
              <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
            </extensionElements>
            """), UUID.randomUUID());
        assertThat(noMi.errors())
            .anyMatch(e -> e.contains("配了 votingRule(会签计票)但没有多实例"));

        // 手写完成条件并存
        BpmnValidationResult manual = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="approved" type="boolean"/>
            """, """
            <extensionElements>
              <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
            </extensionElements>
            <multiInstanceLoopCharacteristics isSequential="false"
                flowable:collection="approved" flowable:elementVariable="item">
              <completionCondition>${nrOfCompletedInstances &gt;= 2}</completionCondition>
            </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(manual.errors())
            .anyMatch(e -> e.contains("与手写 completionCondition 并存"));
    }

    @Test
    void plainServiceTaskMultiInstanceVotingHappyPathPasses() {
        BpmnValidationResult result = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="invoiceList" type="array" itemType="string"/>
            <dsh:contextVariable name="approved" type="boolean"/>
            """, """
            <extensionElements>
              <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
            </extensionElements>
            <multiInstanceLoopCharacteristics isSequential="false"
                flowable:collection="invoiceList" flowable:elementVariable="item"/>
            """), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void multiInstanceCompletionConditionReferenceChecked() {
        // 拼写错误(缺 s)在完成条件里被拦下
        BpmnValidationResult result = service.validate(serviceTaskBpmn(
            "${testDelegate}", "", """
            <dsh:contextVariable name="invoiceList" type="array" itemType="string"/>
            """, """
            <multiInstanceLoopCharacteristics isSequential="false"
                flowable:collection="invoiceList" flowable:elementVariable="item">
              <completionCondition>${nrOfCompletedInstance &gt;= 2}</completionCondition>
            </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("完成条件") && e.contains("引用未声明变量: nrOfCompletedInstance"));
    }

    @Test
    void backendTaskMultiInstanceProfileListMustMatchCardinality() {
        when(profileRepository.listActive()).thenReturn(List.of(
            activeProfile("http://backend-1:3190"),
            activeProfile("http://backend-2:3190")));
        BpmnValidationResult mismatch = service.validate(serviceTaskBpmn(
            "${dshBackendTaskDelegate}", "true", """
            <dsh:contextVariable name="approved" type="boolean"/>
            """, """
            <extensionElements>
              <dsh:backendTask>
                <dsh:backendProfile url="http://backend-1:3190"/>
                <dsh:backendProfile url="http://backend-2:3190"/>
              </dsh:backendTask>
            </extensionElements>
            <multiInstanceLoopCharacteristics isSequential="false">
              <loopCardinality>3</loopCardinality>
            </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(mismatch.errors())
            .anyMatch(e -> e.contains("profile 列表行数(2)与 loopCardinality(3)不一致"));

        // 缺列表
        BpmnValidationResult missing = service.validate(serviceTaskBpmn(
            "${dshBackendTaskDelegate}", "true", "", """
            <extensionElements>
              <dsh:backendTask/>
            </extensionElements>
            <multiInstanceLoopCharacteristics isSequential="false">
              <loopCardinality>3</loopCardinality>
            </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(missing.errors())
            .anyMatch(e -> e.contains("未配置 dsh:backendProfile 列表"));

        // 单实例属性与多实例并存
        BpmnValidationResult coexist = service.validate(serviceTaskBpmn(
            "${dshBackendTaskDelegate}", "true", "", """
            <extensionElements>
              <dsh:backendTask backendProfileUrl="http://backend-1:3190">
                <dsh:backendProfile url="http://backend-1:3190"/>
              </dsh:backendTask>
            </extensionElements>
            <multiInstanceLoopCharacteristics isSequential="false">
              <loopCardinality>1</loopCardinality>
            </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(coexist.errors())
            .anyMatch(e -> e.contains("backendProfileUrl 属性与多实例并存"));
    }

    @Test
    void backendTaskMultiInstanceVotingHappyPathPasses() {
        when(profileRepository.listActive()).thenReturn(List.of(
            activeProfile("http://backend-1:3190"),
            activeProfile("http://backend-2:3190"),
            activeProfile("http://backend-3:3190")));
        BpmnValidationResult result = service.validate(serviceTaskBpmn(
            "${dshBackendTaskDelegate}", "true", """
            <dsh:contextVariable name="approved" type="boolean"/>
            """, """
            <extensionElements>
              <dsh:backendTask>
                <dsh:backendProfile url="http://backend-1:3190"/>
                <dsh:backendProfile url="http://backend-2:3190"/>
                <dsh:backendProfile url="http://backend-3:3190"/>
              </dsh:backendTask>
              <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
              <dsh:outputMappings>
                <dsh:mapping source="approved" target="approved"/>
              </dsh:outputMappings>
            </extensionElements>
            <multiInstanceLoopCharacteristics isSequential="false">
              <loopCardinality>3</loopCardinality>
            </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void backendTaskMultiInstanceInactiveProfileRejected() {
        when(profileRepository.listActive())
            .thenReturn(List.of(activeProfile("http://backend-1:3190")));
        BpmnValidationResult result = service.validate(serviceTaskBpmn(
            "${dshBackendTaskDelegate}", "true", "", """
            <extensionElements>
              <dsh:backendTask>
                <dsh:backendProfile url="http://backend-1:3190"/>
                <dsh:backendProfile url="http://stale:3190"/>
              </dsh:backendTask>
            </extensionElements>
            <multiInstanceLoopCharacteristics isSequential="false">
              <loopCardinality>2</loopCardinality>
            </multiInstanceLoopCharacteristics>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("第 2 个 profile 不在注册表活跃实例中: http://stale:3190"));
    }

    /** 构造仅含 skillhubNamespace 的应用 DTO(其余字段与 skillRef 校验无关)。 */
    private static ApplicationDto app(String skillhubNamespace) {
        return new ApplicationDto(null, "app", null, null, skillhubNamespace,
            "active", List.of(), null, null, null, null);
    }

    /** 构造注册表活跃实例 DTO(校验只关心 url)。 */
    private static BackendProfileDto activeProfile(String url) {
        return new BackendProfileDto(UUID.randomUUID(), "backend-1", url,
            "deepseek-chat", "ws", null, null);
    }

    // ===== DSH backend task 专属校验(design 2026-09-14 §4) =====

    @Test
    void validBackendTaskPasses() {
        when(profileRepository.listActive())
            .thenReturn(List.of(activeProfile("http://backend-1:3190")));
        BpmnValidationResult result = service.validate(backendBpmn(
            "${dshBackendTaskDelegate}", "true", """
            <dsh:contextVariable name="invoiceAmount" type="float"/>
            """, """
            <dsh:backendTask backendProfileUrl="http://backend-1:3190"/>
            <dsh:userPrompt text="基于{{invoiceAmount}}生成摘要"/>
            """), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    @Test
    void backendTaskMissingUrlFails() {
        when(profileRepository.listActive())
            .thenReturn(List.of(activeProfile("http://backend-1:3190")));
        BpmnValidationResult result = service.validate(backendBpmn(
            "${dshBackendTaskDelegate}", "true", "", """
            <dsh:backendTask backendProfileUrl=""/>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("未配置 backendProfileUrl"));
    }

    @Test
    void backendTaskUrlNotInActiveRegistryFails() {
        when(profileRepository.listActive())
            .thenReturn(List.of(activeProfile("http://backend-1:3190")));
        BpmnValidationResult result = service.validate(backendBpmn(
            "${dshBackendTaskDelegate}", "true", "", """
            <dsh:backendTask backendProfileUrl="http://stale:3190"/>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("不在注册表活跃实例中"));
    }

    @Test
    void backendTaskWrongDelegateAndMissingAsyncFail() {
        when(profileRepository.listActive())
            .thenReturn(List.of(activeProfile("http://backend-1:3190")));
        BpmnValidationResult result = service.validate(backendBpmn(
            "${wrongDelegate}", "", "", """
            <dsh:backendTask backendProfileUrl="http://backend-1:3190"/>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("delegateExpression 必须固定为"))
            .anyMatch(e -> e.contains("必须为异步执行"));
    }

    @Test
    void backendTaskPromptAndMappingReferencesChecked() {
        when(profileRepository.listActive())
            .thenReturn(List.of(activeProfile("http://backend-1:3190")));
        BpmnValidationResult result = service.validate(backendBpmn(
            "${dshBackendTaskDelegate}", "true", "", """
            <dsh:backendTask backendProfileUrl="http://backend-1:3190"/>
            <dsh:userPrompt text="基于{{undeclaredVar}}生成摘要"/>
            <dsh:outputMappings>
              <dsh:mapping source="amount" target="alsoUndeclared"/>
            </dsh:outputMappings>
            """), UUID.randomUUID());
        assertThat(result.errors())
            .anyMatch(e -> e.contains("DSH backend task[id=task]")
                && e.contains("引用未声明变量: undeclaredVar"))
            .anyMatch(e -> e.contains("DSH backend task[id=task]")
                && e.contains("target 指向未声明变量: alsoUndeclared"));
    }

    @Test
    void backendTaskSkillRefsValidatedAgainstSkillHub() {
        when(profileRepository.listActive())
            .thenReturn(List.of(activeProfile("http://backend-1:3190")));
        when(appRepository.findById(any(UUID.class))).thenReturn(Optional.of(app("enterprise")));
        when(skillHubRestClient.listNamespaceSkills("enterprise")).thenReturn(List.of(
            new SkillHubSkillDto("other-skill", "1.0.0", "其他技能", "2026-09-01T00:00:00Z")));
        BpmnValidationResult result = service.validate(backendBpmn(
            "${dshBackendTaskDelegate}", "true", "", """
            <dsh:backendTask backendProfileUrl="http://backend-1:3190"/>
            <dsh:skillRef>invoice-extract</dsh:skillRef>
            """), UUID.randomUUID());
        assertThat(result.errors()).anyMatch(e -> e.contains("invoice-extract"));
    }

    @Test
    void backendTaskOutputMappingTargetReferencedByPromptPasses() {
        // backend task 是代码型节点(serviceTask),来源闭环整查豁免;prompt 引用与
        // 映射 target 的存在性仍校验——已声明变量被 prompt 引用且作映射 target 应通过
        when(profileRepository.listActive())
            .thenReturn(List.of(activeProfile("http://backend-1:3190")));
        BpmnValidationResult result = service.validate(backendBpmn(
            "${dshBackendTaskDelegate}", "true", """
            <dsh:contextVariable name="summary" type="string"/>
            """, """
            <dsh:backendTask backendProfileUrl="http://backend-1:3190"/>
            <dsh:userPrompt text="结果:{{summary}}"/>
            <dsh:outputMappings>
              <dsh:mapping source="text" target="summary"/>
            </dsh:outputMappings>
            """), UUID.randomUUID());
        assertThat(result.errors()).isEmpty();
    }

    /**
     * 构造含 serviceTask 的 BPMN。
     *
     * @param delegateExpression  flowable:delegateExpression 属性值
     * @param async               flowable:async 属性值(空串表示缺省)
     * @param contextVariablesXml process 级 dsh 上下文变量声明(空串表示无声明)
     * @param taskInner           serviceTask 内部全部子元素(extensionElements 与
     *                            multiInstanceLoopCharacteristics 等)
     */
    private String serviceTaskBpmn(String delegateExpression, String async,
                                   String contextVariablesXml, String taskInner) {
        String asyncAttr = async.isBlank() ? "" : " flowable:async=\"" + async + "\"";
        String contextBlock = contextVariablesXml.isBlank() ? "" : """
              <extensionElements>
                <dsh:contextVariables>
            %s
                </dsh:contextVariables>
              </extensionElements>""".formatted(contextVariablesXml);
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="service_validation_test" isExecutable="true">
            %s
                <startEvent id="start" name="开始"/>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="task"/>
                <serviceTask id="task" name="任务"
                             flowable:delegateExpression="%s"%s>
            %s
                </serviceTask>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="end"/>
                <endEvent id="end" name="结束"/>
              </process>
            </definitions>""".formatted(contextBlock, delegateExpression, asyncAttr, taskInner);
    }

    /**
     * 构造含单个 DSH backend task(serviceTask,无多实例)的最小 BPMN。
     *
     * @param delegateExpression   flowable:delegateExpression 属性值
     * @param async                flowable:async 属性值(空串表示缺省)
     * @param contextVariablesXml  process 级 dsh 上下文变量声明(空串表示无声明)
     * @param serviceTaskExtensions serviceTask extensionElements 内的 dsh: 扩展元素
     */
    private String backendBpmn(String delegateExpression, String async,
                               String contextVariablesXml, String serviceTaskExtensions) {
        String asyncAttr = async.isBlank() ? "" : " flowable:async=\"" + async + "\"";
        String contextBlock = contextVariablesXml.isBlank() ? "" : """
              <extensionElements>
                <dsh:contextVariables>
            %s
                </dsh:contextVariables>
              </extensionElements>""".formatted(contextVariablesXml);
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="backend_validation_test" isExecutable="true">
                <startEvent id="start" name="开始"/>
            %s
                <serviceTask id="task" name="后端任务"
                             flowable:delegateExpression="%s"%s>
                  <extensionElements>
            %s
                  </extensionElements>
                </serviceTask>
                <sequenceFlow id="flow1" sourceRef="start" targetRef="task"/>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="end"/>
                <endEvent id="end" name="结束"/>
              </process>
            </definitions>""".formatted(contextBlock, delegateExpression, asyncAttr,
            serviceTaskExtensions);
    }

    /**
     * 构造最小合法 BPMN:context 声明 + userTask(prompt/映射)+ 可选条件表达式。
     *
     * @param contextVariablesXml dsh:contextVariables 内部内容(含容器则传空串)
     * @param userTaskExtensions   userTask 的 dsh: 扩展元素(模板统一包 extensionElements)
     * @param conditionExpression sequenceFlow 条件表达式;null 表示无条件
     */
    private String bpmn(String contextVariablesXml, String userTaskExtensions,
                       String conditionExpression) {
        String contextBlock = contextVariablesXml.isBlank() ? "" : """
              <extensionElements>
            %s
              </extensionElements>""".formatted(contextVariablesXml);
        String flow1 = conditionExpression == null
            ? "<sequenceFlow id=\"flow1\" sourceRef=\"start\" targetRef=\"task\"/>"
            : """
                <sequenceFlow id="flow1" sourceRef="start" targetRef="task">
                  <conditionExpression>%s</conditionExpression>
                </sequenceFlow>""".formatted(conditionExpression);
        String taskBlock = userTaskExtensions.isBlank() ? "" : """
                  <extensionElements>
            %s
                  </extensionElements>""".formatted(userTaskExtensions);
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:flowable="http://flowable.org/bpmn"
                         xmlns:dsh="http://dsh.ai/bpmn"
                         targetNamespace="http://dsh.test">
              <process id="validation_test_process" isExecutable="true">
            %s
                <startEvent id="start" name="开始"/>
            %s
                <userTask id="task" name="任务" flowable:candidateUsers="user-a,user-b">
            %s
                </userTask>
                <sequenceFlow id="flow2" sourceRef="task" targetRef="end"/>
                <endEvent id="end" name="结束"/>
              </process>
            </definitions>""".formatted(contextBlock, flow1, taskBlock);
    }
}
