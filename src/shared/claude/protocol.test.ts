import { describe, expect, it } from 'vitest';
import {
  type ClaudeContentItem,
  hasRenderableAssistantContent,
  isRenderableAssistantContentItem,
  shouldPersistClaudeMessage,
} from './protocol';

describe('assistant renderability guards', () => {
  it('rejects malformed tool_use blocks', () => {
    expect(isRenderableAssistantContentItem({ type: 'tool_use', id: 'tool-1', name: 'Read' })).toBe(
      false
    );
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

  it('does not persist assistant message with malformed renderable blocks', () => {
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
    ).toBe(false);
  });

  it('does not persist malformed stream content_block_start blocks', () => {
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
    ).toBe(false);
  });
});
