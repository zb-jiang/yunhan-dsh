/**
 * Deterministic rendering of the model-visible knowledge-base block.
 *
 * @module
 */
/** Section name carried by the injected message's plugin source. */
export const KB_CONTEXT_SECTION = 'kb-context';
/** Fixed usage line: how the assistant reaches the kb with the injected kbId. */
export const KB_USAGE_LINE = '检索用 kb_search(kbId, query)，浏览清单用 kb_list(kbId)，读取全文用 kb_read(docId)；用户以 \'@\' 插入的知识库文档即来自此库。';
/** Fixed usage-discipline line rendered as the block's last content line. */
export const KB_DISCIPLINE = '此归属由系统注入并保持最新，仅供企业知识库检索使用。';
/** Collapse line breaks so one field can never forge the next line of the block. */
function singleLine(value) {
    return value.replace(/\r?\n/g, ' ');
}
/**
 * Render the durable knowledge-base block for one resolved kb.
 * @param data - resolved kb id and name.
 * @returns the exact text carried by the injected message and its source section.
 */
export function renderKbContextText(data) {
    return '<knowledge_base>\n'
        + '本会话所属应用的知识库：\n'
        + `kbId: ${singleLine(data.kbId)}\n`
        + `名称：${singleLine(data.kbName)}\n`
        + `${KB_USAGE_LINE}\n`
        + `${KB_DISCIPLINE}\n`
        + '</knowledge_base>';
}
//# sourceMappingURL=text.js.map