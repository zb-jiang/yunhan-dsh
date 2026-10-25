package com.dsh.console.knowledge;

import com.dsh.console.config.KnowledgeProperties;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import org.springframework.stereotype.Component;

/**
 * 知识库文档原文的本地文件系统存储:对象路径 {@code {appId}/{docId}/document{ext}}
 * 相对 {@code dsh.knowledge.storage-root} 根目录落盘,应用间一级目录隔离,元数据在 PG。
 *
 * <p>写入为同目录 temp 文件 + 原子 move:读者要么看到完整旧文件、要么完整新文件,
 * 无半写状态。删除后向上清理空目录({@code {docId}/} 随对象消亡,{@code {appId}/} 留给
 * 同应用其余文档)。对象路径经 {@link #resolveChecked} 归一校验,拒绝越出根目录的路径
 * (路径源为 DB 的 storage_path,防历史脏行逃逸出根目录)。
 */
@Component
public class KbLocalStorage {

    private final Path root;

    public KbLocalStorage(KnowledgeProperties properties) {
        this.root = Path.of(properties.storageRoot()).toAbsolutePath().normalize();
    }

    /**
     * 写入文档原文(同路径重复写入整文件覆盖,由调用方保证路径唯一)。
     *
     * @param objectPath 根目录下相对路径({appId}/{docId}/document{ext})
     * @param content    文件字节
     */
    public void store(String objectPath, byte[] content) {
        Path target = resolveChecked(objectPath);
        Path temp = null;
        try {
            Files.createDirectories(target.getParent());
            temp = Files.createTempFile(target.getParent(), "upload-", ".tmp");
            Files.write(temp, content);
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            try {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException ex) {
                throw new KbStorageException("写入文档原文失败: " + objectPath + ": " + ex.getMessage(), ex);
            }
        } catch (IOException e) {
            throw new KbStorageException("写入文档原文失败: " + objectPath + ": " + e.getMessage(), e);
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (IOException e) {
                    // temp 清理失败不影响写入结果,残留 .tmp 由下一次同名写入或备份策略消化
                }
            }
        }
    }

    /**
     * 读取文档原文。
     *
     * @return 文件字节(单文档上限 50MB,整载内存可接受)
     */
    public byte[] load(String objectPath) {
        Path target = resolveChecked(objectPath);
        try {
            return Files.readAllBytes(target);
        } catch (NoSuchFileException e) {
            throw new KbStorageException("文档原文不存在: " + objectPath, e);
        } catch (IOException e) {
            throw new KbStorageException("读取文档原文失败: " + objectPath + ": " + e.getMessage(), e);
        }
    }

    /**
     * 删除文档原文;随后从其父目录向上清理空目录,到存储根为止。
     */
    public void delete(String objectPath) {
        Path target = resolveChecked(objectPath);
        try {
            Files.deleteIfExists(target);
        } catch (IOException e) {
            throw new KbStorageException("删除文档原文失败: " + objectPath + ": " + e.getMessage(), e);
        }
        Path dir = target.getParent();
        while (dir != null && !dir.equals(root)) {
            try {
                Files.delete(dir);
            } catch (IOException e) {
                // 非空目录或其他 IO 故障都停止向上清理:目录残留不影响删除语义
                break;
            }
            dir = dir.getParent();
        }
    }

    /**
     * 解析并校验对象路径:拒绝空路径、绝对路径、反斜杠与越出根目录的路径
     * (normalize 吸收 {@code ..} 与冗余段,再按路径段比较限定在根目录内)。
     */
    private Path resolveChecked(String objectPath) {
        if (objectPath == null || objectPath.isBlank() || objectPath.startsWith("/")
            || objectPath.contains("\\")) {
            throw new IllegalArgumentException("非法对象路径: " + objectPath);
        }
        Path resolved = root.resolve(objectPath).normalize();
        if (!resolved.startsWith(root) || resolved.equals(root)) {
            throw new IllegalArgumentException("对象路径越出存储根目录: " + objectPath);
        }
        return resolved;
    }
}
