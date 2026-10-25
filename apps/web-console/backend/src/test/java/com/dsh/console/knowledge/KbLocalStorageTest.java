package com.dsh.console.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.dsh.console.config.KnowledgeProperties;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@link KbLocalStorage} 行为测试:原子写覆盖、读取缺失、删除后清理空目录、
 * 路径穿越拒绝(绝对路径/反斜杠/{@code ..}/根目录本身)。
 */
class KbLocalStorageTest {

    @TempDir
    Path tempDir;

    private KbLocalStorage storage;

    @BeforeEach
    void setUp() {
        KnowledgeProperties properties = new KnowledgeProperties(
            tempDir.resolve("root").toString(), null, 50,
            "https://api.siliconflow.test/v1", "sf-test-key", "test-embedding-model", 4096,
            java.time.Duration.ofSeconds(10), java.time.Duration.ofSeconds(120),
            1000, 150, "\n\n",
            0.7, "https://api.siliconflow.test/v1", "sf-test-key", "test-rerank-model", 0.1);
        storage = new KbLocalStorage(properties);
    }

    @Test
    void storeWritesFileUnderRootAndLoadReturnsContent() throws IOException {
        storage.store("app-1/doc-1/document.txt", "第一版内容".getBytes());

        byte[] loaded = storage.load("app-1/doc-1/document.txt");

        assertThat(new String(loaded)).isEqualTo("第一版内容");
        assertThat(Files.exists(tempDir.resolve("root/app-1/doc-1/document.txt"))).isTrue();
    }

    @Test
    void storeOverwritesExistingObjectAtomically() {
        storage.store("app-1/doc-1/document.txt", "旧内容".getBytes());
        storage.store("app-1/doc-1/document.txt", "新内容".getBytes());

        assertThat(new String(storage.load("app-1/doc-1/document.txt"))).isEqualTo("新内容");
    }

    @Test
    void storeLeavesNoTempFileBehind() throws IOException {
        storage.store("app-1/doc-1/document.txt", "内容".getBytes());

        try (var files = Files.list(tempDir.resolve("root/app-1/doc-1"))) {
            assertThat(files.filter(p -> p.getFileName().toString().endsWith(".tmp"))).isEmpty();
        }
    }

    @Test
    void loadMissingObjectThrowsStorageException() {
        assertThatThrownBy(() -> storage.load("app-1/doc-9/document.txt"))
            .isInstanceOf(KbStorageException.class)
            .hasMessageContaining("不存在");
    }

    @Test
    void deleteRemovesObjectAndEmptyParentDirectories() throws IOException {
        storage.store("app-1/doc-1/document.txt", "内容".getBytes());

        storage.delete("app-1/doc-1/document.txt");

        assertThat(Files.exists(tempDir.resolve("root/app-1/doc-1"))).isFalse();
        // appId 目录留待同应用其余文档;此处无兄弟文档,向上清理后一并消亡
        assertThat(Files.exists(tempDir.resolve("root/app-1"))).isFalse();
    }

    @Test
    void deleteKeepsParentDirectoryWhenSiblingObjectsRemain() throws IOException {
        storage.store("app-1/doc-1/document.txt", "内容1".getBytes());
        storage.store("app-1/doc-2/document.txt", "内容2".getBytes());

        storage.delete("app-1/doc-1/document.txt");

        assertThat(Files.exists(tempDir.resolve("root/app-1/doc-1"))).isFalse();
        assertThat(new String(storage.load("app-1/doc-2/document.txt"))).isEqualTo("内容2");
    }

    @Test
    void rejectsPathEscapeAttempts() {
        assertThatThrownBy(() -> storage.load("../outside.txt"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> storage.store("app-1/../..//etc/passwd", new byte[0]))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> storage.load("/abs/path.txt"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> storage.load("app-1\\doc\\document.txt"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> storage.load("  "))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
