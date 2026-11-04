package com.dsh.console.workflow;

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
import com.dsh.console.workflow.BpmnContextParser.AssignmentRuleInfo;
import com.dsh.console.workflow.BpmnContextParser.ContextVariable;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * BPMN 校验服务。
 *
 * <p>对应 spec §12.10 应用隔离不变量 + §5.7 节点定义约束 + §13.4 应用隔离设计:
 * <ul>
 *   <li>BPMN 是合法 XML 且根元素是 definitions。</li>
 *   <li>节点标识完整性:所有流程节点(事件/任务/网关/子流程/调用活动)的 id 与
 *       name 必填(引擎日志与待办列表按其展示,缺失时运行期为 "[null(...)]")。</li>
 *   <li>每个 human 节点的 {@code flowable:candidateGroups} 或 {@code dsh:assignmentRule.candidateRoleId}
 *       引用的 role_id 必属于该 BPMN 所属应用。</li>
 *   <li>userTask 多实例 wiring(DSH 派发只认集合形式):配了
 *       {@code dsh:assignmentRule.candidateRoleId} 必须有多实例——否则引擎不注入
 *       多实例派发,任务退化为候选认领(成员共享一条待办),不符合「每成员一条待办」
 *       产品语义;多实例禁配 loopCardinality——计数形式会让引擎放弃补齐
 *       collection,任务无办理人挂起。</li>
 *   <li>userTask 至少要有候选角色或候选用户(spec §7.2 规则 1)。</li>
 *   <li>一个 BPMN 文件只允许一个 {@code <process>}:发布链路的 process key /
 *       上下文声明只取第一个,而整个 XML 原样部署进引擎,多 process 文件会静默
 *       半部署出管理面不可见的幽灵定义,直接拒绝发布。</li>
 *   <li>serviceTask 必须配 {@code flowable:delegateExpression} 或 {@code flowable:expression}
 *       之一(引擎 ServiceTaskParseHandler 两种都路由;spec §10.1 自动节点规则)。</li>
 *   <li>表达式面(flowable:expression / delegateExpression 属性、conditionExpression /
 *       completionCondition 正文)不得含全角弯引号(''):中文输入法高频误入,JUEL
 *       编译期才报错且被引擎包成无定位的 "Error parsing XML",必须在发布前拦下。</li>
 *   <li>userTask / DSH backend task 的 {@code dsh:skillRef}(元素正文,每 skill 一个)
 *       引用的 skill 必须在所属应用绑定的 SkillHub namespace 已发布清单内;流程不含
 *       任何 skillRef 时跳过(未绑 namespace 的应用不受影响)。含 skillRef 但应用未绑
 *       namespace、或 SkillHub 不可达/未配置时直接 fail。</li>
 *   <li>DSH backend task(design 2026-09-14 §4):backendProfileUrl 非空且命中
 *       注册表活跃实例;delegateExpression 固定 {@code ${dshBackendTaskDelegate}};
 *       flowable:async 必须为 true。prompt {@code {{}}} 引用与输出映射 target 的
 *       校验复用 Process Context 四查(扫描范围含 backend task)。</li>
 * </ul>
 *
 * <p>Process Context 发布校验五查(design 2026-09-01 §8):
 * <ol>
 *   <li>prompt 引用存在性:userTask 的 userPrompt {@code {{var.field}}} 占位符,
 *       根变量已声明且点路径沿字段清单合法。</li>
 *   <li>条件表达式引用存在性:网关/连线/Conditional 事件 {@code ${}} 静态解析,
 *       标识符已声明或属内置豁免(引擎多实例内置变量 + 应用隔离三变量);
 *       字符串字面量与成员访问名(属性/方法)不作为变量引用。</li>
 *   <li>映射 target 存在性:userTask 输出映射的 target 根变量已声明且点路径合法;
 *       指向系统注入变量(initiator)拒绝。</li>
 *   <li>变量引用来源闭环:prompt、条件表达式、消费声明引用的变量必有来源
 *       (start-param / system / initial / 输出映射 target / 产出声明 / 豁免);
 *       流程含代码型节点(delegate / 脚本 / DMN / receive / callActivity)时整体豁免。</li>
 *   <li>system 声明结构:initiator 的类型为 object、字段清单恰为
 *       userId/name/email(均 string),与启动时注入值对齐。</li>
 * </ol>
 */
@Service
public class BpmnValidationService {

    private static final String FLOWABLE_NS = "http://flowable.org/bpmn";
    private static final String BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
    private static final String DSH_NS = BpmnContextParser.DSH_NS;

    /** userPrompt 占位符 {@code {{var.field}}}(design §7)。 */
    private static final Pattern PROMPT_PLACEHOLDER = Pattern.compile("\\{\\{([^}]+)}}");

    /** JUEL 表达式 {@code ${...}}(design §7)。 */
    private static final Pattern JUEL_EXPRESSION = Pattern.compile("\\$\\{([^}]*)}");

    /** JUEL 内标识符(bean 名/变量名/方法名)。 */
    private static final Pattern IDENTIFIER = Pattern.compile("[a-zA-Z_][a-zA-Z0-9_]*");

    /**
     * 引用存在性与来源闭环的豁免标识符:多实例引擎内置变量 + 应用隔离三变量 +
     * 申请人主部门 + JUEL 语言字面量(null/true/false 不是变量引用)。
     */
    private static final Set<String> BUILTIN_IDENTIFIERS = Set.of(
        "nrOfInstances", "nrOfActiveInstances", "nrOfCompletedInstances", "loopCounter",
        "dsh_applicant_user_id", "dsh_app_id", "dsh_workflow_definition_id",
        "dsh_applicant_org_unit_id",
        "null", "true", "false");

    /**
     * 运行时注入变量的豁免前缀:候选人列表(dsh_candidates_*)与会签计票
     * (dsh_passCount_* / dsh_rejectCount_*,design 2026-09-15)按任务 id 动态命名,
     * 不在上下文声明面内,条件表达式直接引用时按前缀放行。
     */
    private static final List<String> RUNTIME_INJECTED_PREFIXES = List.of(
        "dsh_candidates_", "dsh_passCount_", "dsh_rejectCount_");

    private final AppRoleJdbcRepository roleRepository;
    private final ApplicationJdbcRepository appRepository;
    private final SkillHubRestClient skillHubRestClient;
    private final BackendProfileJdbcRepository profileRepository;
    private final OrgUnitJdbcRepository orgUnitRepository;

    public BpmnValidationService(AppRoleJdbcRepository roleRepository,
                                 ApplicationJdbcRepository appRepository,
                                 SkillHubRestClient skillHubRestClient,
                                 BackendProfileJdbcRepository profileRepository,
                                 OrgUnitJdbcRepository orgUnitRepository) {
        this.roleRepository = roleRepository;
        this.appRepository = appRepository;
        this.skillHubRestClient = skillHubRestClient;
        this.profileRepository = profileRepository;
        this.orgUnitRepository = orgUnitRepository;
    }

    /**
     * 校验 BPMN XML。
     *
     * @param bpmnXml   BPMN XML 字符串
     * @param appId     该 BPMN 所属应用 ID,用于校验 role_id 归属
     */
    public BpmnValidationResult validate(String bpmnXml, UUID appId) {
        if (bpmnXml == null || bpmnXml.isBlank()) {
            return BpmnValidationResult.fail("BPMN XML 不能为空");
        }

        Document doc;
        try {
            doc = BpmnContextParser.parseXml(bpmnXml);
        } catch (Exception e) {
            return BpmnValidationResult.fail("BPMN XML 解析失败: " + e.getMessage());
        }

        // 1) 根元素必须是 bpmn:definitions
        Element root = doc.getDocumentElement();
        if (!BPMN_NS.equals(root.getNamespaceURI()) || !"definitions".equals(root.getLocalName())) {
            return BpmnValidationResult.fail("根元素必须是 bpmn:definitions,实际: "
                + root.getNamespaceURI() + ":" + root.getLocalName());
        }

        List<String> errors = new ArrayList<>();

        // 1.5) 节点标识完整性:所有流程节点的 id、name 必填
        validateNodeIdentifiers(doc, errors);

        // 1.6) process 可执行性:isExecutable 必须显式为 true
        validateProcessExecutable(doc, errors);

        // 1.7) 单 process 约束:多 process 文件会静默半部署(第二个及之后的 process
        // 被真实部署进引擎,却不落 web-console 数据库,成为管理面不可见的幽灵定义)
        validateSingleProcess(doc, errors);

        // 2) 取本应用所有 role_id 集合,校验归属
        List<AppRoleDto> appRoles = roleRepository.listByApp(appId);
        Set<String> validRoleIds = appRoles.stream()
            .map(r -> r.id().toString())
            .collect(Collectors.toSet());
        Set<String> activeRoleIds = appRoles.stream()
            .filter(r -> "active".equals(r.status()))
            .map(r -> r.id().toString())
            .collect(Collectors.toSet());
        validateRoleReferences(root, validRoleIds, activeRoleIds, errors);

        // 2.2) userTask 必须有办理人来源(spec §7.2 规则 1):无候选角色的 userTask
        // 运行期无 assignee、不出现在任何人的待办,流程静默卡死且无报错
        validateUserTaskHasCandidateSource(doc, errors);

        // 2.4) 组织维度审批规则(design 2026-09-19 §5):范围/虚拟角色枚举合法、
        // 互斥(虚拟角色锁定同行政线)、fixedUnit 必填且部门存在
        validateOrgRoutingRules(doc, errors);

        // 2.4b) 超时升级策略:升级目标三选一互斥、虚拟角色枚举、
        // escalateOrgScope 枚举且 fixedUnit 必填且部门存在
        validateTimeoutPolicies(doc, errors);

        // 2.5) userTask 多实例 wiring(assignmentRule 必须多实例 + 禁 loopCardinality + 禁标准循环)
        validateUserTaskMultiInstanceWiring(doc, errors);

        // 2.6) 会签计票规则(design 2026-09-15 §4.3;三种 task 统一)
        validateVotingRules(doc, errors);

        // 2.7) ServiceTask 多实例(普通自动节点集合形式 + backend task 计数形式,2026-09-15)
        validateServiceTaskMultiInstance(doc, errors);

        // 3) serviceTask 必配 delegateExpression 或 expression
        validateServiceTaskImplementations(root, errors);

        // 3.5) 表达式面全角弯引号守卫
        validateNoCurlyQuotesInExpressions(doc, errors);

        // 4) Process Context 四查
        validateContextReferences(doc, errors);

        // 5) skillRef 引用存在性(SkillHub 已发布清单;流程不含 skillRef 时跳过)
        validateSkillReferences(doc, appId, errors);

        // 6) DSH backend task 专属校验(URL 注册表存在性 / delegate 绑定 / async)
        validateBackendTasks(doc, errors);

        if (errors.isEmpty()) {
            return BpmnValidationResult.ok();
        }
        return BpmnValidationResult.fail(errors);
    }

    // ===== 应用隔离与节点定义(原有) =====

    /**
     * 流程节点元素清单({@link #validateNodeIdentifiers}):事件/任务/网关/子流程/
     * 调用活动;连线(sequenceFlow)是图的边不是节点,不在标识检查范围。
     */
    private static final List<String> FLOW_NODE_TAGS = List.of(
        "startEvent", "endEvent", "intermediateCatchEvent", "intermediateThrowEvent", "boundaryEvent",
        "userTask", "serviceTask", "scriptTask", "manualTask", "receiveTask", "sendTask",
        "businessRuleTask", "callActivity", "subProcess",
        "exclusiveGateway", "parallelGateway", "inclusiveGateway", "eventGateway", "complexGateway");

    /**
     * 节点标识完整性:所有流程节点(事件/任务/网关/子流程/调用活动)的 id 与 name
     * 必填。引擎侧流程日志、待办列表、实例详情任务表按 name 展示、按 activityId
     * 定位,name 缺失时运行期表现为 "[null(...)]" 不可读;id 是 BPMN 强制属性,
     * 手改 XML 仍可能清空,一并拦下。getElementsByTagNameNS 递归覆盖子流程内节点。
     */
    private void validateNodeIdentifiers(Document doc, List<String> errors) {
        for (String tag : FLOW_NODE_TAGS) {
            NodeList nodes = doc.getElementsByTagNameNS(BPMN_NS, tag);
            for (int i = 0; i < nodes.getLength(); i++) {
                Element node = (Element) nodes.item(i);
                String id = node.getAttribute("id");
                String name = node.getAttribute("name");
                if (id.isBlank()) {
                    errors.add(String.format("%s[name=%s] 缺少 id(节点 ID 必填)", tag, name));
                }
                if (name.isBlank()) {
                    errors.add(String.format(
                        "%s[id=%s] 缺少 name(节点名称必填,流程日志与待办列表按其展示)", tag, id));
                }
            }
        }
    }

    /**
     * process 可执行性:{@code isExecutable} 必须显式为 true——false 的流程是纯
     * 建模文档,部署后引擎不生成可运行定义,发起实例报「流程不存在」。bpmn-js
     * 新建画布默认勾选,手改 XML 或误操作取消时在此拦下。
     */
    private void validateProcessExecutable(Document doc, List<String> errors) {
        NodeList processes = doc.getElementsByTagNameNS(BPMN_NS, "process");
        for (int i = 0; i < processes.getLength(); i++) {
            Element process = (Element) processes.item(i);
            String id = process.getAttribute("id");
            if (!"true".equals(process.getAttribute("isExecutable"))) {
                errors.add(String.format(
                    "process[id=%s] 的 isExecutable 必须为 true(false 的流程部署后无法发起实例)",
                    id));
            }
        }
    }

    /**
     * 单 process 约束:一个 BPMN 文件只允许一个 {@code <process>}。发布链路对
     * process key / 上下文声明只取第一个,而整个 XML 原样部署进引擎——第二个及
     * 之后的 process 会被真实部署却不落 web-console 数据库,成为管理面不可见、
     * 无法禁用/归档的「幽灵定义」,故直接拒绝(错误信息列出个数与各 process key,
     * 提示拆分文件);不做「警告后剥除」的宽模式——静默改写用户上传的 XML 比拒绝
     * 更容易埋坑。
     */
    private void validateSingleProcess(Document doc, List<String> errors) {
        NodeList processes = doc.getElementsByTagNameNS(BPMN_NS, "process");
        if (processes.getLength() <= 1) {
            return;
        }
        List<String> keys = new ArrayList<>();
        for (int i = 0; i < processes.getLength(); i++) {
            keys.add(((Element) processes.item(i)).getAttribute("id"));
        }
        errors.add(String.format(
            "BPMN 文件包含 %d 个 <process>(%s):一个文件只允许一个流程定义,"
                + "请拆分成多个文件分别发布",
            processes.getLength(), String.join(", ", keys)));
    }

    /**
     * userTask 办理人来源必填(spec §7.2 规则 1):每个 userTask 至少要有
     * {@code flowable:candidateGroups}/{@code flowable:candidateUsers} 或
     * {@code dsh:assignmentRule} 的任一候选来源(candidateRoleId / virtualRole /
     * orgScope / fixedUnitId)。全部缺失时任务运行期无 assignee、不出现在任何人的
     * 待办,流程静默卡死且无报错;前端属性面板必填只能防手工画布,XML 导入在此拦下。
     */
    private void validateUserTaskHasCandidateSource(Document doc, List<String> errors) {
        NodeList userTasks = doc.getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            String taskId = task.getAttribute("id");
            String taskName = task.getAttribute("name");

            boolean hasFlowableCandidates =
                hasText(task.getAttributeNS(FLOWABLE_NS, "candidateGroups"))
                    || hasText(task.getAttributeNS(FLOWABLE_NS, "candidateUsers"));
            boolean hasDshCandidates = false;
            NodeList dshAssignments = task.getElementsByTagNameNS(DSH_NS, "assignmentRule");
            for (int j = 0; j < dshAssignments.getLength(); j++) {
                Element ar = (Element) dshAssignments.item(j);
                if (hasText(ar.getAttribute("candidateRoleId"))
                    || hasText(ar.getAttribute("virtualRole"))
                    || hasText(ar.getAttribute("orgScope"))
                    || hasText(ar.getAttribute("fixedUnitId"))) {
                    hasDshCandidates = true;
                    break;
                }
            }
            if (!hasFlowableCandidates && !hasDshCandidates) {
                errors.add(String.format(
                    "userTask[id=%s, name=%s] 未配置办理人来源:请在属性面板选择候选角色,"
                        + "或配置 flowable:candidateGroups/candidateUsers;否则任务无人可领,"
                        + "流程将静默卡死",
                    taskId, taskName));
            }
        }
    }

    private void validateRoleReferences(Element root, Set<String> validRoleIds,
                                        Set<String> activeRoleIds, List<String> errors) {
        NodeList userTasks = root.getOwnerDocument().getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            String taskId = task.getAttribute("id");
            String taskName = task.getAttribute("name");

            // flowable:candidateGroups 引用的 role_id 必属本应用且为 active
            String candidateGroups = task.getAttributeNS(FLOWABLE_NS, "candidateGroups");
            if (candidateGroups != null && !candidateGroups.isBlank()) {
                for (String gid : candidateGroups.split(",")) {
                    String trimmed = gid.trim();
                    if (trimmed.isEmpty()) {
                        continue;
                    }
                    if (!validRoleIds.contains(trimmed)) {
                        errors.add(String.format(
                            "userTask[id=%s, name=%s] 的 candidateGroups 引用了不属于本应用的 role_id: %s (spec §12.10 应用隔离不变量)",
                            taskId, taskName, trimmed));
                    } else if (!activeRoleIds.contains(trimmed)) {
                        errors.add(String.format(
                            "userTask[id=%s, name=%s] 的 candidateGroups 引用了已停用的角色: %s(先启用角色再发布)",
                            taskId, taskName, trimmed));
                    }
                }
            }

            // dsh:assignmentRule.candidateRoleId 必属本应用且为 active
            NodeList dshAssignments = task.getElementsByTagNameNS(DSH_NS, "assignmentRule");
            for (int j = 0; j < dshAssignments.getLength(); j++) {
                Element ar = (Element) dshAssignments.item(j);
                String candidateRoleId = ar.getAttribute("candidateRoleId");
                if (candidateRoleId == null || candidateRoleId.isBlank()) {
                    continue;
                }
                if (!validRoleIds.contains(candidateRoleId)) {
                    errors.add(String.format(
                        "userTask[id=%s] 的 dsh:assignmentRule.candidateRoleId 不属于本应用: %s",
                        taskId, candidateRoleId));
                } else if (!activeRoleIds.contains(candidateRoleId)) {
                    errors.add(String.format(
                        "userTask[id=%s] 的 dsh:assignmentRule.candidateRoleId 引用了已停用的角色: %s(先启用角色再发布)",
                        taskId, candidateRoleId));
                }
            }

            // dsh:timeoutPolicy.escalateToRoleId 必属本应用且为 active(升级目标与办理人同规)
            NodeList dshTimeouts = task.getElementsByTagNameNS(DSH_NS, "timeoutPolicy");
            for (int j = 0; j < dshTimeouts.getLength(); j++) {
                Element tp = (Element) dshTimeouts.item(j);
                String escalateRoleId = tp.getAttribute("escalateToRoleId");
                if (escalateRoleId == null || escalateRoleId.isBlank()) {
                    continue;
                }
                if (!validRoleIds.contains(escalateRoleId)) {
                    errors.add(String.format(
                        "userTask[id=%s] 的 dsh:timeoutPolicy.escalateToRoleId 不属于本应用: %s",
                        taskId, escalateRoleId));
                } else if (!activeRoleIds.contains(escalateRoleId)) {
                    errors.add(String.format(
                        "userTask[id=%s] 的 dsh:timeoutPolicy.escalateToRoleId 引用了已停用的角色: %s(先启用角色再发布)",
                        taskId, escalateRoleId));
                }
            }
        }
    }

    // ===== 组织维度审批路由(design 2026-09-19 §5) =====

    /** 合法组织范围枚举(与引擎 DshCandidateResolver、前端属性面板对齐)。 */
    private static final Set<String> VALID_ORG_SCOPES = Set.of("sameLine", "fixedUnit", "global");

    /** 合法虚拟角色枚举(与引擎 DshCandidateResolver、前端属性面板对齐)。 */
    private static final Set<String> VALID_VIRTUAL_ROLES =
        Set.of("parent", "grandparent", "child", "grandchild");

    /** 超时升级目标合法虚拟角色(仅向上沿审批人行政线,design 2026-09-19 §5.2)。 */
    private static final Set<String> VALID_ESCALATE_VIRTUAL_ROLES =
        Set.of("parent", "grandparent");

    /**
     * 组织维度审批规则校验(design 2026-09-19 §5,任务 3.3):
     * <ul>
     *   <li>orgScope 枚举合法:sameLine / fixedUnit / global。</li>
     *   <li>virtualRole 枚举合法:parent / grandparent / child / grandchild,且不与
     *       candidateRoleId / orgScope / fixedUnitId 共存(虚拟角色锁定同行政线,
     *       纵向定位与横向范围二选一)。</li>
     *   <li>orgScope=fixedUnit:fixedUnitId 必填且部门存在(全局治理数据,发布时点验);
     *       其余范围配 fixedUnitId 拒绝。</li>
     *   <li>配了 orgScope(显式范围)而缺 candidateRoleId:无目标角色,拒绝。</li>
     * </ul>
     *
     * <p>sameLine 实体角色的存在性/停用由 {@link #validateRoleReferences} 复用
     * (candidateRoleId 全范围统一校验);存量无 orgScope 的节点不进任何分支(行为不变)。
     */
    private void validateOrgRoutingRules(Document doc, List<String> errors) {
        for (AssignmentRuleInfo rule : BpmnContextParser.parseAssignmentRules(doc)) {
            String where = String.format("userTask[id=%s, name=%s] 的审批规则",
                rule.taskId(), rule.taskName());

            if (rule.orgScope() != null && !VALID_ORG_SCOPES.contains(rule.orgScope())) {
                errors.add(where + " 的 orgScope 不合法: " + rule.orgScope()
                    + "(应为 sameLine/fixedUnit/global)");
            }
            if (rule.virtualRole() != null && !VALID_VIRTUAL_ROLES.contains(rule.virtualRole())) {
                errors.add(where + " 的 virtualRole 不合法: " + rule.virtualRole()
                    + "(应为 parent/grandparent/child/grandchild)");
            }

            if (rule.virtualRole() != null) {
                // 虚拟角色锁定同行政线:与横向范围/实体角色并存是矛盾配置
                if (rule.candidateRoleId() != null) {
                    errors.add(where + " 的虚拟角色不能与 candidateRoleId 并存"
                        + "(目标角色:实体角色或虚拟角色二选一)");
                }
                if (rule.orgScope() != null) {
                    errors.add(where + " 的虚拟角色已锁定同行政线,不能再配 orgScope");
                }
                if (rule.fixedUnitId() != null) {
                    errors.add(where + " 的虚拟角色已锁定同行政线,不能配 fixedUnitId");
                }
                continue;
            }

            if (rule.orgScope() != null && rule.candidateRoleId() == null) {
                errors.add(where + " 配置了审批范围 " + rule.orgScope()
                    + " 但缺少 candidateRoleId(先在属性面板选择目标角色)");
            }
            if ("fixedUnit".equals(rule.orgScope())) {
                if (rule.fixedUnitId() == null) {
                    errors.add(where + " 的指定部门范围缺少 fixedUnitId(先在属性面板选择部门)");
                } else {
                    validateFixedUnitExists(rule, where, errors);
                }
            } else if (rule.fixedUnitId() != null) {
                errors.add(where + " 的 fixedUnitId 仅在指定部门(fixedUnit)范围有效");
            }
        }
    }

    /** fixedUnitId 合法 UUID 且部门存在(全局组织树,发布时点验防运行期解析报错)。 */
    private void validateFixedUnitExists(AssignmentRuleInfo rule, String where, List<String> errors) {
        validateFixedUnitExists(rule.fixedUnitId(), where, errors);
    }

    private void validateFixedUnitExists(String fixedUnitId, String where, List<String> errors) {
        UUID unitId;
        try {
            unitId = UUID.fromString(fixedUnitId);
        } catch (IllegalArgumentException e) {
            errors.add(where + " 的 fixedUnitId 不是合法的部门 id: " + fixedUnitId);
            return;
        }
        if (orgUnitRepository.findById(unitId).isEmpty()) {
            errors.add(where + " 的指定部门不存在: " + fixedUnitId
                + "(部门可能已被删除,请重新选择)");
        }
    }

    /**
     * 超时升级策略校验(与办理人组织路由校验对称):
     * <ul>
     *   <li>升级目标三选一:escalateToUserId / escalateToVirtualRole / escalateToRoleId
     *       至多一个非空(引擎按优先级兜底,矛盾配置直接拒绝);虚拟角色仅 parent/grandparent。</li>
     *   <li>escalateOrgScope 枚举合法且仅在实体角色目标下有效;fixedUnit 时
     *       escalateFixedUnitId 必填且部门存在。</li>
     *   <li>escalateToVirtualRole / escalateToUserId 与 escalateOrgScope /
     *       escalateFixedUnitId 并存拒绝。</li>
     * </ul>
     */
    private void validateTimeoutPolicies(Document doc, List<String> errors) {
        NodeList userTasks = doc.getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            NodeList policies = task.getElementsByTagNameNS(DSH_NS, "timeoutPolicy");
            if (policies.getLength() == 0) {
                continue;
            }
            Element policy = (Element) policies.item(0);
            String where = String.format("userTask[id=%s, name=%s] 的超时升级策略",
                task.getAttribute("id"), task.getAttribute("name"));
            String toUserId = trimToNull(policy.getAttribute("escalateToUserId"));
            String toVirtualRole = trimToNull(policy.getAttribute("escalateToVirtualRole"));
            String toRoleId = trimToNull(policy.getAttribute("escalateToRoleId"));
            String orgScope = trimToNull(policy.getAttribute("escalateOrgScope"));
            String fixedUnitId = trimToNull(policy.getAttribute("escalateFixedUnitId"));

            int targets = (toUserId != null ? 1 : 0) + (toVirtualRole != null ? 1 : 0)
                + (toRoleId != null ? 1 : 0);
            if (targets > 1) {
                errors.add(where + " 的升级目标必须三选一"
                    + "(用户 ID / 虚拟角色 / 实体角色)");
                continue;
            }
            if (targets == 0) {
                // 未配置升级目标(仅超时时长):升级无从发生,其余属性按冗余拒绝
                if (orgScope != null || fixedUnitId != null) {
                    errors.add(where + " 未配置升级目标,不应出现 escalateOrgScope/fixedUnitId");
                }
                continue;
            }
            if (toVirtualRole != null) {
                if (!VALID_ESCALATE_VIRTUAL_ROLES.contains(toVirtualRole)) {
                    errors.add(where + " 的升级目标虚拟角色不合法: " + toVirtualRole
                        + "(应为 parent/grandparent)");
                }
                if (orgScope != null || fixedUnitId != null) {
                    errors.add(where + " 的升级目标虚拟角色沿审批人行政线解析,"
                        + "不应配 escalateOrgScope/fixedUnitId");
                }
                continue;
            }
            if (toUserId != null) {
                if (orgScope != null || fixedUnitId != null) {
                    errors.add(where + " 的升级目标用户直接指派,不应配 escalateOrgScope/fixedUnitId");
                }
                continue;
            }
            // 实体角色目标:范围校验(与 AssignmentRule 对称)
            if (orgScope != null && !VALID_ORG_SCOPES.contains(orgScope)) {
                errors.add(where + " 的 escalateOrgScope 不合法: " + orgScope
                    + "(应为 sameLine/fixedUnit/global)");
            }
            if (!"fixedUnit".equals(orgScope) && fixedUnitId != null) {
                errors.add(where + " 的 escalateFixedUnitId 仅在指定部门(fixedUnit)范围有效");
            }
            if ("fixedUnit".equals(orgScope)) {
                if (fixedUnitId == null) {
                    errors.add(where + " 的指定部门范围缺少 escalateFixedUnitId"
                        + "(先在属性面板选择部门)");
                } else {
                    validateFixedUnitExists(fixedUnitId, where, errors);
                }
            }
        }
    }

    private static String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /**
     * userTask 多实例 wiring 校验:DSH 待办派发只认集合形式,collection /
     * elementVariable / assignee 由引擎部署时按候选角色自动补齐
     * (flowable-engine 的 DshBpmnParseHandler,web-console 在设计侧提前守门)。
     * <ul>
     *   <li>配了 {@code dsh:assignmentRule.candidateRoleId} 但没有
     *       multiInstanceLoopCharacteristics:引擎不注入多实例派发,任务退化为
     *       DshTaskListener 的候选认领(成员共享一条待办),不符合产品语义
     *       「每成员一条待办」。</li>
     *   <li>多实例配了 loopCardinality(计数形式):引擎判定为设计师自配派发配置
     *       (engineProvidesCollection=false)放弃补齐 collection,任务无办理人挂起。</li>
     * </ul>
     */
    private void validateUserTaskMultiInstanceWiring(Document doc, List<String> errors) {
        NodeList userTasks = doc.getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            String taskId = task.getAttribute("id");
            String taskName = task.getAttribute("name");

            // 标准循环(Loop):重做语义与候选人派发/计票无关,画布已隐藏入口,
            // 手写 XML 直接拒绝(与 ServiceTask 对称,2026-09-15)
            if (task.getElementsByTagNameNS(BPMN_NS, "standardLoopCharacteristics").getLength() > 0) {
                errors.add(String.format(
                    "userTask[id=%s, name=%s] 配了标准循环(standardLoopCharacteristics):"
                        + "DSH 任务节点不支持循环重做,请用并行/串行多实例",
                    taskId, taskName));
            }

            NodeList multiInstances =
                task.getElementsByTagNameNS(BPMN_NS, "multiInstanceLoopCharacteristics");
            for (int j = 0; j < multiInstances.getLength(); j++) {
                NodeList cardinalities = ((Element) multiInstances.item(j))
                    .getElementsByTagNameNS(BPMN_NS, "loopCardinality");
                for (int k = 0; k < cardinalities.getLength(); k++) {
                    String cardinality = cardinalities.item(k).getTextContent();
                    if (cardinality != null && !cardinality.isBlank()) {
                        errors.add(String.format(
                            "userTask[id=%s, name=%s] 的多实例配置了 loopCardinality(计数形式;"
                            + "DSH 派发只认集合形式,实例数由候选角色成员数决定,请删除该配置)",
                            taskId, taskName));
                    }
                }
            }

            NodeList dshAssignments = task.getElementsByTagNameNS(DSH_NS, "assignmentRule");
            for (int j = 0; j < dshAssignments.getLength(); j++) {
                Element ar = (Element) dshAssignments.item(j);
                // 组织维度(design 2026-09-19):候选来源含实体角色/虚拟角色/组织范围任一,
                // 与引擎 hasDshCandidateRole 的判定对齐
                boolean hasCandidateSource = hasText(ar.getAttribute("candidateRoleId"))
                    || hasText(ar.getAttribute("virtualRole"))
                    || hasText(ar.getAttribute("orgScope"))
                    || hasText(ar.getAttribute("fixedUnitId"));
                if (!hasCandidateSource) {
                    continue;
                }
                if (multiInstances.getLength() == 0) {
                    errors.add(String.format(
                        "userTask[id=%s, name=%s] 配了审批规则但没有多实例:任务将以候选认领方式"
                            + "派发(成员共享一条待办),不符合「每成员一条待办」语义;"
                            + "请在扳手菜单选择并行/串行多实例",
                        taskId, taskName));
                }
            }
        }
    }

    /** 是否运行时注入变量(dsh_candidates_* / dsh_passCount_* / dsh_rejectCount_*)。 */
    private static boolean isRuntimeInjectedVariable(String id) {
        return RUNTIME_INJECTED_PREFIXES.stream().anyMatch(id::startsWith);
    }

    /** 非空白文本判定(assignmentRule 各候选来源属性)。 */
    private static boolean hasText(String s) {
        return s != null && !s.isBlank();
    }

    /**
     * 会签计票校验(design 2026-09-15 §4.3;三种 task 统一):
     * <ul>
     *   <li>必填属性非空:variable / passValue / passCount;passCount 为 >=1 整数,
     *       rejectCount 缺省或 >=1 整数。</li>
     *   <li>variable 归属:userTask / DSH backend task 必须在本节点输出映射 target
     *       根变量中(计票读的是提交/映射写入的变量,不在映射里就读不到票);
     *       普通 ServiceTask 必须是已声明的上下文变量(delegate 代码 setVariable
     *       写入,静态无法证伪写入)。</li>
     *   <li>votingRule 节点必须配多实例(计票语义只对多实例任务成立)。</li>
     *   <li>votingRule + 手写 completionCondition 并存拒绝:完成条件由引擎按
     *       计票规则自动生成,手写会被覆盖语义冲突。</li>
     * </ul>
     */
    private void validateVotingRules(Document doc, List<String> errors) {
        Map<String, ContextVariable> byName = declarationsByName(doc);
        for (String tag : new String[] {"userTask", "serviceTask"}) {
            NodeList tasks = doc.getElementsByTagNameNS(BPMN_NS, tag);
            for (int i = 0; i < tasks.getLength(); i++) {
                Element task = (Element) tasks.item(i);
                boolean backendTask = "serviceTask".equals(tag) && isBackendTask(task);
                String nodeKind = "userTask".equals(tag) ? "userTask"
                    : backendTask ? "DSH backend task" : "serviceTask";
                checkVotingRule(task, nodeKind, backendTask, byName, errors);
            }
        }
    }

    /** 单节点 votingRule 校验(必填属性 / variable 归属 / 必配多实例 / 禁手写完成条件)。 */
    private void checkVotingRule(Element task, String nodeKind, boolean backendTask,
                                 Map<String, ContextVariable> byName, List<String> errors) {
        NodeList votingRules = task.getElementsByTagNameNS(DSH_NS, "votingRule");
        if (votingRules.getLength() == 0) {
            return;
        }
        Element rule = (Element) votingRules.item(0);
        String taskId = task.getAttribute("id");
        String taskName = task.getAttribute("name");
        String where = String.format("%s[id=%s, name=%s]", nodeKind, taskId, taskName);

        String variable = rule.getAttribute("variable");
        String passValue = rule.getAttribute("passValue");
        String passCount = rule.getAttribute("passCount");
        String rejectCount = rule.getAttribute("rejectCount");

        if (variable.isBlank()) {
            errors.add(where + " 的 votingRule 缺少 variable(表决变量)");
        }
        if (passValue.isBlank()) {
            errors.add(where + " 的 votingRule 缺少 passValue(通过值)");
        }
        if (!isPositiveInteger(passCount)) {
            errors.add(where + " 的 votingRule passCount 必须为 >=1 的整数");
        }
        if (!rejectCount.isBlank() && !isPositiveInteger(rejectCount)) {
            errors.add(where + " 的 votingRule rejectCount 必须为 >=1 的整数(留空表示不设否决阈值)");
        }

        // variable 归属:有输出映射的节点(userTask / backend task)必须在映射 target 中;
        // 普通 ServiceTask 无映射机制,须为已声明上下文变量(delegate 代码写入)
        if (!variable.isBlank()) {
            if (backendTask || "userTask".equals(nodeKind)) {
                Set<String> mappingRoots = new HashSet<>();
                NodeList mappings = task.getElementsByTagNameNS(DSH_NS, "mapping");
                for (int j = 0; j < mappings.getLength(); j++) {
                    String target = ((Element) mappings.item(j)).getAttribute("target");
                    if (!target.isBlank()) {
                        mappingRoots.add(target.split("\\.")[0].trim());
                    }
                }
                if (!mappingRoots.contains(variable)) {
                    errors.add(String.format(
                        "%s 的 votingRule.variable=%s 不在本节点输出映射 target 中"
                            + "(先在 User Prompt 对话框为该变量配置输出映射)", where, variable));
                }
            } else {
                ContextVariable decl = byName.get(variable);
                if (decl == null) {
                    errors.add(String.format(
                        "%s 的 votingRule.variable=%s 不是已声明的上下文变量"
                            + "(delegate 代码须 setVariable 写入该表决变量)", where, variable));
                } else if (BpmnContextParser.SYSTEM_SOURCE.equals(decl.source())) {
                    errors.add(String.format(
                        "%s 的 votingRule.variable=%s 是系统注入变量,不允许作为表决变量", where, variable));
                }
            }
        }

        // 必须配多实例
        boolean hasMultiInstance = task.getElementsByTagNameNS(
            BPMN_NS, "multiInstanceLoopCharacteristics").getLength() > 0;
        if (!hasMultiInstance) {
            errors.add(where + " 配了 votingRule(会签计票)但没有多实例:计票语义只对多实例任务成立");
        }

        // 禁手写 completionCondition(引擎按计票规则自动生成)
        NodeList conditions = task.getElementsByTagNameNS(BPMN_NS, "completionCondition");
        for (int j = 0; j < conditions.getLength(); j++) {
            String text = conditions.item(j).getTextContent();
            if (text != null && !text.isBlank()) {
                errors.add(where + " 的 votingRule 与手写 completionCondition 并存:"
                    + "完成条件由引擎按计票规则自动生成,请删除手写的完成条件");
            }
        }
    }

    /** 流程级上下文声明按名索引(重名时保留首个,重名错误由 Process Context 五查报告)。 */
    private static Map<String, ContextVariable> declarationsByName(Document doc) {
        List<ContextVariable> declarations = BpmnContextParser.parseContextVariables(doc);
        Map<String, ContextVariable> byName = new LinkedHashMap<>();
        for (ContextVariable v : declarations) {
            if (v.name() != null) {
                byName.putIfAbsent(v.name(), v);
            }
        }
        return byName;
    }

    /**
     * ServiceTask 多实例校验(2026-09-15 三种 task 统一,普通自动节点集合形式 +
     * DSH backend task 计数形式):
     * <ul>
     *   <li>标准循环(standardLoopCharacteristics)拒绝:画布已隐藏入口,
     *       DSH 任务节点不支持循环重做。</li>
     *   <li>普通 ServiceTask:多实例只认集合形式——collection 必填且为已声明的
     *       array 上下文变量(纯变量名,不带 ${});elementVariable 必填且不与
     *       上下文变量重名(重名会遮蔽流程变量);loopCardinality 拒绝
     *       (计数形式绕开元素注入,delegate 读不到逐实例数据)。</li>
     *   <li>DSH backend task:多实例为计数形式——loopCardinality 必为 >=1 整数;
     *       backendProfile 列表非空、行数=实例数(第 i 实例绑第 i 个 URL,
     *       引擎按 loopCounter 取);单实例属性 backendProfileUrl 与多实例并存
     *       拒绝。URL 活跃性由 {@link #validateBackendTasks} 查注册表。</li>
     * </ul>
     */
    private void validateServiceTaskMultiInstance(Document doc, List<String> errors) {
        Map<String, ContextVariable> byName = declarationsByName(doc);
        NodeList serviceTasks = doc.getElementsByTagNameNS(BPMN_NS, "serviceTask");
        for (int i = 0; i < serviceTasks.getLength(); i++) {
            Element task = (Element) serviceTasks.item(i);
            String where = String.format("serviceTask[id=%s, name=%s]",
                task.getAttribute("id"), task.getAttribute("name"));

            if (task.getElementsByTagNameNS(BPMN_NS, "standardLoopCharacteristics").getLength() > 0) {
                errors.add(where + " 配了标准循环(standardLoopCharacteristics):"
                    + "DSH 任务节点不支持循环重做,请用并行/串行多实例");
            }

            NodeList multiInstances =
                task.getElementsByTagNameNS(BPMN_NS, "multiInstanceLoopCharacteristics");
            if (multiInstances.getLength() == 0) {
                continue;
            }
            Element loop = (Element) multiInstances.item(0);
            String cardinality = loopText(loop, "loopCardinality");

            if (isBackendTask(task)) {
                if (!isPositiveInteger(cardinality)) {
                    errors.add(where + " 的多实例 loopCardinality 必须为 >=1 的整数"
                        + "(属性面板的 profile 列表行数自动同步实例数)");
                    continue;
                }
                List<String> profileUrls = backendProfileUrls(task);
                if (profileUrls == null) {
                    errors.add(where + " 的多实例未配置 dsh:backendProfile 列表"
                        + "(每实例绑定一个 backend profile,行数=实例数)");
                    continue;
                }
                if (profileUrls.size() != Integer.parseInt(cardinality.trim())) {
                    errors.add(String.format(
                        "%s 的多实例 profile 列表行数(%d)与 loopCardinality(%s)不一致"
                            + "(增删列表行会自动同步实例数)", where, profileUrls.size(), cardinality.trim()));
                }
                String attrUrl = dshChildren(task, "backendTask").get(0)
                    .getAttribute("backendProfileUrl");
                if (attrUrl != null && !attrUrl.isBlank()) {
                    errors.add(where + " 的 backendProfileUrl 属性与多实例并存:"
                        + "多实例请改用 dsh:backendProfile 列表(属性是单实例形态)");
                }
            } else {
                if (cardinality != null && !cardinality.isBlank()) {
                    errors.add(where + " 的多实例配了 loopCardinality(计数形式):"
                        + "普通 ServiceTask 多实例只支持集合形式(collection 选择 array 变量,"
                        + "实例数=数组长度,引擎逐实例注入元素)");
                    continue;
                }
                String collection = loop.getAttributeNS(FLOWABLE_NS, "collection");
                if (collection == null || collection.isBlank()) {
                    errors.add(where + " 的多实例缺少 flowable:collection"
                        + "(在「多实例(集合)」组选择已声明的 array 上下文变量)");
                } else if (collection.contains("${")) {
                    errors.add(where + " 的 flowable:collection 请填纯变量名(不带 ${})"
                        + "——" + collection);
                } else {
                    ContextVariable decl = byName.get(collection.trim());
                    if (decl == null) {
                        errors.add(where + " 的 flowable:collection 引用未声明变量: "
                            + collection.trim() + "(先在「上下文变量」面板声明)");
                    } else if (!"array".equals(decl.type())) {
                        errors.add(where + " 的 flowable:collection 必须是 array 类型的上下文变量,"
                            + "实际: " + collection.trim() + "(" + decl.type() + ")");
                    }
                }
                String elementVariable = loop.getAttributeNS(FLOWABLE_NS, "elementVariable");
                if (elementVariable == null || elementVariable.isBlank()) {
                    errors.add(where + " 的多实例缺少 flowable:elementVariable"
                        + "(引擎逐实例注入的元素变量名,须与 Java 代码 getVariable 读取名一致)");
                } else if (byName.containsKey(elementVariable.trim())) {
                    errors.add(where + " 的 flowable:elementVariable=" + elementVariable.trim()
                        + " 与已声明上下文变量重名(实例内会遮蔽流程变量,请换名)");
                }
            }
        }
    }

    /** multiInstanceLoopCharacteristics 下指定子元素的正文文本;无该子元素返回 null。 */
    private static String loopText(Element loop, String localName) {
        NodeList children = loop.getElementsByTagNameNS(BPMN_NS, localName);
        if (children.getLength() == 0) {
            return null;
        }
        return children.item(0).getTextContent();
    }

    /**
     * DSH backend task 的多实例 profile URL 序列(第 i 个实例绑第 i 个);
     * 无 {@code dsh:backendProfile} 子元素返回 null,行 url 为空的行以空串占位。
     */
    private static List<String> backendProfileUrls(Element serviceTask) {
        List<Element> backendTasks = dshChildren(serviceTask, "backendTask");
        if (backendTasks.isEmpty()) {
            return null;
        }
        List<Element> profiles = dshChildren(backendTasks.get(0), "backendProfile");
        if (profiles.isEmpty()) {
            return null;
        }
        List<String> urls = new ArrayList<>(profiles.size());
        for (Element profile : profiles) {
            urls.add(profile.getAttribute("url"));
        }
        return urls;
    }

    /** 空串/正整数判定(votingRule 票数属性)。 */
    private static boolean isPositiveInteger(String s) {
        return !s.isBlank() && s.matches("\\d+") && Integer.parseInt(s) >= 1;
    }

    /**
     * 解析 BPMN XML 中引用的全部角色 ID(candidateGroups + assignmentRule.candidateRoleId)。
     *
     * <p>供角色停用守卫解析运行中实例所执行的流程版本使用;
     * 解析失败返回空集(发布路径的合法性由 {@link #validate} 把关)。
     */
    public Set<String> parseRoleReferences(String bpmnXml) {
        Set<String> refs = new HashSet<>();
        if (bpmnXml == null || bpmnXml.isBlank()) {
            return refs;
        }
        Document doc;
        try {
            doc = BpmnContextParser.parseXml(bpmnXml);
        } catch (Exception e) {
            return refs;
        }
        NodeList userTasks = doc.getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            String candidateGroups = task.getAttributeNS(FLOWABLE_NS, "candidateGroups");
            if (candidateGroups != null && !candidateGroups.isBlank()) {
                for (String gid : candidateGroups.split(",")) {
                    String trimmed = gid.trim();
                    if (!trimmed.isEmpty()) {
                        refs.add(trimmed);
                    }
                }
            }
            NodeList dshAssignments = task.getElementsByTagNameNS(DSH_NS, "assignmentRule");
            for (int j = 0; j < dshAssignments.getLength(); j++) {
                Element ar = (Element) dshAssignments.item(j);
                String candidateRoleId = ar.getAttribute("candidateRoleId");
                if (candidateRoleId != null && !candidateRoleId.isBlank()) {
                    refs.add(candidateRoleId.trim());
                }
            }
        }
        return refs;
    }

    private void validateServiceTaskImplementations(Element root, List<String> errors) {
        NodeList serviceTasks = root.getOwnerDocument().getElementsByTagNameNS(BPMN_NS, "serviceTask");
        for (int i = 0; i < serviceTasks.getLength(); i++) {
            Element task = (Element) serviceTasks.item(i);
            String delegate = task.getAttributeNS(FLOWABLE_NS, "delegateExpression");
            String expression = task.getAttributeNS(FLOWABLE_NS, "expression");
            if ((delegate == null || delegate.isBlank()) && (expression == null || expression.isBlank())) {
                errors.add(String.format(
                    "serviceTask[id=%s, name=%s] 缺少 flowable:delegateExpression 或 flowable:expression(spec §10.1 自动节点规则)",
                    task.getAttribute("id"), task.getAttribute("name")));
            }
        }
    }

    /**
     * 表达式面全角弯引号守卫:扫描 flowable:expression / flowable:delegateExpression
     * 属性值与 conditionExpression / completionCondition 元素正文。
     *
     * <p>弯引号('' U+2018/U+2019)是合法 XML 属性字符,画布与引擎 XML 解析层全部放行,
     * 直到引擎 JUEL 编译表达式才词法报错,且异常被 BpmnParse 包成无定位信息的
     * "Error parsing XML"。常见来源是中文输入法把半角单引号打成全角弯引号。
     */
    private void validateNoCurlyQuotesInExpressions(Document doc, List<String> errors) {
        NodeList all = doc.getElementsByTagName("*");
        for (int i = 0; i < all.getLength(); i++) {
            Element el = (Element) all.item(i);
            String id = el.getAttribute("id");
            String where = el.getLocalName() + (id.isBlank() ? "" : "[" + id + "]");
            String expression = el.getAttributeNS(FLOWABLE_NS, "expression");
            String delegate = el.getAttributeNS(FLOWABLE_NS, "delegateExpression");
            if (containsCurlyQuote(expression) || containsCurlyQuote(delegate)) {
                errors.add(where + " 的 flowable:expression/delegateExpression 含全角弯引号(''),"
                    + "请改为半角单引号 '(常见于中文输入法误入)");
            }
            if (BPMN_NS.equals(el.getNamespaceURI())
                    && ("conditionExpression".equals(el.getLocalName())
                        || "completionCondition".equals(el.getLocalName()))
                    && containsCurlyQuote(el.getTextContent())) {
                errors.add(where + " 条件表达式含全角弯引号(''),请改为半角单引号 '(常见于中文输入法误入)");
            }
        }
    }

    private static boolean containsCurlyQuote(String s) {
        return s != null && (s.indexOf('\u2018') >= 0 || s.indexOf('\u2019') >= 0);
    }

    /**
     * 收集 BPMN XML 全部节点(userTask + DSH backend task)的非空 {@code dsh:skillRef}
     * 值(去重、保持出现顺序)。
     *
     * <p>供应用换绑/清除 namespace 的守卫复用;XML 无法解析时返回空集,
     * 损坏定义由发布校验负责报错,不在绑定时阻断。
     *
     * @param bpmnXml BPMN XML 字符串;null/空白视为无引用
     * @returns 非空 skill 名集合
     */
    public static Set<String> collectSkillRefs(String bpmnXml) {
        Set<String> skills = new LinkedHashSet<>();
        if (bpmnXml == null || bpmnXml.isBlank()) {
            return skills;
        }
        Document doc;
        try {
            doc = BpmnContextParser.parseXml(bpmnXml);
        } catch (Exception e) {
            return skills;
        }
        Map<String, List<String>> nodeSkills = new LinkedHashMap<>();
        collectSkillRefsInto(doc, "userTask", "userTask", nodeSkills);
        collectSkillRefsInto(doc, "serviceTask", "DSH backend task", nodeSkills);
        nodeSkills.values().forEach(skills::addAll);
        return skills;
    }

    /**
     * 遍历指定 tag 的节点收集非空 {@code dsh:skillRef} 到 nodeSkills
     * (位置 → skill 名列表);serviceTask 仅收 DSH backend task(普通自动节点的
     * 悬空 skillRef 引擎不解析,不参与校验)。
     */
    private static void collectSkillRefsInto(Document doc, String tag, String nodeKind,
                                             Map<String, List<String>> nodeSkills) {
        NodeList nodes = doc.getElementsByTagNameNS(BPMN_NS, tag);
        for (int i = 0; i < nodes.getLength(); i++) {
            Element task = (Element) nodes.item(i);
            if ("serviceTask".equals(tag) && !isBackendTask(task)) {
                continue;
            }
            List<String> skills = new ArrayList<>();
            for (Element ref : dshChildren(task, "skillRef")) {
                String name = ref.getTextContent();
                if (name != null && !name.isBlank()) {
                    skills.add(name.trim());
                }
            }
            if (!skills.isEmpty()) {
                String location = nodeKind + "[id=" + task.getAttribute("id") + ", name="
                    + task.getAttribute("name") + "]";
                nodeSkills.put(location, skills);
            }
        }
    }

    /**
     * skillRef 引用存在性:userTask 的 {@code dsh:skillRef} 元素正文(每 skill 一个,
     * 与引擎 DshBpmnExtensionParser / 前端 dsh-moddle 对齐)须在所属应用绑定的
     * SkillHub namespace 已发布清单(slug 集合)内。
     *
     * <p>流程不含任何 skillRef 时跳过全部检查(未绑 namespace 的应用不受影响)。
     * 含 skillRef 时:应用未绑 namespace、SkillHub 拉清单失败(token 未配置 /
     * 不可达)均 fail;缺失 skill 聚合为一条错误消息。
     */
    private void validateSkillReferences(Document doc, UUID appId, List<String> errors) {
        // 收集各节点(userTask + DSH backend task)的非空 skillRef(节点位置 → skill 名)
        Map<String, List<String>> nodeSkills = new LinkedHashMap<>();
        collectSkillRefsInto(doc, "userTask", "userTask", nodeSkills);
        collectSkillRefsInto(doc, "serviceTask", "DSH backend task", nodeSkills);
        if (nodeSkills.isEmpty()) {
            return;
        }

        ApplicationDto app = appRepository.findById(appId).orElse(null);
        String namespace = app == null ? null : app.skillhubNamespace();
        if (namespace == null || namespace.isBlank()) {
            errors.add("节点配置了 skill 引用但所属应用未绑定 SkillHub namespace(先在应用管理配置)");
            return;
        }

        List<SkillHubSkillDto> available;
        try {
            available = skillHubRestClient.listNamespaceSkills(namespace);
        } catch (Exception e) {
            errors.add("SkillHub 不可达或未配置,无法校验 skill 引用: " + e.getMessage());
            return;
        }
        Set<String> slugs = available.stream()
            .map(SkillHubSkillDto::slug)
            .collect(Collectors.toSet());

        // 聚合:缺失 skill 名 → 引用它的节点位置
        Map<String, List<String>> missingBySkill = new LinkedHashMap<>();
        nodeSkills.forEach((location, skills) -> {
            for (String skill : skills) {
                if (!slugs.contains(skill)) {
                    missingBySkill.computeIfAbsent(skill, k -> new ArrayList<>()).add(location);
                }
            }
        });
        if (!missingBySkill.isEmpty()) {
            String detail = missingBySkill.entrySet().stream()
                .map(e -> e.getKey() + "(引用: " + String.join("、", e.getValue()) + ")")
                .collect(Collectors.joining("; "));
            errors.add(String.format(
                "skill 引用不在应用绑定的 SkillHub namespace(%s)已发布清单中: %s", namespace, detail));
        }
    }

    // ===== DSH backend task 校验(design 2026-09-14 §4) =====

    /** DSH backend task 的固定 delegate 绑定(与前端 palette、引擎 delegate bean 名对齐)。 */
    private static final String BACKEND_DELEGATE_EXPRESSION = "${dshBackendTaskDelegate}";

    /** serviceTask 含 {@code dsh:backendTask} 扩展即为 DSH backend task。 */
    private static boolean isBackendTask(Element serviceTask) {
        return !dshChildren(serviceTask, "backendTask").isEmpty();
    }

    /**
     * DSH backend task 专属校验(design 2026-09-14 §4):
     * <ul>
     *   <li>backendProfileUrl 非空且命中注册表活跃实例(心跳 5 分钟内)。</li>
     *   <li>delegateExpression 固定为 {@code ${dshBackendTaskDelegate}}(防手改 XML
     *       破坏绑定)。</li>
     *   <li>async 必须为 true(长任务走 async job,失败重试依赖此开关)。</li>
     * </ul>
     *
     * <p>prompt {@code {{}}} 引用、输出映射 target、skillRefs 的校验分别复用
     * Process Context 四查与 skillRef 存在性检查(扫描范围已扩展到 backend task)。
     */
    private void validateBackendTasks(Document doc, List<String> errors) {
        NodeList serviceTasks = doc.getElementsByTagNameNS(BPMN_NS, "serviceTask");
        List<Element> backendTasks = new ArrayList<>();
        for (int i = 0; i < serviceTasks.getLength(); i++) {
            Element task = (Element) serviceTasks.item(i);
            if (isBackendTask(task)) {
                backendTasks.add(task);
            }
        }
        if (backendTasks.isEmpty()) {
            return;
        }

        Set<String> activeUrls = profileRepository.listActive().stream()
            .map(BackendProfileDto::url)
            .collect(Collectors.toSet());

        for (Element task : backendTasks) {
            String location = "DSH backend task[id=" + task.getAttribute("id")
                + ", name=" + task.getAttribute("name") + "]";
            // profile 存在性:单实例查 backendProfileUrl 属性;多实例逐行查
            // dsh:backendProfile 列表(结构合法性由 validateServiceTaskMultiInstance 把关)
            boolean multiInstance = task.getElementsByTagNameNS(
                BPMN_NS, "multiInstanceLoopCharacteristics").getLength() > 0;
            if (multiInstance) {
                List<String> profileUrls = backendProfileUrls(task);
                if (profileUrls != null) {
                    for (int i = 0; i < profileUrls.size(); i++) {
                        String url = profileUrls.get(i);
                        if (url == null || url.isBlank()) {
                            errors.add(location + " 的第 " + (i + 1) + " 个 profile 未选择实例");
                        } else if (!activeUrls.contains(url.trim())) {
                            errors.add(location + " 的第 " + (i + 1) + " 个 profile 不在注册表活跃实例中: "
                                + url.trim() + "(实例需启动并心跳 5 分钟内;若实例已迁移需更新后重新发布)");
                        }
                    }
                }
            } else {
                String url = attrOrNull(dshChildren(task, "backendTask").get(0), "backendProfileUrl");
                if (url == null) {
                    errors.add(location + " 未配置 backendProfileUrl(先在属性面板选择 backend profile 实例)");
                } else if (!activeUrls.contains(url)) {
                    errors.add(location + " 的 backendProfileUrl 不在注册表活跃实例中: " + url
                        + "(实例需启动并心跳 5 分钟内;若实例已迁移需更新后重新发布)");
                }
            }
            String delegate = task.getAttributeNS(FLOWABLE_NS, "delegateExpression");
            if (!BACKEND_DELEGATE_EXPRESSION.equals(delegate)) {
                errors.add(location + " 的 delegateExpression 必须固定为 "
                    + BACKEND_DELEGATE_EXPRESSION + ",实际: " + (delegate.isBlank() ? "(空)" : delegate));
            }
            if (!"true".equals(task.getAttributeNS(FLOWABLE_NS, "async"))) {
                errors.add(location + " 必须为异步执行(flowable:async=\"true\",失败重试依赖 async job)");
            }
        }
    }

    // ===== Process Context 五查(design 2026-09-01 §8) =====

    private void validateContextReferences(Document doc, List<String> errors) {
        List<ContextVariable> declarations = BpmnContextParser.parseContextVariables(doc);
        Map<String, ContextVariable> byName = declarations.stream()
            .filter(v -> v.name() != null)
            .collect(Collectors.toMap(ContextVariable::name, v -> v, (a, b) -> a));

        // 重名声明直接报错(流程内唯一)
        Set<String> seen = new HashSet<>();
        for (ContextVariable v : declarations) {
            if (v.name() != null && !seen.add(v.name())) {
                errors.add("上下文变量重名: " + v.name());
            }
        }

        // 来源集:start-param / system / initial / 输出映射 target 根 / 豁免
        Set<String> sources = new LinkedHashSet<>();
        for (ContextVariable v : declarations) {
            if ("start-param".equals(v.source())
                || (v.initialValue() != null && !v.initialValue().isBlank())) {
                sources.add(v.name());
            }
            if (BpmnContextParser.SYSTEM_SOURCE.equals(v.source())) {
                validateSystemVariable(v, errors);
                sources.add(v.name());
            }
        }

        // 引用集 + 查 1/3(userTask 遍历一次完成:prompt 引用 + 映射 target,
        // 映射 target 根同时计入来源集)
        Set<String> referenced = new LinkedHashSet<>();

        NodeList userTasks = doc.getElementsByTagNameNS(BPMN_NS, "userTask");
        for (int i = 0; i < userTasks.getLength(); i++) {
            Element task = (Element) userTasks.item(i);
            String location = "userTask[id=" + task.getAttribute("id") + "]";
            checkPromptReferences(task, location, byName, referenced, errors);
            checkOutputMappings(task, location, byName, sources, errors);
        }

        // DSH backend task 的 prompt 引用与输出映射同查(同为产出节点,
        // 映射 target 计入来源集;design 2026-09-14 §4)
        NodeList serviceTasks = doc.getElementsByTagNameNS(BPMN_NS, "serviceTask");
        for (int i = 0; i < serviceTasks.getLength(); i++) {
            Element task = (Element) serviceTasks.item(i);
            if (!isBackendTask(task)) {
                continue;
            }
            String location = "DSH backend task[id=" + task.getAttribute("id") + "]";
            checkPromptReferences(task, location, byName, referenced, errors);
            checkOutputMappings(task, location, byName, sources, errors);
        }

        // 查 2:条件表达式(sequenceFlow / conditionalEvent)
        checkConditionExpressions(doc, byName, referenced, errors);

        // 查 4:来源闭环。流程含代码型节点(delegate / 脚本 / DMN / receive / callActivity)时豁免:
        // 这些节点在代码或输出列里 setVariable,写什么由代码本身表达(design §6),
        // 静态分析无法证伪,强查只会误报(如 DMN 产出 level)。
        if (!hasCodeNodes(doc)) {
            for (String ref : referenced) {
                if (!sources.contains(ref)) {
                    errors.add(String.format(
                        "变量 %s 被引用但没有来源(start-param / 初始值 / 输出映射均无)", ref));
                }
            }
        }
    }

    /** 流程中存在会写流程变量的代码型节点(service / send / script / businessRule / receive / callActivity)。 */
    private static boolean hasCodeNodes(Document doc) {
        for (String tag : new String[] {"serviceTask", "sendTask", "scriptTask",
            "businessRuleTask", "receiveTask", "callActivity"}) {
            if (doc.getElementsByTagNameNS(BPMN_NS, tag).getLength() > 0) {
                return true;
            }
        }
        return false;
    }

    /** 查 1:userPrompt {{}} 占位符——根变量已声明、点路径沿字段清单合法。 */
    private void checkPromptReferences(Element userTask, String location,
                                       Map<String, ContextVariable> byName,
                                       Set<String> referenced, List<String> errors) {
        for (String prompt : dshPrompts(userTask)) {
            Matcher m = PROMPT_PLACEHOLDER.matcher(prompt);
            while (m.find()) {
                String path = m.group(1).trim();
                String rootName = rootSegment(path);
                ContextVariable decl = byName.get(rootName);
                if (decl == null) {
                    errors.add(String.format(
                        "%s 的 userPrompt 引用未声明变量: %s(先在「上下文变量」面板声明)", location, rootName));
                    continue;
                }
                referenced.add(rootName);
                checkFieldPath(location, "userPrompt", path, decl, errors);
            }
        }
    }

    /** 查 5:system 声明结构——当前唯一 system 注入器是发起人变量。 */
    private static void validateSystemVariable(ContextVariable v, List<String> errors) {
        if (!BpmnContextParser.INITIATOR_VARIABLE_NAME.equals(v.name())) {
            errors.add("source=system 的变量当前仅支持 "
                + BpmnContextParser.INITIATOR_VARIABLE_NAME + ",实际: " + v.name());
            return;
        }
        if (!"object".equals(v.type())) {
            errors.add(String.format(
                "%s 声明必须为 object 类型,实际: %s", v.name(), v.type()));
            return;
        }
        Set<String> fieldNames = new LinkedHashSet<>();
        for (ContextVariable f : v.fields()) {
            fieldNames.add(f.name());
            if (!"string".equals(f.type())) {
                errors.add(String.format(
                    "%s 的字段 %s 类型必须为 string,实际: %s", v.name(), f.name(), f.type()));
            }
        }
        if (!Set.of("userId", "name", "email").equals(fieldNames)) {
            errors.add(String.format(
                "%s 的字段清单必须恰为 userId/name/email(均 string),实际: %s", v.name(), fieldNames));
        }
    }

    /** 查 3:输出映射 target——根变量已声明、点路径合法;target 根计入来源集。 */
    private void checkOutputMappings(Element userTask, String location,
                                      Map<String, ContextVariable> byName,
                                      Set<String> sources, List<String> errors) {
        for (Element mappings : dshChildren(userTask, "outputMappings")) {
            for (Element mapping : dshChildren(mappings, "mapping")) {
                String target = attrOrNull(mapping, "target");
                if (target == null || target.isBlank()) {
                    errors.add(location + " 的输出映射缺少 target");
                    continue;
                }
                String rootName = rootSegment(target.trim());
                ContextVariable decl = byName.get(rootName);
                if (decl == null) {
                    errors.add(String.format(
                        "%s 的输出映射 target 指向未声明变量: %s", location, rootName));
                    continue;
                }
                if (BpmnContextParser.SYSTEM_SOURCE.equals(decl.source())) {
                    errors.add(String.format(
                        "%s 的输出映射 target 指向系统注入变量: %s(按登录人注入,不允许节点产出覆盖)",
                        location, rootName));
                    continue;
                }
                sources.add(rootName);
                checkFieldPath(location, "输出映射 target", target.trim(), decl, errors);
            }
        }
    }

    /**
     * 查 2:网关/连线/Conditional 事件的条件表达式 {@code ${}}——
     * 标识符已声明或属内置豁免;声明的计入引用集(参与来源闭环)。
     * 多实例完成条件(userTask / ServiceTask)同查:引擎内置 nrOf* 计数变量
     * 在豁免清单内,其余引用须已声明(拦拼写错误,如 nrOfCompletedInstance)。
     */
    private void checkConditionExpressions(Document doc, Map<String, ContextVariable> byName,
                                           Set<String> referenced, List<String> errors) {
        // sequenceFlow 的 conditionExpression
        NodeList flows = doc.getElementsByTagNameNS(BPMN_NS, "sequenceFlow");
        for (int i = 0; i < flows.getLength(); i++) {
            Element flow = (Element) flows.item(i);
            for (String expr : bpmnTexts(flow, "conditionExpression")) {
                checkJuel(expr, "sequenceFlow[id=" + flow.getAttribute("id") + "]",
                    byName, referenced, errors);
            }
        }
        // conditionalEventDefinition 的 condition
        NodeList conditions = doc.getElementsByTagNameNS(BPMN_NS, "condition");
        for (int i = 0; i < conditions.getLength(); i++) {
            Element cond = (Element) conditions.item(i);
            String expr = cond.getTextContent();
            if (expr != null && !expr.isBlank()) {
                checkJuel(expr, "conditionalEvent[" + cond.getAttribute("id") + "]",
                    byName, referenced, errors);
            }
        }
        // 多实例完成条件(引用豁免含引擎内置 nrOf* / loopCounter)
        NodeList loops = doc.getElementsByTagNameNS(BPMN_NS, "multiInstanceLoopCharacteristics");
        for (int i = 0; i < loops.getLength(); i++) {
            Element loop = (Element) loops.item(i);
            if (!(loop.getParentNode() instanceof Element task)) {
                continue;
            }
            String location = task.getLocalName() + "[id=" + task.getAttribute("id") + "] 的完成条件";
            for (String expr : bpmnTexts(loop, "completionCondition")) {
                checkJuel(expr, location, byName, referenced, errors);
            }
        }
    }

    /** JUEL 标识符逐一检查:已声明 → 计入引用;豁免 → 忽略;否则报未声明。 */
    private void checkJuel(String expr, String location, Map<String, ContextVariable> byName,
                          Set<String> referenced, List<String> errors) {
        // 去掉字符串字面量再提标识符,避免 'approved' 误报
        String withoutLiterals = expr.replaceAll("'[^']*'", "").replaceAll("\"[^\"]*\"", "");
        // 去掉成员访问名(.field 属性 / .method() 方法调用):成员名不是变量引用
        String withoutMembers = withoutLiterals.replaceAll("\\.\\s*[a-zA-Z_][a-zA-Z0-9_]*", "");
        Matcher m = JUEL_EXPRESSION.matcher(withoutMembers);
        while (m.find()) {
            Matcher ids = IDENTIFIER.matcher(m.group(1));
            Set<String> seenInExpr = new HashSet<>();
            while (ids.find()) {
                String id = ids.group();
                if (!seenInExpr.add(id)) {
                    continue;
                }
                if (byName.containsKey(id)) {
                    referenced.add(id);
                } else if (!BUILTIN_IDENTIFIERS.contains(id)
                        && !isRuntimeInjectedVariable(id)) {
                    errors.add(String.format(
                        "%s 的条件表达式引用未声明变量: %s(先在「上下文变量」面板声明)", location, id));
                }
            }
        }
    }

    /**
     * 点路径合法检查:去掉数组索引段([0])后沿字段清单逐段走;
     * array 变量的字段清单视为元素字段清单(itemType=object 时配置)。
     */
    private void checkFieldPath(String location, String what, String rawPath,
                               ContextVariable rootDecl, List<String> errors) {
        String cleaned = rawPath.replaceAll("\\[\\d+]", "");
        String[] segments = cleaned.split("\\.");
        List<ContextVariable> current = rootDecl.fields();
        for (int i = 1; i < segments.length; i++) {
            String seg = segments[i].trim();
            if (seg.isEmpty()) {
                continue;
            }
            ContextVariable match = current.stream()
                .filter(f -> seg.equals(f.name()))
                .findFirst().orElse(null);
            if (match == null) {
                errors.add(String.format(
                    "%s 的 %s 路径 %s 中字段 %s 不在 %s 的字段清单", location, what, rawPath, seg, segments[0]));
                return;
            }
            current = match.fields();
        }
    }

    // ===== DOM 辅助 =====

    private static String rootSegment(String path) {
        String cleaned = path.replaceAll("\\[\\d+]", "");
        int dot = cleaned.indexOf('.');
        return dot < 0 ? cleaned.trim() : cleaned.substring(0, dot).trim();
    }

    /**
     * dsh:userPrompt 的 {@code text} 属性集合。
     *
     * <p>prompt 存 XML 属性而非元素正文(与引擎 DshBpmnExtensionParser、前端
     * dsh-moddle 对齐):引擎 StAX 非实体替换模式下含引号的正文会被事件切分截断。</p>
     */
    private static List<String> dshPrompts(Element parent) {
        List<String> result = new ArrayList<>();
        for (Element el : dshChildren(parent, "userPrompt")) {
            String text = attrOrNull(el, "text");
            if (text != null) {
                result.add(text);
            }
        }
        return result;
    }

    /**
     * dsh: 命名空间下指定 local name 的扩展元素。dsh 扩展按 BPMN 规范挂在父元素的
     * {@code bpmn:extensionElements} 下,故同时查父元素直接子(手写 XML 兼容)与
     * 直接子 extensionElements 的 dsh: 子元素;不递归更深层,避免嵌套误收
     * (如 ContextVariable 的 field)。
     */
    private static List<Element> dshChildren(Element parent, String localName) {
        List<Element> result = new ArrayList<>();
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            if (!(children.item(i) instanceof Element e)) {
                continue;
            }
            if (DSH_NS.equals(e.getNamespaceURI()) && localName.equals(e.getLocalName())) {
                result.add(e);
            } else if (BPMN_NS.equals(e.getNamespaceURI())
                && "extensionElements".equals(e.getLocalName())) {
                NodeList extChildren = e.getChildNodes();
                for (int j = 0; j < extChildren.getLength(); j++) {
                    if (extChildren.item(j) instanceof Element c
                        && DSH_NS.equals(c.getNamespaceURI())
                        && localName.equals(c.getLocalName())) {
                        result.add(c);
                    }
                }
            }
        }
        return result;
    }

    /** bpmn: 命名空间下指定 local name 的直接子元素文本集合。 */
    private static List<String> bpmnTexts(Element parent, String localName) {
        List<String> result = new ArrayList<>();
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            if (children.item(i) instanceof Element e
                && BPMN_NS.equals(e.getNamespaceURI())
                && localName.equals(e.getLocalName())) {
                String text = e.getTextContent();
                if (text != null && !text.isBlank()) {
                    result.add(text);
                }
            }
        }
        return result;
    }

    private static String attrOrNull(Element el, String name) {
        String v = el.getAttribute(name);
        return v == null || v.isBlank() ? null : v;
    }
}
