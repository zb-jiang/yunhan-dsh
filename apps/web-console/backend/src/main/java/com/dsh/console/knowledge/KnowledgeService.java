package com.dsh.console.knowledge;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.config.KnowledgeProperties;
import com.dsh.console.knowledge.dto.KbAppSummaryDto;
import com.dsh.console.knowledge.dto.KbDocumentContentDto;
import com.dsh.console.knowledge.dto.KbDocumentDto;
import com.dsh.console.knowledge.dto.KbDocumentTextDto;
import com.dsh.console.knowledge.dto.KbFolderDto;
import com.dsh.console.knowledge.dto.KbSearchHitDto;
import com.dsh.console.knowledge.dto.KbSearchTraceDto;
import com.dsh.console.knowledge.dto.KbTraceCandidateDto;
import com.dsh.console.knowledge.dto.KbTraceContributionDto;
import com.dsh.console.knowledge.dto.KbTraceDocDto;
import com.dsh.console.knowledge.dto.KbTracePathDto;
import com.dsh.console.knowledge.dto.KbTraceRerankDto;
import com.dsh.console.knowledge.dto.KnowledgeBaseDto;
import com.dsh.console.security.AuthContext;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.multipart.MultipartFile;

/**
 * 知识库业务编排:应用级成员校验(全员平等读写)+ 文件夹树 + 文档上传/检索/下载/删除。
 *
 * <p>权限口径:system_admin 全通;应用管理员({@code app_admin_user_ids})可配置知识库
 * (开通/建删文件夹/上传/删除);应用 active 成员可进行内容访问与上传——管理员不必是成员,
 * 成员校验口径为「管理员 ∪ active 成员」,与 RLS(见 setup guide §12.2)一致。
 * 不做目录级 ACL。
 *
 * <p>上传把文件字节直接交给解析管线(本地原文落盘与元数据行同请求完成,
 * 解析只消费内存字节,不回读文件)。
 */
@Service
public class KnowledgeService {

    private static final Logger log = LoggerFactory.getLogger(KnowledgeService.class);

    /** 混合检索默认返回条数(调用方未传 topK 时)。 */
    private static final int DEFAULT_SEARCH_TOP_K = 8;

    /** 混合检索返回条数上限(防大结果集;超范围 topK 收敛到 1..该值)。 */
    private static final int MAX_SEARCH_TOP_K = 50;

    /** rrfMerge 默认 snippet 的截断长度(字符);最终输出 snippet 由 {@link #finalSnippets}
     * 按设计文档 §6 规则组合覆盖,此截断仅作组合前的兜底。 */
    private static final int SNIPPET_MAX_CHARS = 300;

    /** RRF 融合常数 k(标准取值 60;rank 从 1 起,score = Σ 1/(k + rank))。 */
    static final int RRF_K = 60;

    private final KnowledgeJdbcRepository repository;
    private final ApplicationJdbcRepository appRepository;
    private final KbLocalStorage localStorage;
    private final KbParsePipeline parsePipeline;
    private final KbEmbeddingClient embeddingClient;
    private final KbRerankClient rerankClient;
    private final AuditService auditService;
    private final KnowledgeProperties properties;

    public KnowledgeService(KnowledgeJdbcRepository repository,
                            ApplicationJdbcRepository appRepository,
                            KbLocalStorage localStorage,
                            KbParsePipeline parsePipeline,
                            KbEmbeddingClient embeddingClient,
                            KbRerankClient rerankClient,
                            AuditService auditService,
                            KnowledgeProperties properties) {
        this.repository = repository;
        this.appRepository = appRepository;
        this.localStorage = localStorage;
        this.parsePipeline = parsePipeline;
        this.embeddingClient = embeddingClient;
        this.rerankClient = rerankClient;
        this.auditService = auditService;
        this.properties = properties;
    }

    // ---------- 知识库开通 ----------

    /**
     * 查应用知识库,不存在则按需开通(写 knowledge_bases 行)。
     *
     * <p>文档原文存 {@code dsh.knowledge.storage-root} 本地根目录,
     * 应用间以对象路径 {@code {appId}/{docId}/...} 分段隔离,库行不再登记存储位置。
     *
     * <p>开通属配置动作,仅 system_admin / 应用管理员可触发;成员的内容访问
     * 走 {@link #getKnowledgeBase}(KB 已存在时由管理员先行开通)。
     */
    @Transactional
    public KnowledgeBaseDto ensureKnowledgeBase(AuthContext auth, UUID appId) {
        checkAppAdminAccess(auth, appId);
        ApplicationDto app = appRepository.findById(appId)
            .orElseThrow(() -> new NotFoundException("应用不存在: " + appId));
        return repository.findKbByApp(appId).orElseGet(() -> {
            KnowledgeBaseDto kb = repository.insertKb(appId, app.name() + " 知识库");
            auditService.record("KB_CREATE", "application", null, auth.platformUserId(),
                Map.of("appId", appId, "kbId", kb.id()));
            return kb;
        });
    }

    /**
     * 按知识库 id 取(校验访问权);员工端与工具链后续用此入口。
     */
    public KnowledgeBaseDto getKnowledgeBase(AuthContext auth, UUID kbId) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        return kb;
    }

    /**
     * 按应用查知识库(成员可读,不开通):员工端待办会话的知识库选择器入口
     * (design 2026-09-11 §6 待办定位知识库)。未开通抛 NotFound,前端隐藏入口。
     */
    public KnowledgeBaseDto findKnowledgeBaseByApp(AuthContext auth, UUID appId) {
        KnowledgeBaseDto kb = repository.findKbByApp(appId)
            .orElseThrow(() -> new NotFoundException("应用未开通知识库: " + appId));
        checkAppMemberAccess(auth, kb.applicationId());
        return kb;
    }

    /**
     * 服务身份变体(X-Service-Key):按应用查已开通知识库,不做员工成员校验,
     * 未开通返回空(调用方 404)。仅限 {@code BackendKbController} 的只读端点。
     */
    public Optional<KnowledgeBaseDto> findKbByAppForService(UUID appId) {
        return repository.findKbByApp(appId);
    }

    /**
     * 当前用户可见的知识库清单(system_admin 全部;其余为应用管理员 ∪
     * active 成员的应用):员工端工作空间上传「选应用」数据源。
     */
    public List<KbAppSummaryDto> listKbsForUser(AuthContext auth) {
        return auth.isSystemAdmin()
            ? repository.listAllKbs()
            : repository.listKbsForUser(auth.platformUserId(), auth.authSubject());
    }

    // ---------- 文件夹 ----------

    public List<KbFolderDto> listFolders(AuthContext auth, UUID kbId) {
        checkKbAccess(auth, kbId);
        return repository.listFolders(kbId);
    }

    /**
     * 服务身份变体(X-Service-Key):列知识库文件夹树,不做员工成员校验。
     *
     * <p>仅限 {@code BackendKbController} 的只读端点(backend profile 无人值守
     * kb_* 工具);无员工身份可校验,权限由服务密钥白名单收口,不得开放写操作。
     */
    public List<KbFolderDto> listFoldersForService(UUID kbId) {
        return repository.listFolders(kbId);
    }

    @Transactional
    public KbFolderDto createFolder(AuthContext auth, UUID kbId, String name, UUID parentId) {
        checkKbAccess(auth, kbId);
        validateFolderName(name);
        UUID parent = parentId;
        String path;
        if (parent != null) {
            KbFolderDto parentFolder = requireFolder(kbId, parent);
            path = parentFolder.path() + "/" + name;
        } else {
            path = "/" + name;
        }
        try {
            KbFolderDto folder = repository.insertFolder(kbId, parent, name, path);
            auditService.record("KB_FOLDER_CREATE", "kb_folder", null, auth.platformUserId(),
                Map.of("kbId", kbId, "folderId", folder.id(), "path", path));
            return folder;
        } catch (DataIntegrityViolationException e) {
            throw new IllegalArgumentException("同级目录下已存在同名文件夹: " + name);
        }
    }

    /**
     * 重命名/移动文件夹(可同时),同步重算子树物化路径。
     *
     * <p>不支持移动到根(根级无层级差异,重命名即可;前端如需可删除重建)。
     */
    @Transactional
    public KbFolderDto updateFolder(AuthContext auth, UUID kbId, UUID folderId,
                                    String newName, UUID newParentId) {
        checkKbAccess(auth, kbId);
        KbFolderDto folder = requireFolder(kbId, folderId);
        if (newName == null && newParentId == null) {
            throw new IllegalArgumentException("name 与 parentId 至少给一个");
        }
        String name = newName != null ? newName : folder.name();
        validateFolderName(name);
        UUID parentId;
        String parentPath;
        if (newParentId != null) {
            if (newParentId.equals(folderId)) {
                throw new IllegalArgumentException("不能把文件夹移动到自己之下");
            }
            KbFolderDto target = requireFolder(kbId, newParentId);
            // 防环:目标父目录不能是自己的子树(含自身)
            if (target.path().equals(folder.path()) || target.path().startsWith(folder.path() + "/")) {
                throw new IllegalArgumentException("不能把文件夹移动到自己的子目录下");
            }
            parentId = target.id();
            parentPath = target.path();
        } else {
            parentId = folder.parentId();
            parentPath = folder.parentId() == null ? null
                : requireFolder(kbId, folder.parentId()).path();
        }
        String newPath = parentPath == null ? "/" + name : parentPath + "/" + name;
        try {
            repository.updateFolder(folderId, parentId, name, newPath);
            if (!newPath.equals(folder.path())) {
                repository.updateFolderSubtreePaths(kbId, folder.path(), newPath);
            }
        } catch (DataIntegrityViolationException e) {
            throw new IllegalArgumentException("同级目录下已存在同名文件夹: " + name);
        }
        auditService.record("KB_FOLDER_UPDATE", "kb_folder", null, auth.platformUserId(),
            Map.of("kbId", kbId, "folderId", folderId, "oldPath", folder.path(), "newPath", newPath));
        return requireFolder(kbId, folderId);
    }

    @Transactional
    public void deleteFolder(AuthContext auth, UUID kbId, UUID folderId) {
        checkKbAccess(auth, kbId);
        KbFolderDto folder = requireFolder(kbId, folderId);
        if (repository.folderHasChildren(kbId, folderId)) {
            throw new IllegalStateException("文件夹包含子文件夹,先删除子文件夹");
        }
        if (repository.folderHasDocuments(kbId, folderId)) {
            throw new IllegalStateException("文件夹包含文档,先删除或移出文档");
        }
        repository.deleteFolder(folderId);
        auditService.record("KB_FOLDER_DELETE", "kb_folder", null, auth.platformUserId(),
            Map.of("kbId", kbId, "folderId", folderId, "path", folder.path()));
    }

    // ---------- 文档 ----------

    /**
     * 列文档。folderId 为 null 表示根;recursive 含子树(根 + recursive = 全库);
     * kw 关键字检索(强制只返回 ready);parseStatus 过滤解析状态。全文不进列表载荷,给摘要窗口。
     */
    public List<KbDocumentDto> listDocuments(AuthContext auth, UUID kbId, UUID folderId,
                                             boolean recursive, String kw, String parseStatus) {
        checkKbAccess(auth, kbId);
        return listDocumentsCore(kbId, folderId, recursive, kw, parseStatus);
    }

    /**
     * 服务身份变体(X-Service-Key):文档检索,不做员工成员校验,语义同
     * {@link #listDocuments}。仅限 {@code BackendKbController} 的只读端点。
     */
    public List<KbDocumentDto> listDocumentsForService(UUID kbId, UUID folderId,
                                                       boolean recursive, String kw, String parseStatus) {
        return listDocumentsCore(kbId, folderId, recursive, kw, parseStatus);
    }

    /** 列文档共用实现(成员校验之后的路径;folderId → 文件夹行解析在此)。 */
    private List<KbDocumentDto> listDocumentsCore(UUID kbId, UUID folderId,
                                                  boolean recursive, String kw, String parseStatus) {
        KbFolderDto folder = folderId == null ? null : requireFolder(kbId, folderId);
        List<KbDocumentRecord> docs = repository.listDocuments(kbId, folder, recursive, kw, parseStatus);
        Map<String, String> uploaderNames = repository.displayNamesByAuthSubjects(
            docs.stream().map(KbDocumentRecord::uploadedBy).collect(Collectors.toSet()));
        return docs.stream()
            .map(doc -> toDto(doc, kw, uploaderNames))
            .toList();
    }

    // ---------- 混合检索(三路 RRF) ----------

    /**
     * 混合检索(文档级):查询文本向量化 + 仓储层三路候选(向量余弦 / pg_trgm 关键词 /
     * jiebacfg 全文)按 RRF 融合排序,统一聚合为文档级命中。folderId 限定其子树(含
     * 自身),null 为全库;未解析完成的文档不进任何一路。检索为读操作,不写审计
     * (与列表端点一致)。
     */
    public List<KbSearchHitDto> searchChunks(AuthContext auth, UUID kbId, String query,
                                             UUID folderId, Integer topK) {
        checkKbAccess(auth, kbId);
        return searchChunksCore(kbId, query, folderId, topK);
    }

    /**
     * 服务身份变体(X-Service-Key):混合检索,不做员工成员校验,语义同
     * {@link #searchChunks}。仅限 {@code BackendKbController} 的只读端点。
     */
    public List<KbSearchHitDto> searchChunksForService(UUID kbId, String query,
                                                       UUID folderId, Integer topK) {
        return searchChunksCore(kbId, query, folderId, topK);
    }

    /** 检索共用实现:参数归一 → 查询向量化 → 三路候选 → RRF 合并截断。 */
    private List<KbSearchHitDto> searchChunksCore(UUID kbId, String query, UUID folderId, Integer topK) {
        return runSearch(kbId, query, folderId, topK).results();
    }

    /**
     * 检索 debug 追踪:执行与 {@link #searchChunksCore} 完全相同的检索流程,额外保留
     * 三路候选与 RRF 融合中间态,供 web console 检索可视化页面展示打分与排序过程。
     * 每次调用真实执行一次查询向量化(硅基流动);不做审计(与检索一致)。
     */
    public KbSearchTraceDto searchTrace(AuthContext auth, UUID kbId, String query, UUID folderId, Integer topK) {
        checkKbAccess(auth, kbId);
        return buildTrace(kbId, query, folderId, runSearch(kbId, query, folderId, topK));
    }

    /**
     * 检索共用执行体:参数归一 → 查询向量化 → 三路候选 → RRF 融合(候选池 2×topK)
     * → rerank 精排(按重排分过滤排序取 topK;调用失败降级为 RRF 排序)→ 最终 snippet 组合。
     * search 与 search-debug 走同一方法,保证 debug 视图与真实检索语义一致。
     */
    private SearchRun runSearch(UUID kbId, String query, UUID folderId, Integer topK) {
        if (query == null || query.isBlank()) {
            throw new IllegalArgumentException("检索词不能为空");
        }
        int effectiveTopK = clampTopK(topK);
        KbFolderDto folder = folderId == null ? null : requireFolder(kbId, folderId);
        String queryVector = embedQuery(query);
        // 每路候选取 topK 的 3 倍:三路各自排序后融合,候选池留足交集空间
        int candidateLimit = effectiveTopK * 3;
        List<KbSearchCandidate> vectorRoute =
            repository.searchVectorCandidates(kbId, folder, queryVector, candidateLimit,
                properties.embeddingMaxDistance());
        List<KbSearchCandidate> keywordRoute =
            repository.searchKeywordCandidates(kbId, folder, query, candidateLimit);
        List<KbSearchCandidate> ftsRoute =
            repository.searchFtsCandidates(kbId, folder, query, candidateLimit);
        // RRF 融合取 2×topK 候选池:rerank 从中精选 topK,给精排留足挑选余地
        List<KbSearchHitDto> merged =
            rrfMerge(vectorRoute, keywordRoute, ftsRoute, effectiveTopK * 2);
        RerankOutcome outcome = rerankPipeline(kbId, query, merged, vectorRoute, effectiveTopK);
        return new SearchRun(effectiveTopK, candidateLimit, properties.embeddingMaxDistance(),
            properties.rerankMinScore(), properties.rerankModel(),
            vectorRoute, keywordRoute, ftsRoute, outcome.pool(), outcome.results());
    }

    /** rerank 阶段产物:候选池逐行中间态(供 debug 追踪)+ 最终命中。 */
    private record RerankOutcome(List<KbTraceRerankDto> pool, List<KbSearchHitDto> results) {
    }

    /**
     * rerank 精排:先给池内每篇候选组装最终 snippet(rerank 输入与最终输出同源),
     * 再调 rerank 模型逐个打分。调用失败(网络/网关/响应不合法)降级为按 RRF 序
     * 取前 topK 并告警——检索主路径不被增强组件绑架,降级期间 score 语义变为
     * RRF 融合分(见 KbSearchHitDto)。
     */
    private RerankOutcome rerankPipeline(UUID kbId, String query, List<KbSearchHitDto> pool,
                                         List<KbSearchCandidate> vectorRoute, int topK) {
        Map<UUID, String> snippets = finalSnippets(kbId, pool, vectorRoute);
        List<KbSearchHitDto> prepared = pool.stream()
            .map(hit -> new KbSearchHitDto(hit.docId(), hit.docName(), hit.folderId(),
                snippets.getOrDefault(hit.docId(), hit.snippet()), hit.score()))
            .toList();
        List<KbSearchHitDto> rrfOrder = List.copyOf(prepared.subList(0, Math.min(topK, prepared.size())));
        if (prepared.isEmpty()) {
            return new RerankOutcome(rerankPoolOf(prepared, null, rrfOrder), rrfOrder);
        }
        try {
            List<String> documents = prepared.stream()
                .map(hit -> hit.docName() + "\n" + hit.snippet())
                .toList();
            List<Double> scores = rerankClient.rerank(query, documents);
            List<KbSearchHitDto> results =
                applyRerank(prepared, scores, properties.rerankMinScore(), topK);
            return new RerankOutcome(rerankPoolOf(prepared, scores, results), results);
        } catch (IOException e) {
            log.warn("rerank 失败,本次降级为 RRF 排序: {}", e.getMessage());
            return new RerankOutcome(rerankPoolOf(prepared, null, rrfOrder), rrfOrder);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("rerank 被中断,本次降级为 RRF 排序");
            return new RerankOutcome(rerankPoolOf(prepared, null, rrfOrder), rrfOrder);
        }
    }

    /**
     * rerank 采纳纯函数:过滤低于阈值的候选,按重排分降序取前 topK,score 替换为重排分。
     * 过阈值的候选不足 topK 时返回全部过阈值者(全部低于阈值返回空,与词法两路零命中语义一致)。
     * static 包内可见:纯函数,测试直接构造验证。
     */
    static List<KbSearchHitDto> applyRerank(List<KbSearchHitDto> pool, List<Double> scores,
                                            double minScore, int topK) {
        record Scored(KbSearchHitDto hit, double rerankScore) {
        }
        return java.util.stream.IntStream.range(0, pool.size())
            .mapToObj(i -> new Scored(pool.get(i), scores.get(i)))
            .filter(scored -> scored.rerankScore() >= minScore)
            .sorted(java.util.Comparator.comparingDouble(Scored::rerankScore).reversed())
            .limit(topK)
            .map(scored -> new KbSearchHitDto(scored.hit().docId(), scored.hit().docName(),
                scored.hit().folderId(), scored.hit().snippet(), scored.rerankScore()))
            .toList();
    }

    /** 组装 rerank 泳道中间态:池序与 RRF 融合序一致,重排分为 null 表示未执行 rerank。 */
    private static List<KbTraceRerankDto> rerankPoolOf(List<KbSearchHitDto> pool, List<Double> scores,
                                                       List<KbSearchHitDto> results) {
        Set<UUID> inTopK = results.stream().map(KbSearchHitDto::docId).collect(Collectors.toSet());
        List<KbTraceRerankDto> rows = new ArrayList<>(pool.size());
        for (int i = 0; i < pool.size(); i++) {
            KbSearchHitDto hit = pool.get(i);
            rows.add(new KbTraceRerankDto(hit.docId(), hit.docName(), hit.score(),
                scores == null ? null : scores.get(i), inTopK.contains(hit.docId())));
        }
        return List.copyOf(rows);
    }

    /**
     * 最终 snippet 文本组合(kb-hybrid-search-design §6 规则 4):文档前 1000 字符在前,
     * 名次最优块在后(有向量命中时,换行拼接),覆盖 rrfMerge 输出的默认 snippet;
     * 文档摘录批量一次查询。rerank 输入文本与最终输出同源于此。
     */
    private Map<UUID, String> finalSnippets(UUID kbId, List<KbSearchHitDto> hits,
                                            List<KbSearchCandidate> vectorRoute) {
        if (hits.isEmpty()) {
            return Map.of();
        }
        // 向量路行按名次升序,putIfAbsent 保留每篇文档名次最优块的文本
        Map<UUID, String> bestChunkByDoc = new LinkedHashMap<>();
        for (KbSearchCandidate candidate : vectorRoute) {
            bestChunkByDoc.putIfAbsent(candidate.docId(), candidate.snippet());
        }
        Map<UUID, String> excerpts =
            repository.docExcerpts(kbId, hits.stream().map(KbSearchHitDto::docId).toList());
        Map<UUID, String> composed = new LinkedHashMap<>();
        for (KbSearchHitDto hit : hits) {
            composed.put(hit.docId(), composeSnippet(excerpts.get(hit.docId()),
                bestChunkByDoc.get(hit.docId()), hit.snippet()));
        }
        return composed;
    }

    /**
     * snippet 组合纯函数:文档摘录在前、名次最优块在后,换行分隔;一方缺失取另一方,
     * 两方皆缺回退 rrfMerge 的默认 snippet。
     */
    static String composeSnippet(String docExcerpt, String bestChunk, String fallback) {
        String head = docExcerpt == null ? "" : docExcerpt.strip();
        String tail = bestChunk == null ? "" : bestChunk.strip();
        if (head.isEmpty() && tail.isEmpty()) {
            return fallback == null ? "" : fallback.strip();
        }
        if (head.isEmpty()) {
            return tail;
        }
        return tail.isEmpty() ? head : head + "\n" + tail;
    }

    /**
     * 检索执行快照:入口参数与各阶段中间态,debug 追踪据此组装;results 为最终命中。
     * 包内可见:buildTrace 纯函数测试需要构造。
     */
    record SearchRun(int topK, int candidateLimit, double vectorMaxDistance,
                     double rerankMinScore, String rerankModel,
                     List<KbSearchCandidate> vectorRoute,
                     List<KbSearchCandidate> keywordRoute,
                     List<KbSearchCandidate> ftsRoute,
                     List<KbTraceRerankDto> rerankPool,
                     List<KbSearchHitDto> results) {
    }

    /** 查询文本向量化(单条;失败包装为运行时异常,检索是同步请求路径,不能泄出受检异常)。 */
    private String embedQuery(String query) {
        try {
            List<List<Float>> vectors = embeddingClient.embed(List.of(query));
            if (vectors.isEmpty()) {
                throw new IllegalStateException("查询向量化返回空结果");
            }
            return KbEmbeddingClient.toHalfvecLiteral(vectors.get(0));
        } catch (IOException e) {
            throw new IllegalStateException("查询向量化失败: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("查询向量化被中断", e);
        }
    }

    /**
     * RRF(Reciprocal Rank Fusion)合并:三路候选统一按 docId 聚合为文档级命中,
     * 每条候选行按名次给所属文档贡献 {@code 1/(k + rank)}(rank 从 1 起),同文档
     * 跨路、跨块分数累加,按总分降序取前 topK(同分按首次出现顺序稳定排序)。
     *
     * <p>snippet 选优:向量路块文本优先——路由顺序固定为向量 → 关键词 → 全文,
     * 向量路内按名次升序,故 {@code putIfAbsent} 首次写入即该文档名次最优的块文本;
     * 纯词法命中的文档退回抽取全文。输出侧统一截断。
     *
     * <p>static 包内可见:纯函数,测试直接构造候选验证排序与融合。
     */
    static List<KbSearchHitDto> rrfMerge(List<KbSearchCandidate> vectorRoute,
                                         List<KbSearchCandidate> keywordRoute,
                                         List<KbSearchCandidate> ftsRoute,
                                         int topK) {
        Map<UUID, Double> scores = new LinkedHashMap<>();
        Map<UUID, String> snippets = new LinkedHashMap<>();
        Map<UUID, KbSearchCandidate> representatives = new LinkedHashMap<>();
        for (List<KbSearchCandidate> route : List.of(vectorRoute, keywordRoute, ftsRoute)) {
            int rank = 1;
            for (KbSearchCandidate candidate : route) {
                scores.merge(candidate.docId(), 1.0 / (RRF_K + rank), Double::sum);
                snippets.putIfAbsent(candidate.docId(), candidate.snippet());
                representatives.putIfAbsent(candidate.docId(), candidate);
                rank++;
            }
        }
        return scores.entrySet().stream()
            .sorted(Map.Entry.<UUID, Double>comparingByValue().reversed())
            .limit(topK)
            .map(entry -> {
                UUID docId = entry.getKey();
                KbSearchCandidate representative = representatives.get(docId);
                return new KbSearchHitDto(
                    docId,
                    representative.docName(),
                    representative.folderId(),
                    truncateSnippet(snippets.get(docId)),
                    entry.getValue());
            })
            .toList();
    }

    /**
     * 组装 debug 追踪:三路候选逐行给名次与 RRF 贡献;文档级聚合沿用 {@link #rrfMerge}
     * 的遍历顺序(路序固定、路内名次升序),按总分降序稳定排序,保证 docs 排序与最终
     * results 完全一致。docs 含出现在任意一路的全部文档(不只 topK),inTopK 标记落选。
     * static 包内可见:纯函数,测试直接构造中间态验证。
     */
    static KbSearchTraceDto buildTrace(UUID kbId, String query, UUID folderId, SearchRun run) {
        List<Map.Entry<String, List<KbSearchCandidate>>> routes = List.of(
            Map.entry(KbSearchTraceDto.PATH_VECTOR, run.vectorRoute()),
            Map.entry(KbSearchTraceDto.PATH_KEYWORD, run.keywordRoute()),
            Map.entry(KbSearchTraceDto.PATH_FTS, run.ftsRoute()));
        List<KbTracePathDto> paths = routes.stream()
            .map(route -> tracePath(route.getKey(), route.getValue(), run.vectorMaxDistance()))
            .toList();

        record DocAgg(KbSearchCandidate representative, List<KbTraceContributionDto> contributions) {
            double total() {
                return contributions.stream().mapToDouble(KbTraceContributionDto::score).sum();
            }
        }
        Map<UUID, DocAgg> aggregated = new LinkedHashMap<>();
        for (Map.Entry<String, List<KbSearchCandidate>> route : routes) {
            int rank = 1;
            for (KbSearchCandidate candidate : route.getValue()) {
                DocAgg agg = aggregated.computeIfAbsent(candidate.docId(),
                    id -> new DocAgg(candidate, new ArrayList<>()));
                agg.contributions().add(new KbTraceContributionDto(route.getKey(), rank, 1.0 / (RRF_K + rank)));
                rank++;
            }
        }
        // stream sorted 稳定:总分相同的文档保持首次出现序,与 rrfMerge 一致
        List<Map.Entry<UUID, DocAgg>> sorted = aggregated.entrySet().stream()
            .sorted(Map.Entry.<UUID, DocAgg>comparingByValue(
                java.util.Comparator.comparingDouble(DocAgg::total).reversed()))
            .toList();
        List<KbTraceDocDto> docs = new ArrayList<>(sorted.size());
        for (int i = 0; i < sorted.size(); i++) {
            Map.Entry<UUID, DocAgg> entry = sorted.get(i);
            docs.add(new KbTraceDocDto(
                entry.getKey(),
                entry.getValue().representative().docName(),
                entry.getValue().representative().folderId(),
                entry.getValue().total(),
                i + 1,
                i < run.topK(),
                List.copyOf(entry.getValue().contributions())));
        }
        return new KbSearchTraceDto(kbId, query, folderId, run.topK(), run.candidateLimit(),
            run.rerankMinScore(), run.rerankModel(),
            paths, run.rerankPool(), List.copyOf(docs), run.results());
    }

    /** 单路候选明细:行序即名次(rank 从 1 起),逐行给出 RRF 贡献与命中文本
     * (向量路 = chunk 原文,词法两路 = 文档前 1000 字符,由 SQL 层截取,此处不再截断)。 */
    private static KbTracePathDto tracePath(String path, List<KbSearchCandidate> route,
                                            double vectorMaxDistance) {
        List<KbTraceCandidateDto> candidates = new ArrayList<>(route.size());
        int rank = 1;
        for (KbSearchCandidate candidate : route) {
            candidates.add(new KbTraceCandidateDto(
                candidate.docId(),
                candidate.docName(),
                candidate.folderId(),
                rank,
                candidate.rawScore(),
                candidate.chunkIndex(),
                1.0 / (RRF_K + rank),
                candidate.snippet()));
            rank++;
        }
        return new KbTracePathDto(path, pathMetric(path, vectorMaxDistance), List.copyOf(candidates));
    }

    /** 路内原始分语义说明(与三路 SQL 的排序表达式一一对应,面向调试展示;
     * 向量路带距离阈值,超阈值的块在 SQL 层已过滤,0 候选即全部超阈值)。 */
    private static String pathMetric(String path, double vectorMaxDistance) {
        return switch (path) {
            case KbSearchTraceDto.PATH_VECTOR -> "余弦距离(≤ " + vectorMaxDistance + ",越小越相关)";
            case KbSearchTraceDto.PATH_KEYWORD -> "pg_trgm 相似度(0~1,越大越相关)";
            case KbSearchTraceDto.PATH_FTS -> "ts_rank 词命中分(越大越相关)";
            default -> throw new IllegalStateException("未知检索路径: " + path);
        };
    }

    private static String truncateSnippet(String text) {
        if (text == null || text.isEmpty()) {
            return "";
        }
        return text.length() <= SNIPPET_MAX_CHARS ? text : text.substring(0, SNIPPET_MAX_CHARS) + "…";
    }

    private static int clampTopK(Integer topK) {
        if (topK == null) {
            return DEFAULT_SEARCH_TOP_K;
        }
        return Math.max(1, Math.min(MAX_SEARCH_TOP_K, topK));
    }

    /**
     * 上传文档:预检同名与来源格式 → 本地落盘 → 落 pending 元数据行(含 chunk 参数)
     * → 提交异步解析。
     *
     * <p>字节由 multipart 直接载入(上限 {@code KB_MAX_UPLOAD_MB}),管线消费后即释放。
     * 来源只接受文件与图片:扩展名必须在 {@link DocumentParser#isSupported} 白名单内
     * (纯文本/图片/Tika 族),白名单外 400 拒绝——知识库不支持在线文档与其他数据来源。
     */
    @Transactional
    public KbDocumentDto uploadDocument(AuthContext auth, UUID kbId, UUID folderId, MultipartFile file,
                                        Integer chunkMaxSize, Integer chunkOverlap, String chunkSeparator) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        if (folderId != null) {
            requireFolder(kbId, folderId);
        }
        String name = sanitizeFileName(file.getOriginalFilename());
        if (file.isEmpty()) {
            throw new IllegalArgumentException("上传文件为空: " + name);
        }
        if (!DocumentParser.isSupported(name)) {
            throw new IllegalArgumentException(
                "不支持的文档格式: " + name + "(仅支持文本/图片/pdf/office 等文件与图片上传)");
        }
        if (repository.documentNameExists(kbId, folderId, name)) {
            throw new IllegalArgumentException("同级目录下已存在同名文档: " + name);
        }
        byte[] content;
        try {
            content = file.getBytes();
        } catch (java.io.IOException e) {
            throw new IllegalStateException("读取上传文件失败: " + name, e);
        }
        ChunkSplitter.ChunkParams chunkParams =
            ChunkSplitter.ChunkParams.of(chunkMaxSize, chunkOverlap, chunkSeparator, properties);
        String contentType = file.getContentType() == null || file.getContentType().isBlank()
            ? "application/octet-stream" : file.getContentType();
        UUID docId = UUID.randomUUID();
        // 对象路径 {appId}/{docId}/document{ext} 在存储根目录下按应用分段隔离,对象名只用
        // docId + ASCII 扩展名(避开中文/特殊字符的文件系统兼容问题),显示名以元数据 name 为准
        // (下载由前端按 name 命名)
        String storagePath = kb.applicationId() + "/" + docId + "/document" + storageExtension(name);
        KbDocumentRecord doc = new KbDocumentRecord(docId, kbId, folderId, name, contentType,
            content.length, storagePath, null, KbDocumentDto.STATUS_PENDING, null,
            chunkParams.maxSize(), chunkParams.overlap(), chunkParams.separator(),
            auth.authSubject(), null, null);
        localStorage.store(storagePath, content);
        KbDocumentRecord inserted = repository.insertDocument(doc);
        // 入队等事务提交后再做:元数据行未提交时 pipeline 的 ready 回写会被同一行的
        // insert 锁阻塞(不至死锁,但没必要),afterCommit 保证管线看到的行一定已存在
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                parsePipeline.submit(inserted, content);
            }
        });
        auditService.record("KB_DOCUMENT_UPLOAD", "kb_document", null, auth.platformUserId(),
            Map.of("kbId", kbId, "docId", docId, "name", name, "sizeBytes", content.length));
        return toDto(inserted, null, repository.displayNamesByAuthSubjects(Set.of(auth.authSubject())));
    }

    /**
     * 重新解析:从 Storage 回读原文重走完整管线(抽取 → chunk → embedding → 覆盖 kb_chunks)。
     * 解析中(pending)拒绝;chunk 参数可选,缺省沿用文档当前值;旧 chunk 在解析完成时整篇覆盖。
     */
    public KbDocumentDto reparseDocument(AuthContext auth, UUID kbId, UUID docId,
                                         Integer chunkMaxSize, Integer chunkOverlap, String chunkSeparator) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        KbDocumentRecord doc = repository.findDocument(kbId, docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        if (KbDocumentDto.STATUS_PENDING.equals(doc.parseStatus())) {
            throw new IllegalStateException("文档正在解析中,请等待完成后再重新解析");
        }
        ChunkSplitter.ChunkParams chunkParams =
            ChunkSplitter.ChunkParams.of(chunkMaxSize, chunkOverlap, chunkSeparator, properties);
        byte[] content = localStorage.load(doc.storagePath());
        repository.resetParsing(docId, chunkParams);
        KbDocumentRecord reset = repository.findDocument(kbId, docId).orElse(doc);
        parsePipeline.submit(reset, content);
        auditService.record("KB_DOCUMENT_REPARSE", "kb_document", null, auth.platformUserId(),
            Map.of("kbId", kbId, "docId", docId, "name", doc.name()));
        return toDto(reset, null, repository.displayNamesByAuthSubjects(Set.of(doc.uploadedBy())));
    }

    /**
     * 下载文档原文(Storage 透传用户 JWT 取回)。
     */
    public KbDocumentContentDto downloadDocument(AuthContext auth, UUID kbId, UUID docId) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        KbDocumentRecord doc = repository.findDocument(kbId, docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        byte[] content = localStorage.load(doc.storagePath());
        return new KbDocumentContentDto(docId, doc.name(), doc.contentType(), content);
    }

    /**
     * 读文档抽取全文(员工端 kb_read 工具):按 docId 直查,KB 归属从行内 kb_id
     * 推导后照常做成员校验;未解析完成返回 pending 状态由调用方呈现。
     */
    public KbDocumentTextDto readDocumentText(AuthContext auth, UUID docId) {
        KbDocumentRecord doc = repository.findDocumentById(docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        KnowledgeBaseDto kb = repository.findKb(doc.kbId())
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + doc.kbId()));
        checkAppMemberAccess(auth, kb.applicationId());
        return new KbDocumentTextDto(
            doc.id(), doc.kbId(), doc.name(), doc.textContent(), doc.parseStatus());
    }

    /**
     * 服务身份变体(X-Service-Key):按 docId 读文档全文,不做员工成员校验,
     * 形态同 {@link #readDocumentText}(未解析完成返回 pending 状态由调用方呈现)。
     * 仅限 {@code BackendKbController} 的只读端点。
     */
    public KbDocumentTextDto readDocumentTextForService(UUID docId) {
        KbDocumentRecord doc = repository.findDocumentById(docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        return new KbDocumentTextDto(
            doc.id(), doc.kbId(), doc.name(), doc.textContent(), doc.parseStatus());
    }

    /**
     * 按文档 id 查元数据(员工端历史消息 KB 徽标):按 docId 直查,KB 归属从
     * 行内 kb_id 推导后照常做成员校验。
     */
    public KbDocumentDto getDocument(AuthContext auth, UUID docId) {
        KbDocumentRecord doc = repository.findDocumentById(docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        KnowledgeBaseDto kb = repository.findKb(doc.kbId())
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + doc.kbId()));
        checkAppMemberAccess(auth, kb.applicationId());
        return toDto(doc, null, repository.displayNamesByAuthSubjects(Set.of(doc.uploadedBy())));
    }

    @Transactional
    public void deleteDocument(AuthContext auth, UUID kbId, UUID docId) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        KbDocumentRecord doc = repository.findDocument(kbId, docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        // 先删 Storage 再删元数据行:Storage 删除失败(502)时行保留可重试
        localStorage.delete(doc.storagePath());
        repository.deleteDocument(docId);
        auditService.record("KB_DOCUMENT_DELETE", "kb_document", null, auth.platformUserId(),
            Map.of("kbId", kbId, "docId", docId, "name", doc.name()));
    }

    // ---------- 内部 ----------

    private KbFolderDto requireFolder(UUID kbId, UUID folderId) {
        return repository.findFolder(kbId, folderId)
            .orElseThrow(() -> new NotFoundException("文件夹不存在: " + folderId));
    }

    private void checkKbAccess(AuthContext auth, UUID kbId) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
    }

    /**
     * 内容访问校验:system_admin / 应用管理员直通;其余须为 active 成员(口径同 RLS)。
     */
    private void checkAppMemberAccess(AuthContext auth, UUID appId) {
        if (auth.isSystemAdmin() || isAppAdmin(auth, appId)) {
            return;
        }
        if (!repository.isActiveMember(appId, auth.authSubject())) {
            throw new AccessDeniedException("用户不是应用 " + appId + " 的管理员或成员");
        }
    }

    /**
     * 配置动作校验(开通知识库):仅 system_admin / 应用管理员。
     */
    private void checkAppAdminAccess(AuthContext auth, UUID appId) {
        if (auth.isSystemAdmin()) {
            return;
        }
        if (!isAppAdmin(auth, appId)) {
            throw new AccessDeniedException("只有应用管理员可以配置知识库");
        }
    }

    private boolean isAppAdmin(AuthContext auth, UUID appId) {
        return appRepository.findById(appId)
            .map(app -> app.appAdminUserIds() != null
                && app.appAdminUserIds().contains(auth.platformUserId()))
            .orElse(false);
    }

    /**
     * Storage 对象扩展名:取文件名最后一个 '.' 之后、仅含 ASCII 字母数字的部分(小写),
     * 否则为空串——对象 key 不含用户输入的中文/特殊字符(S3 风格白名单),显示名以元数据为准。
     */
    private static String storageExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) {
            return "";
        }
        String ext = fileName.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        boolean asciiAlnum = ext.chars().allMatch(c -> (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
        return asciiAlnum ? "." + ext : "";
    }

    /**
     * 上传文件名:去掉浏览器可能携带的路径部分,校验非空、无分隔符、长度上限。
     */
    private static String sanitizeFileName(String original) {
        if (original == null || original.isBlank()) {
            throw new IllegalArgumentException("上传文件名为空");
        }
        String name = original.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        name = name.substring(slash + 1).trim();
        if (name.isBlank() || name.contains("/")) {
            throw new IllegalArgumentException("上传文件名非法: " + original);
        }
        if (name.length() > 200) {
            throw new IllegalArgumentException("文件名最长 200 字符");
        }
        return name;
    }

    private static void validateFolderName(String name) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("文件夹名不能为空");
        }
        if (name.contains("/")) {
            throw new IllegalArgumentException("文件夹名不能包含 '/'");
        }
        if (name.length() > 100) {
            throw new IllegalArgumentException("文件夹名最长 100 字符");
        }
    }

    /**
     * 行记录 → 列表 DTO:全文换摘要——kw 命中给命中窗口(前 80 后 160 字符),否则前 200 字符;
     * 上传者 id 按调用方批量解析出的显示名回填(缺失时为 null,前端降级显示短 id)。
     */
    private static KbDocumentDto toDto(KbDocumentRecord doc, String kw, Map<String, String> uploaderNames) {
        return new KbDocumentDto(doc.id(), doc.kbId(), doc.folderId(), doc.name(), doc.contentType(),
            doc.sizeBytes(), doc.parseStatus(), doc.parseError(), excerpt(doc.textContent(), kw),
            doc.chunkMaxSize(), doc.chunkOverlap(), doc.chunkSeparator(),
            doc.uploadedBy(), uploaderNames.get(doc.uploadedBy()), doc.createdAt(), doc.updatedAt());
    }

    private static String excerpt(String text, String kw) {
        if (text == null || text.isBlank()) {
            return "";
        }
        if (kw != null && !kw.isBlank()) {
            int idx = text.toLowerCase(Locale.ROOT).indexOf(kw.toLowerCase(Locale.ROOT));
            if (idx >= 0) {
                int start = Math.max(0, idx - 80);
                int end = Math.min(text.length(), idx + kw.length() + 160);
                return (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length() ? "…" : "");
            }
        }
        return text.length() <= 200 ? text : text.substring(0, 200) + "…";
    }
}
