import { describe, expect, it } from 'vitest';
import {
  type ClaudeContentItem,
  hasRenderableAssistantContent,
  isRenderableAssistantContentItem,
  shouldPersistClaudeMessage,
} from './protocol';

describe('assistant renderability guards', () => {
  it('rejects malformed tool_use blocks missing id/name', () => {
    expect(isRenderableAssistantContentItem({ type: 'tool_use', id: 'tool-1', input: {} })).toBe(
      false
    );
    expect(isRenderableAssistantContentItem({ type: 'tool_use', name: 'Read', input: {} })).toBe(
      false
    );
  });

  it('rejects malformed tool_result and thinking blocks', () => {
    expect(isRenderableAssistantContentItem({ type: 'tool_result', tool_use_id: 'tool-1' })).toBe(
      false
    );
    expect(isRenderableAssistantContentItem({ type: 'thinking' })).toBe(false);
  });

  it('accepts valid non-text assistant content blocks', () => {
    expect(isRenderableAssistantContentItem({ type: 'tool_use', id: 'tool-1', name: 'Read' })).toBe(
      true
    );
    expect(
      hasRenderableAssistantContent([
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } },
      ])
    ).toBe(true);
    expect(
      hasRenderableAssistantContent([{ type: 'tool_result', tool_use_id: 'tool-1', content: '' }])
    ).toBe(true);
    expect(hasRenderableAssistantContent([{ type: 'thinking', thinking: 'planning' }])).toBe(true);
  });

  it('persists assistant message with stream-compatible tool_use blocks', () => {
    expect(
      shouldPersistClaudeMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read' } as unknown as ClaudeContentItem,
          ],
        },
      })
    ).toBe(true);
  });

  it('persists stream tool_use content_block_start without initial input', () => {
    expect(
      shouldPersistClaudeMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
          } as unknown as ClaudeContentItem,
        },
      })
    ).toBe(true);
  });
});
