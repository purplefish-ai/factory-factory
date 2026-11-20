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

describe('ACP tool results across sparse updates', () => {
  const textContent = (text: string) => [
    { type: 'content' as const, content: { type: 'text' as const, text } },
  ];

  function complete(translator: AcpEventTranslator, toolCallId: string, sessionId = '') {
    return toolResultContent(
      translator.translateSessionUpdate(
        { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
        sessionId
      )
    );
  }

  it('uses the latest content on a status-only completion and forgets the completed call', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    const toolCallId = 'read';
    translator.translateSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Read',
      content: textContent('initial'),
    });
    translator.translateSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      content: textContent('latest'),
    });
    translator.translateSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      content: null,
    });
    expect(complete(translator, toolCallId)).toBe('latest');
    expect(complete(translator, toolCallId)).toBe('');
  });

  it('keeps raw output across null patches and clears replaced content before deriving a failed result', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    const toolCallId = 'read';
    translator.translateSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Read',
      content: textContent('initial'),
      rawOutput: 'initial raw',
    });
    translator.translateSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      rawOutput: { message: 'failed' },
    });
    expect(
      translator
        .translateSessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          content: [],
          rawOutput: null,
          status: 'failed',
        })
        .at(-1)
    ).toMatchObject({
      data: { message: { content: [{ content: '{"message":"failed"}', is_error: true }] } },
    });
    expect(complete(translator, toolCallId)).toBe('');
  });

  it('isolates parallel tools and sessions and drops earlier output on teardown or a fresh start', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    for (const [sessionId, toolCallId, rawOutput] of [
      ['a', 'one', 'first'],
      ['b', 'one', 'second'],
      ['b', 'two', 'third'],
      ['b', 'three', 'old'],
    ] as const) {
      translator.translateSessionUpdate(
        {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Read',
          rawOutput,
        },
        sessionId
      );
    }
    translator.clearTerminalOutput('a');
    translator.translateSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'three',
        title: 'New tool',
      },
      'b'
    );
    expect(complete(translator, 'one', 'a')).toBe('');
    expect(complete(translator, 'two', 'b')).toBe('third');
    expect(complete(translator, 'one', 'b')).toBe('second');
    expect(complete(translator, 'three', 'b')).toBe('');
  });

  it('bounds abandoned tool snapshots, including updates without a start frame', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    for (let id = 0; id <= 1024; id++) {
      translator.translateSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: String(id),
        content: textContent(String(id)),
      });
    }
    expect(complete(translator, '0')).toBe('');
    expect(complete(translator, '1024')).toBe('1024');
  });

  it('evicts older output when multiple snapshots exceed the shared character budget', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    const large = 'x'.repeat(6 * 1024 * 1024);
    for (const toolCallId of ['oldest', 'middle', 'newest']) {
      translator.translateSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        rawOutput: large,
      });
    }
    expect(String(complete(translator, 'oldest')).length).toBe(0);
    expect(String(complete(translator, 'middle')).length).toBe(large.length);
    expect(String(complete(translator, 'newest')).length).toBe(large.length);
  });

  it('drops oversized pending replacements without limiting an output supplied on completion', () => {
    const translator = new AcpEventTranslator({ warn: vi.fn() });
    const large = 'x'.repeat(17 * 1024 * 1024);
    for (const key of ['content', 'rawOutput'] as const) {
      const update = { sessionUpdate: 'tool_call_update', toolCallId: key } as const;
      translator.translateSessionUpdate({
        ...update,
        [key]: key === 'content' ? textContent('old') : 'old',
      });
      translator.translateSessionUpdate({
        ...update,
        [key]: key === 'content' ? textContent(large) : large,
      });
      expect(String(complete(translator, key)).length).toBe(0);
      const direct = translator.translateSessionUpdate({
        ...update,
        status: 'completed',
        [key]: key === 'content' ? textContent(large) : large,
      });
      expect(String(toolResultContent(direct)).length).toBe(large.length);
    }
  });
});
