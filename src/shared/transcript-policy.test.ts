import { describe, expect, it } from 'vitest';
import type { ClaudeContentItem, ClaudeMessagePayload, ClaudeStreamEvent } from './claude/protocol';
import {
  isSystemContent,
  shouldIncludeAssistantContentItem,
  shouldIncludeAssistantMessage,
  shouldIncludeStreamEvent,
  shouldIncludeUserContentItem,
  shouldIncludeUserMessage,
} from './transcript-policy';

// ============================================================================
// isSystemContent
// ============================================================================

describe('isSystemContent', () => {
  it('detects system_instruction prefix', () => {
    expect(isSystemContent('<system_instruction>You are a helpful assistant')).toBe(true);
  });

  it('detects local-command prefix', () => {
    expect(isSystemContent('<local-command stdout="...">')).toBe(true);
  });

  it('returns false for regular text', () => {
    expect(isSystemContent('Hello, how are you?')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSystemContent('')).toBe(false);
  });

  it('returns false for text containing but not starting with prefix', () => {
    expect(isSystemContent('text before <system_instruction>')).toBe(false);
  });
});

// ============================================================================
// shouldIncludeUserContentItem
// ============================================================================

describe('shouldIncludeUserContentItem', () => {
  it('includes regular text', () => {
    expect(
      shouldIncludeUserContentItem({ type: 'text', text: 'user input' } as ClaudeContentItem)
    ).toBe(true);
  });

  it('excludes system instruction text', () => {
    expect(
      shouldIncludeUserContentItem({
        type: 'text',
        text: '<system_instruction>...',
      } as ClaudeContentItem)
    ).toBe(false);
  });

  it('excludes local-command text', () => {
    expect(
      shouldIncludeUserContentItem({
        type: 'text',
        text: '<local-command>...',
      } as ClaudeContentItem)
    ).toBe(false);
  });

  it('includes tool_result', () => {
    expect(
      shouldIncludeUserContentItem({
        type: 'tool_result',
        tool_use_id: 'abc',
        content: 'result',
      } as ClaudeContentItem)
    ).toBe(true);
  });

  it('includes image', () => {
    expect(
      shouldIncludeUserContentItem({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '' },
      } as ClaudeContentItem)
    ).toBe(true);
  });

  it('excludes unknown content types', () => {
    expect(
      shouldIncludeUserContentItem({ type: 'unknown_type' } as unknown as ClaudeContentItem)
    ).toBe(false);
  });
});

// ============================================================================
// shouldIncludeAssistantContentItem
// ============================================================================

describe('shouldIncludeAssistantContentItem', () => {
  it('includes text', () => {
    expect(
      shouldIncludeAssistantContentItem({ type: 'text', text: 'hello' } as ClaudeContentItem)
    ).toBe(true);
  });

  it('includes tool_use', () => {
    expect(
      shouldIncludeAssistantContentItem({
        type: 'tool_use',
        id: 'tu_1',
        name: 'read_file',
        input: {},
      } as ClaudeContentItem)
    ).toBe(true);
  });

  it('includes thinking', () => {
    expect(
      shouldIncludeAssistantContentItem({
        type: 'thinking',
        thinking: 'let me think...',
      } as ClaudeContentItem)
    ).toBe(true);
  });

  it('excludes tool_result (not an assistant content type)', () => {
    expect(
      shouldIncludeAssistantContentItem({
        type: 'tool_result',
        tool_use_id: 'abc',
        content: '',
      } as ClaudeContentItem)
    ).toBe(false);
  });

  it('excludes image (not an assistant content type)', () => {
    expect(
      shouldIncludeAssistantContentItem({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '' },
      } as ClaudeContentItem)
    ).toBe(false);
  });
});

// ============================================================================
// shouldIncludeUserMessage
// ============================================================================

describe('shouldIncludeUserMessage', () => {
  it('excludes string content', () => {
    const msg: ClaudeMessagePayload = { role: 'user', content: 'Hello' };
    expect(shouldIncludeUserMessage(msg)).toBe(false);
  });

  it('excludes string content even when not system', () => {
    const msg: ClaudeMessagePayload = { role: 'user', content: 'regular user text' };
    expect(shouldIncludeUserMessage(msg)).toBe(false);
  });

  it('includes array content with tool_result', () => {
    const msg: ClaudeMessagePayload = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'output' } as ClaudeContentItem,
      ],
    };
    expect(shouldIncludeUserMessage(msg)).toBe(true);
  });

  it('excludes array content with only text', () => {
    const msg: ClaudeMessagePayload = {
      role: 'user',
      content: [{ type: 'text', text: 'just text' } as ClaudeContentItem],
    };
    expect(shouldIncludeUserMessage(msg)).toBe(false);
  });

  it('includes mixed content with tool_result among text', () => {
    const msg: ClaudeMessagePayload = {
      role: 'user',
      content: [
        { type: 'text', text: 'some text' } as ClaudeContentItem,
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'output' } as ClaudeContentItem,
      ],
    };
    expect(shouldIncludeUserMessage(msg)).toBe(true);
  });

  it('excludes array content with only system instructions', () => {
    const msg: ClaudeMessagePayload = {
      role: 'user',
      content: [{ type: 'text', text: '<system_instruction>...' } as ClaudeContentItem],
    };
    expect(shouldIncludeUserMessage(msg)).toBe(false);
  });

  it('excludes empty array content', () => {
    const msg: ClaudeMessagePayload = { role: 'user', content: [] };
    expect(shouldIncludeUserMessage(msg)).toBe(false);
  });
});

// ============================================================================
// shouldIncludeAssistantMessage
// ============================================================================

describe('shouldIncludeAssistantMessage', () => {
  it('includes string content', () => {
    const msg: ClaudeMessagePayload = { role: 'assistant', content: 'Here is my answer' };
    expect(shouldIncludeAssistantMessage(msg)).toBe(true);
  });

  it('includes empty string content', () => {
    const msg: ClaudeMessagePayload = { role: 'assistant', content: '' };
    expect(shouldIncludeAssistantMessage(msg)).toBe(true);
  });

  it('includes array with text block', () => {
    const msg: ClaudeMessagePayload = {
      role: 'assistant',
      content: [{ type: 'text', text: 'narrative' } as ClaudeContentItem],
    };
    expect(shouldIncludeAssistantMessage(msg)).toBe(true);
  });

  it('includes mixed content with text and tool_use', () => {
    const msg: ClaudeMessagePayload = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read that file' } as ClaudeContentItem,
        { type: 'tool_use', id: 'tu_1', name: 'read', input: {} } as ClaudeContentItem,
      ],
    };
    expect(shouldIncludeAssistantMessage(msg)).toBe(true);
  });

  it('excludes pure tool-use-only content', () => {
    const msg: ClaudeMessagePayload = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: {} } as ClaudeContentItem],
    };
    expect(shouldIncludeAssistantMessage(msg)).toBe(false);
  });

  it('excludes pure thinking-only content', () => {
    const msg: ClaudeMessagePayload = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'hmm...' } as ClaudeContentItem],
    };
    expect(shouldIncludeAssistantMessage(msg)).toBe(false);
  });

  it('excludes empty array content', () => {
    const msg: ClaudeMessagePayload = { role: 'assistant', content: [] };
    expect(shouldIncludeAssistantMessage(msg)).toBe(false);
  });
});

// ============================================================================
// shouldIncludeStreamEvent
// ============================================================================

describe('shouldIncludeStreamEvent', () => {
  it('includes content_block_start for tool_use', () => {
    const event: ClaudeStreamEvent = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'read', input: {} } as ClaudeContentItem,
    };
    expect(shouldIncludeStreamEvent(event)).toBe(true);
  });

  it('includes content_block_start for tool_result', () => {
    const event: ClaudeStreamEvent = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_result', tool_use_id: 'tu_1', content: '' } as ClaudeContentItem,
    };
    expect(shouldIncludeStreamEvent(event)).toBe(true);
  });

  it('includes content_block_start for thinking', () => {
    const event: ClaudeStreamEvent = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' } as ClaudeContentItem,
    };
    expect(shouldIncludeStreamEvent(event)).toBe(true);
  });

  it('excludes content_block_start for text', () => {
    const event: ClaudeStreamEvent = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' } as ClaudeContentItem,
    };
    expect(shouldIncludeStreamEvent(event)).toBe(false);
  });

  it('excludes content_block_delta', () => {
    const event = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    } as ClaudeStreamEvent;
    expect(shouldIncludeStreamEvent(event)).toBe(false);
  });

  it('excludes content_block_stop', () => {
    const event = { type: 'content_block_stop', index: 0 } as ClaudeStreamEvent;
    expect(shouldIncludeStreamEvent(event)).toBe(false);
  });

  it('excludes message_start', () => {
    const event = {
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    } as unknown as ClaudeStreamEvent;
    expect(shouldIncludeStreamEvent(event)).toBe(false);
  });

  it('excludes message_delta', () => {
    const event = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    } as unknown as ClaudeStreamEvent;
    expect(shouldIncludeStreamEvent(event)).toBe(false);
  });

  it('excludes message_stop', () => {
    const event = { type: 'message_stop' } as ClaudeStreamEvent;
    expect(shouldIncludeStreamEvent(event)).toBe(false);
  });
});
