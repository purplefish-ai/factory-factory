import { describe, expect, it, vi } from 'vitest';
import { AcpEventTranslator } from './session-update-translator';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function toolResultContent(events: unknown[]): unknown {
  const last = events.at(-1) as {
    data?: { message?: { content?: Array<{ type?: string; content?: unknown }> } };
  };
  const block = last.data?.message?.content?.[0];
  expect(block?.type).toBe('tool_result');
  return block?.content;
}

describe('ACP tool results with image content', () => {
  // claude-agent-acp maps a Read of an image file, and MCP screenshot tools such as
  // Playwright's browser_take_screenshot, to nested ACP image content blocks.
  it('keeps screenshot images structured instead of serializing base64 into result text', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    translator.translateSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'shot-1',
        title: 'mcp__playwright__browser_take_screenshot',
        kind: 'other',
        status: 'in_progress',
        rawInput: {},
      },
      'session-1'
    );

    const events = translator.translateSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'shot-1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'Took the viewport screenshot' } },
          { type: 'content', content: { type: 'image', data: PNG_BASE64, mimeType: 'image/png' } },
        ],
      },
      'session-1'
    );

    const content = toolResultContent(events);
    expect(JSON.stringify(content)).not.toContain('"mimeType"');
    expect(content).toEqual([
      { type: 'text', text: 'Took the viewport screenshot' },
      { type: 'image', source: { type: 'base64', data: PNG_BASE64, media_type: 'image/png' } },
    ]);
  });

  it('returns an image-only Read result as an image item', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    const events = translator.translateSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read screenshot.png',
        kind: 'read',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'image', data: PNG_BASE64, mimeType: 'image/png' } },
        ],
      },
      'session-1'
    );

    expect(toolResultContent(events)).toEqual([
      { type: 'image', source: { type: 'base64', data: PNG_BASE64, media_type: 'image/png' } },
    ]);
  });

  it('keeps plain text results as strings', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    const events = translator.translateSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-2',
        title: 'Read notes.md',
        kind: 'read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '1\thello' } }],
      },
      'session-1'
    );

    expect(toolResultContent(events)).toBe('1\thello');
  });
});
