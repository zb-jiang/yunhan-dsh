/**
 * Deterministic rendering of the model-visible knowledge-base block.
 *
 * @module
 */
/** Section name carried by the injected message's plugin source. */
export declare const KB_CONTEXT_SECTION = 'kb-context'
/** Fixed usage line: how the assistant reaches the kb with the injected kbId. */
export declare const KB_USAGE_LINE = "\u68C0\u7D22\u7528 kb_search(kbId, query)\uFF0C\u6D4F\u89C8\u6E05\u5355\u7528 kb_list(kbId)\uFF0C\u8BFB\u53D6\u5168\u6587\u7528 kb_read(docId)\uFF1B\u7528\u6237\u4EE5 '@' \u63D2\u5165\u7684\u77E5\u8BC6\u5E93\u6587\u6863\u5373\u6765\u81EA\u6B64\u5E93\u3002"
/** Fixed usage-discipline line rendered as the block's last content line. */
export declare const KB_DISCIPLINE = '\u6B64\u5F52\u5C5E\u7531\u7CFB\u7EDF\u6CE8\u5165\u5E76\u4FDD\u6301\u6700\u65B0\uFF0C\u4EC5\u4F9B\u4F01\u4E1A\u77E5\u8BC6\u5E93\u68C0\u7D22\u4F7F\u7528\u3002'
/** One resolved knowledge base (web-console KnowledgeBaseDto subset). */
export interface KbBlockData {
  /** Knowledge base id (kbId) that kb_search / kb_list / kb_read take. */
  kbId: string
  /** Knowledge base display name. */
  kbName: string
}
/**
 * Render the durable knowledge-base block for one resolved kb.
 * @param data - resolved kb id and name.
 * @returns the exact text carried by the injected message and its source section.
 */
export declare function renderKbContextText(data: KbBlockData): string
//# sourceMappingURL=text.d.ts.map
