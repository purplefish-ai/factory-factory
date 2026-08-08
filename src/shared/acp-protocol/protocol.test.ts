import { describe, expect, it } from 'vitest';
import { isWebSocketMessage } from '@/lib/chat-protocol';
import {
  AGENT_MESSAGE_TYPES,
  type AgentContentItem,
  type ChatMessage,
  compareTranscriptMessageOrder,
  hasRenderableAssistantContent,
  isImageContent,
  isRenderableAssistantContentItem,
  shouldPersistAgentMessage,
  shouldSuppressDuplicateResultMessage,
  trimTranscriptForRenderer,
} from './protocol';

describe('sub-agent change websocket events', () => {
  it('accepts direct and session-delta-wrapped invalidations', () => {
    const invalidation = {
      type: 'subagents_changed',
      sessionId: 'db-session-1',
      subagentId: 'child-1',
      change: 'completed',
    };

    expect(isWebSocketMessage(invalidation)).toBe(true);
    expect(isWebSocketMessage({ type: 'session_delta', data: invalidation })).toBe(true);
  });

  it.each([
    ['missing sessionId', { type: 'subagents_changed', subagentId: 'child-1', change: 'updated' }],
    [
      'empty sessionId',
      { type: 'subagents_changed', sessionId: '', subagentId: 'child-1', change: 'updated' },
    ],
    [
      'missing subagentId',
      { type: 'subagents_changed', sessionId: 'db-session-1', change: 'updated' },
    ],
    [
      'empty subagentId',
      { type: 'subagents_changed', sessionId: 'db-session-1', subagentId: '', change: 'updated' },
    ],
    [
      'invalid change',
      {
        type: 'subagents_changed',
        sessionId: 'db-session-1',
        subagentId: 'child-1',
        change: 'deleted',
      },
    ],
  ])('rejects direct and session-delta-wrapped invalidations with %s', (_label, invalidation) => {
    expect(isWebSocketMessage(invalidation)).toBe(false);
    expect(isWebSocketMessage({ type: 'session_delta', data: invalidation })).toBe(false);
  });
});

function rendererMessage(id: string, order: number): ChatMessage {
  return {
    id,
    source: 'user',
    text: id,
    timestamp: '2026-02-01T00:00:00.000Z',
    order,
  };
}

describe('renderer transcript window', () => {
  it('returns an already ordered under-limit transcript without cloning', () => {
    const messages = [rendererMessage('m-1', 1), rendererMessage('m-2', 2)];

    expect(trimTranscriptForRenderer(messages)).toBe(messages);
  });

  it('sorts an unordered under-limit transcript without mutating the input', () => {
    const messages = [rendererMessage('m-2', 2), rendererMessage('m-1', 1)];

    const sorted = trimTranscriptForRenderer(messages);

    expect(sorted.map((message) => message.id)).toEqual(['m-1', 'm-2']);
    expect(messages.map((message) => message.id)).toEqual(['m-2', 'm-1']);
  });

  it('treats negative local orders as an equal renderer tail namespace', () => {
    const firstError = rendererMessage('error-1', -1);
    const secondError = rendererMessage('error-2', -1);

    expect(compareTranscriptMessageOrder(firstError, secondError)).toBe(0);
  });

  it('keeps negative lifecycle orders before persisted provider messages', () => {
    const lifecycleMessage: ChatMessage = {
      id: 'session-lifecycle:event-1',
      source: 'agent',
      timestamp: '2026-02-01T00:00:00.000Z',
      order: -0.5,
      message: {
        type: 'session_lifecycle',
        lifecycle: {
          eventId: 'event-1',
          kind: 'SESSION_STOPPED',
          reason: 'SYSTEM_STOP',
          message: 'Session stopped by the system.',
          timestamp: '2026-02-01T00:00:00.000Z',
        },
      },
    };
    const providerMessage = rendererMessage('provider-1', 0);
    const optimisticMessage = rendererMessage('optimistic-1', -1);

    expect(
      trimTranscriptForRenderer([providerMessage, optimisticMessage, lifecycleMessage]).map(
        (message) => message.id
      )
    ).toEqual(['session-lifecycle:event-1', 'provider-1', 'optimistic-1']);
  });
});

describe('agent message types', () => {
  it('accepts session lifecycle messages', () => {
    expect(AGENT_MESSAGE_TYPES).toContain('session_lifecycle');
  });
});

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
      shouldPersistAgentMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' } as AgentContentItem],
        },
      })
    ).toBe(true);
  });

  it('persists assistant message with image-only content', () => {
    expect(
      shouldPersistAgentMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'Zm9v',
              },
            } as AgentContentItem,
          ],
        },
      })
    ).toBe(true);
  });

  it('persists assistant message with string content', () => {
    expect(
      shouldPersistAgentMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'Hello world',
        },
      })
    ).toBe(true);
  });

  it('persists stream tool_use content_block_start without initial input', () => {
    expect(
      shouldPersistAgentMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
          } as AgentContentItem,
        },
      })
    ).toBe(true);
  });
});

describe('image guard', () => {
  it('accepts valid base64 image content', () => {
    expect(
      isImageContent({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'Zm9v',
        },
      } as AgentContentItem)
    ).toBe(true);
  });

  it('rejects image content missing required source fields', () => {
    expect(isImageContent({ type: 'image' } as AgentContentItem)).toBe(false);
    expect(
      isImageContent({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png' },
      } as AgentContentItem)
    ).toBe(false);
    expect(
      isImageContent({
        type: 'image',
        source: { media_type: 'image/png', data: 'Zm9v' },
      } as AgentContentItem)
    ).toBe(false);
  });
});

describe('result dedup', () => {
  const transcript: ChatMessage[] = [
    {
      id: 'm1',
      source: 'agent',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
      },
      timestamp: '2026-02-08T00:00:00.000Z',
      order: 0,
    },
  ];

  it('suppresses duplicate result when payload is structured object', () => {
    expect(
      shouldSuppressDuplicateResultMessage(transcript, {
        type: 'result',
        result: { text: 'final answer' },
      })
    ).toBe(true);
  });

  it('suppresses duplicate result when assistant content is a string', () => {
    expect(
      shouldSuppressDuplicateResultMessage(
        [
          {
            id: 'm2',
            source: 'agent',
            message: {
              type: 'assistant',
              message: { role: 'assistant', content: 'final answer' },
            },
            timestamp: '2026-02-08T00:00:01.000Z',
            order: 1,
          },
        ],
        {
          type: 'result',
          result: { text: 'final answer' },
        }
      )
    ).toBe(true);
  });

  it('keeps result when structured payload has no extractable text', () => {
    expect(
      shouldSuppressDuplicateResultMessage(transcript, {
        type: 'result',
        result: { ok: true },
      })
    ).toBe(false);
  });

  it('treats a previous result message as a turn boundary', () => {
    const multiTurnTranscript: ChatMessage[] = [
      {
        id: 'm1',
        source: 'agent',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'answer 1' }] },
        },
        timestamp: '2026-02-08T00:00:00.000Z',
        order: 0,
      },
      {
        id: 'm2',
        source: 'agent',
        message: { type: 'result', result: { text: 'answer 1' } },
        timestamp: '2026-02-08T00:00:01.000Z',
        order: 1,
      },
      {
        id: 'm3',
        source: 'agent',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] },
        },
        timestamp: '2026-02-08T00:00:02.000Z',
        order: 2,
      },
    ];

    // Result matching current turn's assistant text should be suppressed
    expect(
      shouldSuppressDuplicateResultMessage(multiTurnTranscript, {
        type: 'result',
        result: { text: 'answer 2' },
      })
    ).toBe(true);

    // Result matching a previous turn's text should NOT be suppressed
    // because the earlier result message acts as a turn boundary
    expect(
      shouldSuppressDuplicateResultMessage(multiTurnTranscript, {
        type: 'result',
        result: { text: 'answer 1' },
      })
    ).toBe(false);
  });
});
