/**
 * Returns true when assistant content contains blocks that should be forwarded to the UI.
 * We forward:
 * - text (regular assistant narration)
 * - tool_use (tool call requests)
 * - tool_result (tool outputs wrapped in assistant payloads)
 * - thinking (extended thinking blocks)
 */
export function hasRenderableAssistantContent(
  content: Array<{ type?: string; text?: string }>
): boolean {
  return content.some((item) => {
    if (item.type === 'text') {
      return typeof item.text === 'string';
    }
    return item.type === 'tool_use' || item.type === 'tool_result' || item.type === 'thinking';
  });
}
