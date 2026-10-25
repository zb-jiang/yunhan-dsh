package com.dsh.console.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.dsh.console.config.KnowledgeProperties;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * {@link ChunkSplitter} 行为测试:切分边界、贪心合并、overlap 衔接与参数校验。
 */
class ChunkSplitterTest {

    private static final String SEP = "\n\n";

    private final ChunkSplitter splitter = new ChunkSplitter();

    private KnowledgeProperties defaults() {
        return new KnowledgeProperties("./target/kb-test-root", null, 50,
            "https://api.siliconflow.test/v1", "sf-test-key", "test-embedding-model", 4096,
            java.time.Duration.ofSeconds(10), java.time.Duration.ofSeconds(120),
            1000, 150, SEP,
            0.7, "https://api.siliconflow.test/v1", "sf-test-key", "test-rerank-model", 0.1);
    }

    @Test
    void blankTextYieldsNoChunks() {
        List<String> chunks = splitter.split("   \n  ", new ChunkSplitter.ChunkParams(1000, 150, SEP));
        assertThat(chunks).isEmpty();
    }

    @Test
    void shortSegmentsMergeIntoSingleChunk() {
        String text = "第一段" + SEP + "第二段" + SEP + "第三段";
        List<String> chunks = splitter.split(text, new ChunkSplitter.ChunkParams(1000, 0, SEP));
        assertThat(chunks).hasSize(1);
        assertThat(chunks.get(0)).contains("第一段").contains("第二段").contains("第三段");
    }

    @Test
    void chunksNeverExceedMaxSize() {
        String text = String.join(SEP, "长段落内容".repeat(100), "另一段".repeat(300), "短段");
        ChunkSplitter.ChunkParams params = new ChunkSplitter.ChunkParams(200, 50, SEP);
        List<String> chunks = splitter.split(text, params);
        assertThat(chunks).isNotEmpty();
        for (String chunk : chunks) {
            assertThat(chunk.length()).isLessThanOrEqualTo(params.maxSize());
        }
    }

    @Test
    void consecutiveChunksOverlapByTail() {
        // 三段各 100 字符,预算 150-30-2=118:单段塞不进两段,逐段成 chunk
        String text = String.join(SEP, "甲".repeat(100), "乙".repeat(100), "丙".repeat(100));
        ChunkSplitter.ChunkParams params = new ChunkSplitter.ChunkParams(150, 30, SEP);
        List<String> chunks = splitter.split(text, params);
        assertThat(chunks).hasSize(3);
        String firstTail = chunks.get(0).substring(chunks.get(0).length() - 30);
        assertThat(chunks.get(1)).startsWith(firstTail);
        String secondTail = chunks.get(1).substring(chunks.get(1).length() - 30);
        assertThat(chunks.get(2)).startsWith(secondTail);
    }

    @Test
    void oversizedSegmentIsHardSplitWithinBudget() {
        String text = "字".repeat(500);
        ChunkSplitter.ChunkParams params = new ChunkSplitter.ChunkParams(200, 0, SEP);
        List<String> chunks = splitter.split(text, params);
        // 预算 = 200 - 0(overlap) - 2("\n\n") = 198:500 字符切成 198/198/104 三块
        assertThat(chunks).hasSize(3);
        assertThat(chunks.get(0)).hasSize(198);
        assertThat(chunks.get(1)).hasSize(198);
        assertThat(chunks.get(2)).hasSize(104);
    }

    @Test
    void chunkOrderFollowsOriginalText() {
        String text = String.join(SEP, "开头段", "中间段", "结尾段");
        List<String> chunks = splitter.split(text, new ChunkSplitter.ChunkParams(100, 0, SEP));
        assertThat(chunks).isNotEmpty();
        assertThat(String.join("", chunks)).contains("开头段").contains("结尾段");
        int head = String.join("", chunks).indexOf("开头段");
        int tail = String.join("", chunks).indexOf("结尾段");
        assertThat(head).isLessThan(tail);
    }

    @Test
    void paramsOfFallsBackToDefaults() {
        KnowledgeProperties defaults = defaults();
        ChunkSplitter.ChunkParams params = ChunkSplitter.ChunkParams.of(null, null, null, defaults);
        assertThat(params.maxSize()).isEqualTo(defaults.chunkMaxSize());
        assertThat(params.overlap()).isEqualTo(defaults.chunkOverlap());
        assertThat(params.separator()).isEqualTo(defaults.chunkSeparator());
    }

    @Test
    void paramsRejectInvalidValues() {
        assertThatThrownBy(() -> new ChunkSplitter.ChunkParams(99, 10, SEP))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ChunkSplitter.ChunkParams(1000, 500, SEP))
            .isInstanceOf(IllegalArgumentException.class);
        // 空串拒绝;纯空白合法(默认 "\n\n"、预设"空格")
        assertThatThrownBy(() -> new ChunkSplitter.ChunkParams(1000, 150, ""))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
