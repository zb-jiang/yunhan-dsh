package com.dsh.console.instanceworkspace;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.config.InstanceWorkspaceProperties;
import com.dsh.console.instanceworkspace.dto.InstanceWorkspaceFileDto;
import com.dsh.console.instanceworkspace.dto.WriteTextRequest;
import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.security.AuthContext;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

/**
 * 流程实例云工作空间业务编排(设计 docs/plans/2026-10-14-instance-workspace-design.md)。
 *
 * <p>存储模型:磁盘文件为事实源({@code {root}/{applicationId}/{instanceId}/{relPath}}),
 * 元数据表 {@code instance_workspace_files} 供列表快查、配额求和与归属缓存;写 = 先落盘
 * (临时文件 + 同卷 rename 原子替换)再 upsert 行,删 = 先删行再删盘;元数据缺行视为
 * 文件不存在(download/delete 404)。
 *
 * <p>归属解析(§4.4,员工面/服务面共用):实例已有元数据行 → application_id 取行缓存,
 * 不再访问引擎;无行 → flowable runtime(404 转 historic)→ procdefId 精确反查 →
 * processDefinitionKey / procdefId 首段按 BPMN key 回退;解析失败 404。首写落库即完成
 * 归属缓存,历史实例在引擎不可达时仍可浏览。
 *
 * <p>鉴权差异仅在解析后:员工面走两级闸门(设计 §1.3,2026-10-17 修订)——
 * {@link #checkAppMemberAccess}(system_admin/应用管理员/active 成员,照 KnowledgeService
 * 口径)加 {@link #checkInstanceParticipant}(参与人=发起人+历任/现任办理人+两级管理员,
 * 会签未办理收没人经历史任务 assignee 计入);服务面服务密钥即信任边界,不做成员校验。
 * 员工面读在无元数据行时仍执行解析校验(防任意 instanceId 探测);服务面读无行直接空列表。
 */
@Service
public class InstanceWorkspaceService {

    private static final int MAX_SEGMENT_LENGTH = 255;
    private static final int MAX_TOTAL_LENGTH = 1024;

    /** Windows 不允许出现在文件名中的字符(冒号同时挡掉盘符前缀)。 */
    private static final String WINDOWS_RESERVED_CHARS = "<>:\"|?*";

    /** Windows 保留设备名(忽略大小写;含 "CON.txt" 等带扩展名形态,取扩展名前首段比对)。 */
    private static final Set<String> WINDOWS_RESERVED_NAMES = Set.of(
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9");

    private static final String TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

    /**
     * 发起人回退历史变量名:REST 启动的生产实例不写 flowable startUserId,
     * 引擎侧以流程变量记录发起人(DshTaskMetaService 同名先例)。
     */
    private static final String APPLICANT_USER_ID_VARIABLE = "dsh_applicant_user_id";

    /** 下载载荷:元数据行 + 磁盘路径(controller 据此组装文件流响应)。 */
    public record DownloadPayload(InstanceWorkspaceJdbcRepository.FileRow row, Path diskPath) {
    }

    /**
     * 参与人缓存条目(进程内;userIds 为 Supabase user.id 集合,与 flowable
     * assignee/JWT sub 同源)。finished=实例已结束(历史 endTime 非空):参与人不再变化,
     * 过期时间取 MAX_VALUE 长缓存;运行中实例按配置 TTL 过期,新办理人接单后重查引擎自愈。
     */
    private record ParticipantCacheEntry(Set<String> userIds, boolean finished, long expiresAtMillis) {
    }

    /** 引擎不可达时不放行(fail-closed),故缓存只影响引擎负载不影响安全语义。 */
    private final ConcurrentHashMap<String, ParticipantCacheEntry> participantCache =
        new ConcurrentHashMap<>();

    private final InstanceWorkspaceProperties properties;
    private final InstanceWorkspaceJdbcRepository repository;
    private final FlowableRestClient flowableRestClient;
    private final WorkflowDefinitionJdbcRepository workflowRepository;
    private final ApplicationJdbcRepository appRepository;
    private final AuditService auditService;

    public InstanceWorkspaceService(InstanceWorkspaceProperties properties,
                                    InstanceWorkspaceJdbcRepository repository,
                                    FlowableRestClient flowableRestClient,
                                    WorkflowDefinitionJdbcRepository workflowRepository,
                                    ApplicationJdbcRepository appRepository,
                                    AuditService auditService) {
        this.properties = properties;
        this.repository = repository;
        this.flowableRestClient = flowableRestClient;
        this.workflowRepository = workflowRepository;
        this.appRepository = appRepository;
        this.auditService = auditService;
    }

    // ---------- 员工面(JWT) ----------

    /** 列实例空间文件(§4.1)。无元数据行时仍解析校验实例存在与应用归属(防 instanceId 探测)。 */
    public List<InstanceWorkspaceFileDto> list(AuthContext auth, String instanceId) {
        UUID appId = resolveApplicationId(instanceId);
        checkAppMemberAccess(auth, appId);
        checkInstanceParticipant(auth, appId, instanceId);
        return listRows(instanceId);
    }

    /** 下载单文件,返回元数据行与磁盘路径。 */
    public DownloadPayload download(AuthContext auth, String instanceId, String relPath) {
        UUID appId = resolveApplicationId(instanceId);
        checkAppMemberAccess(auth, appId);
        checkInstanceParticipant(auth, appId, instanceId);
        return requireDiskFile(instanceId, validateRelPath(relPath));
    }

    /** 导出实例空间全部文件为 zip,流式写入 out(512MB 上限不能整载内存)。 */
    public void exportTo(AuthContext auth, String instanceId, OutputStream out) {
        UUID appId = resolveApplicationId(instanceId);
        checkAppMemberAccess(auth, appId);
        checkInstanceParticipant(auth, appId, instanceId);
        writeZip(instanceId, out);
    }

    /** 上传/覆盖字节文件(multipart;同 relPath 为覆盖,后写者胜)。 */
    public InstanceWorkspaceFileDto upload(AuthContext auth, String instanceId,
                                           String relPath, MultipartFile file) {
        String normalized = validateRelPath(relPath);
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("上传文件为空: " + relPath);
        }
        UUID appId = resolveApplicationId(instanceId);
        checkAppMemberAccess(auth, appId);
        checkInstanceParticipant(auth, appId, instanceId);
        byte[] bytes = readAll(file, relPath);
        return doWrite(appId, instanceId, normalized, bytes, file.getContentType(),
            String.valueOf(auth.platformUserId()), auth.displayName(),
            null, "upload", auth.platformUserId(), String.valueOf(auth.platformUserId()));
    }

    /** 写/覆盖文本文件(UTF-8)。 */
    public InstanceWorkspaceFileDto writeText(AuthContext auth, String instanceId,
                                              WriteTextRequest body) {
        String normalized = validateRelPath(body.path());
        UUID appId = resolveApplicationId(instanceId);
        checkAppMemberAccess(auth, appId);
        checkInstanceParticipant(auth, appId, instanceId);
        byte[] bytes = body.content() == null
            ? new byte[0] : body.content().getBytes(StandardCharsets.UTF_8);
        return doWrite(appId, instanceId, normalized, bytes, TEXT_CONTENT_TYPE,
            String.valueOf(auth.platformUserId()), auth.displayName(),
            body.sourceTaskId(), "write", auth.platformUserId(),
            String.valueOf(auth.platformUserId()));
    }

    /** 删除单文件(先删行再删盘;行不存在或磁盘缺失均 404,以磁盘为准)。 */
    public void delete(AuthContext auth, String instanceId, String relPath) {
        String normalized = validateRelPath(relPath);
        UUID appId = resolveApplicationId(instanceId);
        checkAppMemberAccess(auth, appId);
        checkInstanceParticipant(auth, appId, instanceId);
        deleteNormalized(instanceId, normalized, auth.platformUserId(),
            String.valueOf(auth.platformUserId()));
    }

    // ---------- 服务面(X-Service-Key;不校验成员,写仍解析归属) ----------

    /** 服务面列文件:无元数据行直接空列表,不访问引擎。 */
    public List<InstanceWorkspaceFileDto> listForService(String instanceId) {
        return listRows(instanceId);
    }

    /** 服务面下载单文件;行不存在直接 404,不解析归属。 */
    public DownloadPayload downloadForService(String instanceId, String relPath) {
        return requireDiskFile(instanceId, validateRelPath(relPath));
    }

    /** 服务面上传/覆盖字节文件;uploaded_by 固定 dsh-service。 */
    public InstanceWorkspaceFileDto uploadForService(String instanceId, String relPath,
                                                     MultipartFile file) {
        String normalized = validateRelPath(relPath);
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("上传文件为空: " + relPath);
        }
        UUID appId = resolveApplicationId(instanceId);
        byte[] bytes = readAll(file, relPath);
        return doWrite(appId, instanceId, normalized, bytes, file.getContentType(),
            "dsh-service", "dsh-service", null, "upload", null, "dsh-service");
    }

    /** 服务面写/覆盖文本文件;uploaded_by 固定 dsh-service。 */
    public InstanceWorkspaceFileDto writeTextForService(String instanceId, WriteTextRequest body) {
        String normalized = validateRelPath(body.path());
        UUID appId = resolveApplicationId(instanceId);
        byte[] bytes = body.content() == null
            ? new byte[0] : body.content().getBytes(StandardCharsets.UTF_8);
        return doWrite(appId, instanceId, normalized, bytes, TEXT_CONTENT_TYPE,
            "dsh-service", "dsh-service", body.sourceTaskId(), "write", null, "dsh-service");
    }

    /** 服务面删除单文件;行不存在直接 404,不解析归属。 */
    public void deleteForService(String instanceId, String relPath) {
        deleteNormalized(instanceId, validateRelPath(relPath), null, "dsh-service");
    }

    // ---------- 路径校验(§4.5;员工面/服务面共用) ----------

    /**
     * 校验并规范化 relPath:拒绝绝对路径、反斜杠、{@code ..} 段、空段、{@code .} 段、
     * Windows 保留字符与控制字符、Windows 保留设备名;单段 ≤255、总长 ≤1024。
     * 校验失败抛 IllegalArgumentException(→ 400),错误消息列明原因。
     */
    static String validateRelPath(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new IllegalArgumentException("路径不能为空");
        }
        String path = raw.strip();
        if (path.startsWith("/") || path.contains("\\")) {
            throw new IllegalArgumentException("路径必须是相对路径且以 / 分隔,非法: " + raw);
        }
        if (path.length() > MAX_TOTAL_LENGTH) {
            throw new IllegalArgumentException(
                "路径总长度超过 " + MAX_TOTAL_LENGTH + " 字符: " + raw);
        }
        for (String segment : path.split("/", -1)) {
            if (segment.isEmpty() || ".".equals(segment)) {
                throw new IllegalArgumentException("路径含空段或 . 段,非法: " + raw);
            }
            if ("..".equals(segment)) {
                throw new IllegalArgumentException("路径不允许 .. 段,非法: " + raw);
            }
            if (segment.length() > MAX_SEGMENT_LENGTH) {
                throw new IllegalArgumentException(
                    "路径段超过 " + MAX_SEGMENT_LENGTH + " 字符: " + segment);
            }
            for (int i = 0; i < segment.length(); i++) {
                char c = segment.charAt(i);
                if (c < 0x20 || c == 0x7F || WINDOWS_RESERVED_CHARS.indexOf(c) >= 0) {
                    throw new IllegalArgumentException(
                        "路径段含 Windows 保留字符或控制字符,非法: " + segment);
                }
            }
            if (isWindowsReservedName(segment)) {
                throw new IllegalArgumentException("路径段是 Windows 保留设备名,非法: " + segment);
            }
        }
        return path;
    }

    private static boolean isWindowsReservedName(String segment) {
        String base = segment.indexOf('.') >= 0
            ? segment.substring(0, segment.indexOf('.'))
            : segment;
        return WINDOWS_RESERVED_NAMES.contains(base.toUpperCase(Locale.ROOT));
    }

    // ---------- 内部:归属解析(§4.4) ----------

    /**
     * 实例 → 应用归属:已有元数据行取缓存;否则走引擎 runtime(404 转 historic)→
     * procdefId 精确反查 → processDefinitionKey / procdefId 首段按 BPMN key 回退。
     * 实例不存在或无归属定义抛 NotFoundException。
     */
    private UUID resolveApplicationId(String instanceId) {
        Optional<UUID> cached = repository.findApplicationIdByInstance(instanceId);
        if (cached.isPresent()) {
            return cached.get();
        }
        JsonNode instance;
        try {
            instance = flowableRestClient.getRuntimeProcessInstance(instanceId);
        } catch (NotFoundException e) {
            instance = flowableRestClient.getHistoricProcessInstance(instanceId);
        }
        if (instance == null) {
            throw new NotFoundException("流程实例不存在(runtime/history): " + instanceId);
        }
        UUID appId = resolveApplicationFromInstance(instance);
        if (appId == null) {
            throw new NotFoundException("流程实例无归属流程定义: " + instanceId);
        }
        return appId;
    }

    private UUID resolveApplicationFromInstance(JsonNode instance) {
        String procdefId = instance.path("processDefinitionId").asText(null);
        if (procdefId != null && !procdefId.isBlank()) {
            Optional<WorkflowDefinitionDto> wf = workflowRepository.findByProcdefId(procdefId);
            if (wf.isPresent()) {
                return wf.get().appId();
            }
        }
        // key 反回退:实例 JSON 自带 processDefinitionKey(引擎历史端点补查)优先;
        // 缺失按 procdefId 的 key:version:uuid 首段回退(与 BackendKbController 同序)
        String key = instance.path("processDefinitionKey").asText(null);
        if ((key == null || key.isBlank()) && procdefId != null && !procdefId.isBlank()) {
            key = extractBpmnKey(procdefId);
        }
        if (key != null && !key.isBlank()) {
            return workflowRepository.findByBpmnProcessKey(key)
                .map(WorkflowDefinitionDto::appId)
                .orElse(null);
        }
        return null;
    }

    /** 取 {@code key:version:uuid} 形态的首段;无冒号原样返回。 */
    private static String extractBpmnKey(String procdefId) {
        int colon = procdefId.indexOf(':');
        return colon < 0 ? procdefId : procdefId.substring(0, colon);
    }

    /**
     * 内容访问校验:system_admin / 应用管理员直通;其余须为 active 成员(口径同 RLS,
     * 照 KnowledgeService.checkAppMemberAccess);失败 403。
     */
    private void checkAppMemberAccess(AuthContext auth, UUID appId) {
        if (auth.isSystemAdmin() || isAppAdmin(auth, appId)) {
            return;
        }
        if (!repository.isActiveMember(appId, auth.authSubject())) {
            throw new AccessDeniedException("用户不是应用 " + appId + " 的管理员或成员");
        }
    }

    private boolean isAppAdmin(AuthContext auth, UUID appId) {
        return appRepository.findById(appId)
            .map(app -> app.appAdminUserIds() != null
                && app.appAdminUserIds().contains(auth.platformUserId()))
            .orElse(false);
    }

    // ---------- 内部:实例参与人鉴权(§1.3/§4.4,2026-10-17 修订) ----------

    /**
     * 实例参与人校验(员工面第二级闸门):system_admin/应用管理员直通(不触发引擎调用);
     * 其余须属于参与人集合,失败 403。比对键为 {@code auth.authSubject()}(JWT sub,
     * 与 flowable assignee 同源)。
     */
    private void checkInstanceParticipant(AuthContext auth, UUID appId, String instanceId) {
        if (auth.isSystemAdmin() || isAppAdmin(auth, appId)) {
            return;
        }
        if (!resolveParticipants(instanceId).contains(auth.authSubject())) {
            throw new AccessDeniedException("您不是该流程实例的参与人");
        }
    }

    /**
     * 解析实例参与人集合(发起人 + 历任/现任办理人,进程内缓存):历史实例
     * {@code startUserId} 为发起人,缺失时回退历史变量 {@code dsh_applicant_user_id}
     * (REST 启动的生产实例不写 startUserId);历史任务全量收集非空 assignee,
     * 不按 deleteReason 过滤——会签/计票提前收工时被引擎自动删除的未办理待办同样
     * 留有 assignee,"接过活的人"计入参与人。历史实例查不到抛 NotFoundException
     * (fail-closed);引擎 5xx 异常透传(→502)。
     */
    private Set<String> resolveParticipants(String instanceId) {
        long now = System.currentTimeMillis();
        ParticipantCacheEntry cached = participantCache.get(instanceId);
        if (cached != null && now < cached.expiresAtMillis()) {
            return cached.userIds();
        }
        JsonNode historic = flowableRestClient.getHistoricProcessInstance(instanceId);
        if (historic == null) {
            throw new NotFoundException("流程实例不存在(history): " + instanceId);
        }
        Set<String> userIds = new HashSet<>();
        String startUserId = historic.path("startUserId").asText(null);
        if (startUserId != null && !startUserId.isBlank()) {
            userIds.add(startUserId);
        }
        JsonNode variables = flowableRestClient.listHistoricVariables(instanceId);
        if (variables != null && variables.isArray()) {
            for (JsonNode variable : variables) {
                if (APPLICANT_USER_ID_VARIABLE.equals(variable.path("variableName").asText(null))) {
                    String applicantId = variable.path("value").asText(null);
                    if (applicantId != null && !applicantId.isBlank()) {
                        userIds.add(applicantId);
                    }
                }
            }
        }
        JsonNode tasks = flowableRestClient.listHistoricTasks(instanceId);
        if (tasks != null && tasks.isArray()) {
            for (JsonNode task : tasks) {
                String assignee = task.path("assignee").asText(null);
                if (assignee != null && !assignee.isBlank()) {
                    userIds.add(assignee);
                }
            }
        }
        String endTime = historic.path("endTime").asText(null);
        boolean finished = endTime != null && !endTime.isBlank();
        long expiresAt = finished ? Long.MAX_VALUE : now + properties.participantCacheTtlMillis();
        participantCache.put(instanceId, new ParticipantCacheEntry(Set.copyOf(userIds), finished, expiresAt));
        return userIds;
    }

    // ---------- 内部:写、删、读 ----------

    private List<InstanceWorkspaceFileDto> listRows(String instanceId) {
        return repository.listByInstance(instanceId).stream()
            .map(this::toDto)
            .toList();
    }

    private DownloadPayload requireDiskFile(String instanceId, String normalizedRelPath) {
        InstanceWorkspaceJdbcRepository.FileRow row = repository
            .findByPath(instanceId, normalizedRelPath)
            .orElseThrow(() -> new NotFoundException("文件不存在: " + normalizedRelPath));
        Path disk = diskPath(row.applicationId(), instanceId, normalizedRelPath);
        if (!Files.isRegularFile(disk)) {
            throw new NotFoundException("文件不存在: " + normalizedRelPath);
        }
        return new DownloadPayload(row, disk);
    }

    /**
     * 写公共路径:配额校验 → 落盘(临时文件 + rename 原子替换)→ upsert 行 → 审计。
     * 顺序保证:落盘失败不留行;行存在但磁盘已缺失视为新文件(配额按无替换计)。
     */
    private InstanceWorkspaceFileDto doWrite(UUID appId, String instanceId, String relPath,
                                             byte[] content, String contentType,
                                             String uploadedBy, String uploadedByLabel,
                                             String sourceTaskId, String mode,
                                             UUID operatorId, String actor) {
        InstanceWorkspaceJdbcRepository.FileRow existing =
            repository.findByPath(instanceId, relPath).orElse(null);
        checkQuota(instanceId, existing, content.length);
        Path target = diskPath(appId, instanceId, relPath);
        try {
            writeFileToDisk(target, content);
        } catch (IOException e) {
            throw new UncheckedIOException("实例空间文件落盘失败: " + relPath, e);
        }
        InstanceWorkspaceJdbcRepository.FileRow row = repository.upsert(
            instanceId, appId, relPath, content.length, contentType,
            uploadedBy, uploadedByLabel, sourceTaskId);
        auditService.record("INSTANCE_WS_FILE_UPLOAD", "instance_workspace", null, operatorId,
            Map.of("instanceId", instanceId, "appId", appId.toString(), "relPath", relPath,
                "sizeBytes", content.length, "mode", mode, "actor", actor));
        return toDto(row);
    }

    private void deleteNormalized(String instanceId, String relPath,
                                  UUID operatorId, String actor) {
        InstanceWorkspaceJdbcRepository.FileRow row = repository
            .findByPath(instanceId, relPath)
            .orElseThrow(() -> new NotFoundException("文件不存在: " + relPath));
        Path disk = diskPath(row.applicationId(), instanceId, relPath);
        if (!Files.isRegularFile(disk)) {
            // 行存在但磁盘缺失:以磁盘为准视为文件不存在
            throw new NotFoundException("文件不存在: " + relPath);
        }
        repository.delete(instanceId, relPath);
        try {
            Files.deleteIfExists(disk);
        } catch (IOException e) {
            throw new UncheckedIOException("实例空间文件删除失败: " + relPath, e);
        }
        auditService.record("INSTANCE_WS_FILE_DELETE", "instance_workspace", null, operatorId,
            Map.of("instanceId", instanceId, "appId", row.applicationId().toString(),
                "relPath", relPath, "actor", actor));
    }

    /** 配额(§4.5):单文件上限、实例总量(覆盖写按替换后总量)、文件数(仅新文件计)。 */
    private void checkQuota(String instanceId,
                            InstanceWorkspaceJdbcRepository.FileRow existing, long incomingBytes) {
        if (incomingBytes > properties.maxFileBytes()) {
            throw new IllegalArgumentException("文件 " + incomingBytes + " 字节超过单文件上限 "
                + properties.maxFileBytes() + " 字节");
        }
        long currentTotal = repository.totalBytes(instanceId);
        long projected = currentTotal - (existing == null ? 0L : existing.sizeBytes())
            + incomingBytes;
        if (projected > properties.maxInstanceTotalBytes()) {
            throw new IllegalArgumentException("实例空间总量超限:现有 " + currentTotal
                + " 字节,写入后 " + projected + " 字节,超过上限 "
                + properties.maxInstanceTotalBytes() + " 字节(覆盖写按替换后总量计)");
        }
        if (existing == null && repository.countByInstance(instanceId) >= properties.maxEntries()) {
            throw new IllegalArgumentException(
                "实例空间文件数达到上限 " + properties.maxEntries());
        }
    }

    /** 临时文件 + 同卷 rename 原子替换;rename 不支持原子时退化为普通 replace。 */
    private void writeFileToDisk(Path target, byte[] content) throws IOException {
        Files.createDirectories(target.getParent());
        Path tmp = Files.createTempFile(target.getParent(), ".iws-", ".tmp");
        try {
            Files.write(tmp, content);
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    /** zip 流式导出;磁盘缺失的文件跳过(以磁盘为准)。 */
    private void writeZip(String instanceId, OutputStream out) {
        try (ZipOutputStream zip = new ZipOutputStream(out)) {
            for (InstanceWorkspaceJdbcRepository.FileRow row : repository.listByInstance(instanceId)) {
                Path disk = diskPath(row.applicationId(), instanceId, row.relPath());
                if (!Files.isRegularFile(disk)) {
                    continue;
                }
                zip.putNextEntry(new ZipEntry(row.relPath()));
                Files.copy(disk, zip);
                zip.closeEntry();
            }
            zip.finish();
        } catch (IOException e) {
            throw new UncheckedIOException("实例空间导出失败: " + instanceId, e);
        }
    }

    private InstanceWorkspaceFileDto toDto(InstanceWorkspaceJdbcRepository.FileRow row) {
        boolean diskMissing = !Files.isRegularFile(
            diskPath(row.applicationId(), row.instanceId(), row.relPath()));
        return new InstanceWorkspaceFileDto(row.relPath(), row.sizeBytes(), row.contentType(),
            row.uploadedByLabel(), row.sourceTaskId(), row.createdAt(), row.updatedAt(),
            diskMissing);
    }

    private Path diskPath(UUID applicationId, String instanceId, String relPath) {
        return properties.rootPath()
            .resolve(applicationId.toString())
            .resolve(instanceId)
            .resolve(relPath);
    }

    private static byte[] readAll(MultipartFile file, String relPath) {
        try {
            return file.getBytes();
        } catch (IOException e) {
            throw new UncheckedIOException("读取上传文件失败: " + relPath, e);
        }
    }
}
