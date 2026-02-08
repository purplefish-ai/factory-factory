import { describe, expect, it } from 'vitest';
import { hasRenderableAssistantContent } from './chat-event-forwarder.helpers';

describe('hasRenderableAssistantContent', () => {
  it('returns true for assistant text content', () => {
    expect(hasRenderableAssistantContent([{ type: 'text', text: 'hello' }])).toBe(true);
  });

  it('returns true for tool_use-only content', () => {
    expect(
      hasRenderableAssistantContent([{ type: 'tool_use' } as { type: string; text?: string }])
    ).toBe(true);
  });

  it('returns true for thinking-only content', () => {
    expect(
      hasRenderableAssistantContent([{ type: 'thinking' } as { type: string; text?: string }])
    ).toBe(true);
  });

  it('returns false for empty or unsupported content', () => {
    expect(hasRenderableAssistantContent([])).toBe(false);
    expect(hasRenderableAssistantContent([{ type: 'text' }, { type: 'content_block_stop' }])).toBe(
      false
    );
  });
});
