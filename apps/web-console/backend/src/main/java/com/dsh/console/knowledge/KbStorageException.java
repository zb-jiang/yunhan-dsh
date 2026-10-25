package com.dsh.console.knowledge;

/**
 * 知识库文档原文的本地文件系统读写失败(写入/读取/删除)。
 *
 * <p>由 common 包 {@code GlobalExceptionHandler} 映射为 500 STORAGE_ERROR:
 * 失败多为磁盘满/权限/文件缺失,属本服务端故障,非上游依赖不可用。
 */
public class KbStorageException extends RuntimeException {

    public KbStorageException(String message, Throwable cause) {
        super(message, cause);
    }
}
