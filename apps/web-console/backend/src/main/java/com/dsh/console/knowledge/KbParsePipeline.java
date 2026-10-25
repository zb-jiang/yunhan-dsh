package com.dsh.console.knowledge;

import com.dsh.console.knowledge.dto.KbDocumentDto;
import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 文档异步解析管线:上传/重新解析请求线程把字节交给单线程 executor 串行处理——
 * 文本抽取 → chunk 拆分 → 批量 embedding → 事务内整篇替换 kb_chunks 并回写
 * {@code text_content} 与 {@code parse_status=ready};任一步失败记 {@code failed} + 原因,不重抛。
 *
 * <p>多文档上传各自入队排队,互不挤占内存(单文档上限 50MB)。未完成文档不进检索
 * (kw 强制 ready),失败可经重新解析端点恢复。服务重启丢队列中任务,启动时把停留在
 * pending 的文档从本地存储回读原文重新入队(回读失败记 failed,可再次重新解析)。
 */
@Service
public class KbParsePipeline {

    private static final Logger log = LoggerFactory.getLogger(KbParsePipeline.class);

    private final DocumentParser parser;
    private final ChunkSplitter splitter;
    private final KbEmbeddingClient embeddingClient;
    private final KnowledgeJdbcRepository repository;
    private final KbLocalStorage localStorage;
    private final TransactionTemplate transactionTemplate;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "kb-parse");
        thread.setDaemon(true);
        return thread;
    });

    public KbParsePipeline(DocumentParser parser,
                           ChunkSplitter splitter,
                           KbEmbeddingClient embeddingClient,
                           KnowledgeJdbcRepository repository,
                           KbLocalStorage localStorage,
                           TransactionTemplate transactionTemplate) {
        this.parser = parser;
        this.splitter = splitter;
        this.embeddingClient = embeddingClient;
        this.repository = repository;
        this.localStorage = localStorage;
        this.transactionTemplate = transactionTemplate;
    }

    /**
     * 提交解析任务(元数据行已落库、状态 pending 时调用;上传与重新解析共用)。
     *
     * @param doc     文档行(取 name / kbId / chunk 参数)
     * @param content 文件字节(调用方持有;上传取 multipart,重新解析取本地存储回读)
     */
    public void submit(KbDocumentRecord doc, byte[] content) {
        executor.execute(() -> parse(doc, content));
    }

    /**
     * 启动恢复:重启后把停留在 pending 的文档重新入队(队列任务已丢)。
     */
    @EventListener(ApplicationReadyEvent.class)
    void recoverPendingDocuments() {
        List<KbDocumentRecord> pending = repository.listDocumentsByStatus(KbDocumentDto.STATUS_PENDING);
        for (KbDocumentRecord doc : pending) {
            boolean kbExists = repository.findKb(doc.kbId()).isPresent();
            if (!kbExists) {
                repository.updateParseResult(doc.id(), KbDocumentDto.STATUS_FAILED, null, "知识库不存在,无法恢复解析");
                continue;
            }
            try {
                byte[] content = localStorage.load(doc.storagePath());
                submit(doc, content);
                log.info("KB document requeued after restart: {} ({})", doc.name(), doc.id());
            } catch (Exception e) {
                repository.updateParseResult(doc.id(), KbDocumentDto.STATUS_FAILED, null,
                    "重启恢复时从本地存储回读原文失败: " + e.getMessage());
            }
        }
    }

    private void parse(KbDocumentRecord doc, byte[] content) {
        try {
            String text = parser.extract(doc.name(), content);
            ChunkSplitter.ChunkParams params = new ChunkSplitter.ChunkParams(
                doc.chunkMaxSize(), doc.chunkOverlap(), doc.chunkSeparator());
            List<String> chunks = splitter.split(text, params);
            List<String> embeddings = embeddingClient.embed(chunks).stream()
                .map(KbEmbeddingClient::toHalfvecLiteral)
                .toList();
            // chunk 替换与 ready 回写同一事务:检索可见时 chunk 一定是完整的
            transactionTemplate.executeWithoutResult(status -> {
                repository.replaceChunks(doc.id(), doc.kbId(), chunks, embeddings);
                repository.updateParseResult(doc.id(), KbDocumentDto.STATUS_READY, text, null);
            });
            log.info("KB document parsed: {} ({} chunks) ({})", doc.name(), chunks.size(), doc.id());
        } catch (Throwable e) {
            // 解析失败不重抛:单个文档的失败标记 failed 即可,管线继续处理后续文档。
            // catch Throwable 而非 Exception:Tika 依赖冲突等 LinkageError(NoSuchMethodError)不属于 Exception,
            // 漏掉会把单线程池的 worker 直接打死。
            log.error("KB document parse failed: {} ({})", doc.name(), doc.id(), e);
            repository.updateParseResult(doc.id(), KbDocumentDto.STATUS_FAILED, null,
                e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }
}
