import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/shared/acp-protocol';
import { closedSessionTranscriptSchema } from './closed-session-transcript.schema';

const timestamp = '2026-01-01T00:00:00.000Z';
function transcript(message: unknown) {
  return {
    version: 1,
    sessionId: 'session',
    workspaceId: 'workspace',
    metadata: {
      name: null,
      workflow: 'ratchet',
      provider: 'CLAUDE',
      model: 'sonnet',
      startedAt: timestamp,
      completedAt: timestamp,
    },
    messages: [{ id: 'message', source: 'agent', timestamp, order: 1, message }],
  };
}

describe('closed-session transcript nested boundary', () => {
  // Archive persistence shipped at 520a5a8a8 after the ACP cutover. These are
  // the six top-level message variants from that producer's protocol, not raw SDK frames.
  it.each([
    { type: 'system', subtype: 'init', tools: [{ name: 'Read' }] },
    { type: 'assistant', message: { role: 'assistant', content: 'historical answer' } },
    { type: 'user', message: { role: 'user', content: 'historical prompt' } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', result: { historical: true }, usage: { output_tokens: 1 } },
    { type: 'error', error: 'historical failure' },
  ])('retains the original archive producer variant %j without newer metadata', (message) => {
    const original = transcript(message);
    expect(closedSessionTranscriptSchema.parse(original)).toEqual(original);
  });

  it.each([
    { type: 'assistant' },
    { type: 'assistant', message: { role: 'system', content: 'injected' } },
    { type: 'assistant', message: { role: 'assistant', content: {} } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 9 }] } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call', name: 'Read', input: [] }],
      },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', input: {} }] },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call',
            content: [
              { type: 'image', source: { type: 'base64', data: 42, media_type: 'image/png' } },
            ],
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: {} }] },
        ],
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: {} },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { role: 'hacker', content: [] } },
    },
    { type: 'session_lifecycle' },
    { type: 'unknown_new_authority' },
    undefined,
  ])('rejects invalid known/nested message payload %j', (message) => {
    expect(closedSessionTranscriptSchema.safeParse(transcript(message)).success).toBe(false);
  });

  it('retains rich native content, local provenance/settings metadata and attachments through JSON codec', () => {
    const image = {
      type: 'image',
      source: { type: 'base64', data: 'aW1hZ2U=', media_type: 'image/png' },
    };
    const content = [
      { type: 'text', text: 'Saved answer' },
      { type: 'thinking', thinking: 'Saved reasoning', signature: 'provider-signature' },
      image,
      {
        type: 'tool_use',
        id: 'call',
        name: 'Read',
        input: { path: '/repo/file', nested: { flags: [true, null] } },
      },
    ];
    const source = transcript({
      type: 'assistant',
      session_id: 'native-session',
      parent_tool_use_id: 'parent',
      message: { role: 'assistant', content, providerMetadata: { origin: 'native' } },
      usage: { input_tokens: 4, output_tokens: 6 },
      providerEvidence: { receipt: 'historical-only' },
    });
    source.messages.push({
      id: 'result',
      source: 'agent',
      timestamp,
      order: 2,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call',
              is_error: false,
              content: [{ type: 'text', text: 'Saved result' }, image],
            },
          ],
        },
      },
    });
    const rich = {
      ...source,
      messages: [
        ...source.messages,
        {
          id: 'user',
          source: 'user',
          timestamp,
          order: 3,
          text: 'Read this image',
          attachments: [
            {
              id: 'image',
              name: 'image.png',
              type: 'image/png',
              size: 5,
              data: 'aW1hZ2U=',
              contentType: 'image',
            },
          ],
          settings: {
            selectedModel: 'sonnet',
            reasoningEffort: null,
            thinkingEnabled: false,
            planModeEnabled: true,
          },
          provenance: { provider: 'CLAUDE', receipt: 'historical' },
        },
      ],
    };
    const decoded: unknown = JSON.parse(JSON.stringify(rich));
    const parsed = closedSessionTranscriptSchema.parse(decoded);
    const messages: ChatMessage[] = parsed.messages;
    expect(messages).toEqual(rich.messages);
  });

  it('validates attachments/settings while preserving partial historical settings metadata', () => {
    const source = transcript({ type: 'result', result: { stopReason: 'end_turn' } });
    const invalidAttachment = {
      ...source,
      messages: [
        {
          ...source.messages[0],
          attachments: [
            { id: 'a', name: 'a.png', type: 'image/png', size: 'large', data: 'base64' },
          ],
        },
      ],
    };
    expect(closedSessionTranscriptSchema.safeParse(invalidAttachment).success).toBe(false);
    const invalidSettings = {
      ...source,
      messages: [{ ...source.messages[0], settings: { selectedModel: 42 } }],
    };
    expect(closedSessionTranscriptSchema.safeParse(invalidSettings).success).toBe(false);
    const partialSettings = {
      ...source,
      messages: [
        {
          ...source.messages[0],
          settings: { selectedModel: 'old-model', historicalProviderFlag: true },
        },
      ],
    };
    expect(closedSessionTranscriptSchema.parse(partialSettings).messages[0]).toMatchObject({
      settings: { selectedModel: 'old-model', historicalProviderFlag: true },
    });
  });

  it('accepts legacy string messages and stream-compatible tool blocks without initial input', () => {
    const legacy = transcript({
      type: 'assistant',
      message: { role: 'assistant', content: 'Legacy saved text' },
    });
    expect(closedSessionTranscriptSchema.parse(legacy).messages[0]?.message?.message?.content).toBe(
      'Legacy saved text'
    );
    const streamed = transcript({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call', name: 'Read' },
      },
    });
    expect(closedSessionTranscriptSchema.parse(streamed).messages[0]?.message?.event).toMatchObject(
      { content_block: { input: {} } }
    );
  });
});

it.each([
  42,
  { text: 'not a prompt array' },
  [{ type: 'text' }],
  [{ type: 'image', source: { type: 'base64', data: 9 } }],
])('rejects malformed dispatched provider prompt provenance: %j', (providerPrompt) => {
  const data = transcript({ type: 'result', result: 'done' });
  expect(
    closedSessionTranscriptSchema.safeParse({
      ...data,
      messages: [
        {
          id: 'user',
          source: 'user',
          timestamp,
          order: 0,
          text: 'visible request',
          providerPrompt,
        },
      ],
    }).success
  ).toBe(false);
});
it('preserves first-row frozen provider prompt and covered-row null independently of visible text', () => {
  const data = transcript({ type: 'result', result: 'done' });
  const providerPrompt = [
    { type: 'text', text: 'exact combined provider bytes' },
    { type: 'image', source: { type: 'base64', data: 'eA==', media_type: 'image/png' } },
  ];
  const messages = [
    { id: 'first', source: 'user', timestamp, order: 0, text: 'first', providerPrompt },
    { id: 'second', source: 'user', timestamp, order: 1, text: 'second', providerPrompt: null },
  ];
  expect(closedSessionTranscriptSchema.parse({ ...data, messages }).messages).toEqual(messages);
});
