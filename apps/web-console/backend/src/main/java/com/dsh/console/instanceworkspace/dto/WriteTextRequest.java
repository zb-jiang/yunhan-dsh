package com.dsh.console.instanceworkspace.dto;

/**
 * 文本写文件请求体(设计 §4.1 {@code POST /{instanceId}/files/text})。
 *
 * @param path         目标相对路径(/ 分隔)
 * @param content      UTF-8 文本内容(空串允许,落 0 字节文件)
 * @param sourceTaskId 写入来源节点 id(可空)
 */
public record WriteTextRequest(String path, String content, String sourceTaskId) {
}
