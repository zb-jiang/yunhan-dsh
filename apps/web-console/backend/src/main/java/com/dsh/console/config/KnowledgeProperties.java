package com.dsh.console.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * 知识库模块配置。
 *
 * <p>绑定 yaml 中 {@code dsh.knowledge.*} 字段。文档原文存服务器本地文件系统
 * (storage-root 根目录,应用间 {appId}/ 一级目录隔离),元数据在本地 PG。
 * embedding 走 OpenAI 兼容 {@code /embeddings} 端点,rerank 走 cohere 风格 {@code /rerank}
 * 端点,两组 API 各自独立配置基址与密钥(默认同为硅基流动,可指向不同供应商)。
 *
 * @param storageRoot              文档原文存储根目录(env {@code KB_STORAGE_ROOT};缺失启动即失败——
 *                                文档落盘位置属于部署决策,不隐藏默认值;相对路径按进程工作目录解析)
 * @param tessdataPath            Tesseract 语言训练数据目录(env {@code TESSDATA_PATH};空表示 OCR 不可用,
 *                                图片解析标记 failed,不阻塞其他类型)
 * @param maxUploadSizeMb         单文档上传上限 MB(env {@code KB_MAX_UPLOAD_MB},默认 50;
 *                                与 {@code spring.servlet.multipart} 上限共用同一环境变量)
 * @param embeddingApiUrl         embedding API 基址(env {@code KB_EMBEDDING_API_URL};
 *                                默认硅基流动 {@code https://api.siliconflow.cn/v1})
 * @param embeddingApiKey         embedding API 密钥(env {@code KB_EMBEDDING_API_KEY};缺失启动即失败——
 *                                解析管线无可用凭证属于自包含配置错误,尽早暴露)
 * @param embeddingModel          embedding 模型名(env {@code KB_EMBEDDING_MODEL};须与
 *                                {@code embedding-dimensions} 输出一致)
 * @param embeddingDimensions     embedding 输出维度(env {@code KB_EMBEDDING_DIMENSIONS};请求体带
 *                                {@code dimensions} 参数钉死输出宽度,必须与 kb_chunks.embedding 列的
 *                                halfvec(N) 一致,不一致时行插入报错,前置校验给出可读信息)
 * @param embeddingConnectTimeout embedding HTTP 连接超时(env {@code KB_EMBEDDING_CONNECT_TIMEOUT})
 * @param embeddingResponseTimeout embedding 单批请求总超时(env {@code KB_EMBEDDING_RESPONSE_TIMEOUT};
 *                                上游限流或模型排队时单批可达数十秒)
 * @param chunkMaxSize            默认单 chunk 最大字符数(上传未显式指定时落库的默认值)
 * @param chunkOverlap            默认相邻 chunk 重叠字符数
 * @param chunkSeparator          默认优先切分的分隔符
 * @param embeddingMaxDistance    向量路召回余弦距离阈值(env {@code KB_EMBEDDING_MAX_DISTANCE},默认 0.7;
 *                                只挡极端垃圾(kNN 对任意查询都必然有输出),边界候选交由 rerank 精排判断;
 *                                取值依赖 embedding 模型,Qwen3-Embedding-4B 实测相关 ≤0.53、无关正常查询 ≥0.57)
 * @param rerankApiUrl            rerank API 基址(env {@code KB_RERANK_API_URL};
 *                                默认硅基流动 {@code https://api.siliconflow.cn/v1},可指向其他供应商)
 * @param rerankApiKey            rerank API 密钥(env {@code KB_RERANK_API_KEY};缺失启动即失败——rerank
 *                                常开且无独立开关,无凭证属于自包含配置错误,尽早暴露)
 * @param rerankModel             重排模型(env {@code KB_RERANK_MODEL};
 *                                cross-encoder 输出 0~1 相关性分,无关对实测贴近 0、相关对 0.5+)
 * @param rerankMinScore          重排采纳阈值(env {@code KB_RERANK_MIN_SCORE},默认 0.1;低于阈值的候选
 *                                视为不相关被过滤——Qwen3-Reranker-8B 实测分数双峰分布,断档在 0.02~0.26,
 *                                0.1 居中且偏向宁可多留;rerank 失败时降级为 RRF 排序,不阻塞检索)
 */
@ConfigurationProperties(prefix = "dsh.knowledge")
public record KnowledgeProperties(
    String storageRoot,
    String tessdataPath,
    int maxUploadSizeMb,
    @DefaultValue("https://api.siliconflow.cn/v1") String embeddingApiUrl,
    String embeddingApiKey,
    @DefaultValue("Qwen/Qwen3-Embedding-4B") String embeddingModel,
    @DefaultValue("2560") int embeddingDimensions,
    @DefaultValue("10s") Duration embeddingConnectTimeout,
    @DefaultValue("120s") Duration embeddingResponseTimeout,
    @DefaultValue("1000") int chunkMaxSize,
    @DefaultValue("150") int chunkOverlap,
    @DefaultValue("\n\n") String chunkSeparator,
    @DefaultValue("0.7") double embeddingMaxDistance,
    @DefaultValue("https://api.siliconflow.cn/v1") String rerankApiUrl,
    String rerankApiKey,
    @DefaultValue("Qwen/Qwen3-Reranker-8B") String rerankModel,
    @DefaultValue("0.1") double rerankMinScore
) {
    public KnowledgeProperties {
        if (storageRoot == null || storageRoot.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.storage-root 未配置(环境变量 KB_STORAGE_ROOT)");
        }
        if (maxUploadSizeMb <= 0) {
            throw new IllegalStateException("dsh.knowledge.max-upload-size-mb 必须为正整数");
        }
        if (embeddingApiUrl == null || embeddingApiUrl.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.embedding-api-url 未配置(环境变量 KB_EMBEDDING_API_URL)");
        }
        if (embeddingApiKey == null || embeddingApiKey.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.embedding-api-key 未配置(环境变量 KB_EMBEDDING_API_KEY)");
        }
        if (embeddingModel == null || embeddingModel.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.embedding-model 未配置(环境变量 KB_EMBEDDING_MODEL)");
        }
        if (embeddingDimensions <= 0 || embeddingDimensions > 16000) {
            throw new IllegalStateException("dsh.knowledge.embedding-dimensions 必须在 1~16000 之间");
        }
        if (embeddingConnectTimeout == null || embeddingConnectTimeout.isNegative() || embeddingConnectTimeout.isZero()) {
            throw new IllegalStateException("dsh.knowledge.embedding-connect-timeout 必须为正时长");
        }
        if (embeddingResponseTimeout == null || embeddingResponseTimeout.isNegative()
            || embeddingResponseTimeout.isZero()
            || embeddingResponseTimeout.compareTo(embeddingConnectTimeout) < 0) {
            throw new IllegalStateException("dsh.knowledge.embedding-response-timeout 必须为不小于连接超时的正时长");
        }
        if (chunkMaxSize < 100 || chunkMaxSize > 8000) {
            throw new IllegalStateException("dsh.knowledge.chunk-max-size 必须在 100~8000 之间");
        }
        if (chunkOverlap < 0 || chunkOverlap >= chunkMaxSize) {
            throw new IllegalStateException("dsh.knowledge.chunk-overlap 必须满足 0 <= overlap < chunk-max-size");
        }
        // 分隔符允许纯空白(默认 "\n\n"),只拒空串
        if (chunkSeparator == null || chunkSeparator.isEmpty()) {
            throw new IllegalStateException("dsh.knowledge.chunk-separator 不能为空");
        }
        // 余弦距离取值范围 [0, 2];阈值在闭区间内才有过滤意义
        if (embeddingMaxDistance <= 0 || embeddingMaxDistance >= 2) {
            throw new IllegalStateException("dsh.knowledge.embedding-max-distance 必须在 0~2 之间(不含端点)");
        }
        if (rerankApiUrl == null || rerankApiUrl.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.rerank-api-url 未配置(环境变量 KB_RERANK_API_URL)");
        }
        if (rerankApiKey == null || rerankApiKey.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.rerank-api-key 未配置(环境变量 KB_RERANK_API_KEY)");
        }
        // 重排分 0~1;阈值取闭区间端点时全过滤/全保留,无意义
        if (rerankMinScore < 0 || rerankMinScore >= 1) {
            throw new IllegalStateException("dsh.knowledge.rerank-min-score 必须在 0(含)~1(不含)之间");
        }
        if (rerankModel == null || rerankModel.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.rerank-model 不能为空");
        }
    }

    /**
     * OCR 是否可用(TESSDATA_PATH 已配置)。
     */
    public boolean ocrEnabled() {
        return tessdataPath != null && !tessdataPath.isBlank();
    }
}
