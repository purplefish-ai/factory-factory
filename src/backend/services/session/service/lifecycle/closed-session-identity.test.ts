import { expect, it } from 'vitest';
import type { AgentContentItem, ChatMessage } from '@/shared/acp-protocol';
import { getClosedSessionArchiveKey } from './closed-session-identity';

const scope = {
  sessionId: 'session',
  workspaceId: 'workspace',
  provider: 'CLAUDE' as const,
  providerSessionId: 'conversation',
  codexAccountId: null,
  startedAt: new Date(0),
};
const message = (text: string): ChatMessage => ({
  id: 'live-1',
  timestamp: '2026-01-01',
  order: 5,
  source: 'agent',
  message: {
    type: 'assistant',
    timestamp: '2026-01-01',
    session_id: 'conversation',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  },
});
const key = (messages: ChatMessage[]) => getClosedSessionArchiveKey({ ...scope, messages });

it('uses explicit dispatch provenance without collapsing independent adjacent user prompts', () => {
  const user = (text: string): ChatMessage => ({
    id: text,
    source: 'user',
    text,
    timestamp: '2026-01-01',
    order: 0,
  });
  const first = user('first');
  const second = user('second');
  const native = user('first\n\nsecond');
  const batch = [
    { ...first, providerPrompt: 'first\n\nsecond' },
    { ...second, providerPrompt: null },
  ];
  expect(key(batch)).toBe(key([native]));
  expect(key([first, second])).not.toBe(key(batch));
  expect(key([second, first])).not.toBe(key([first, second]));
  expect(key([first, message('answer'), second])).not.toBe(key(batch));
  expect(key(batch)).not.toBe(key([...batch, user('later')]));
  expect(key([{ ...first, providerPrompt: 'second\n\nfirst' }, batch[1]!])).not.toBe(key(batch));
  const image: AgentContentItem = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AQ==' },
  };
  const a: AgentContentItem = { type: 'text', text: 'first' };
  const b: AgentContentItem = { type: 'text', text: '\n\nsecond' };
  expect(key([{ ...first, providerPrompt: [a, image, b] }])).not.toBe(
    key([{ ...first, providerPrompt: [a, b, image] }])
  );
});

it('ignores presentation IDs, clocks, orders, icon indexes and runtime envelopes', () => {
  const live = message('answer');
  const status: ChatMessage = {
    ...live,
    id: 'runtime-status',
    message: { type: 'system', status: 'running', model: 'live-model' },
  };
  const usage: ChatMessage = {
    ...live,
    id: 'runtime-usage',
    message: { type: 'result', usage: { input_tokens: 17, output_tokens: 5 } },
  };
  expect(key([status, live, usage])).toBe(key([live]));
  expect(key([live])).toBe(
    key([
      {
        ...live,
        id: 'history-rebuilt-99',
        timestamp: '2026-02-02',
        order: 0,
        subagentIconIndex: 3,
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        },
      },
    ])
  );
});

it('preserves content across live multi-block versus split history projections', () => {
  const combined = message('one');
  combined.message = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    },
  };
  expect(key([combined])).toBe(key([message('one'), message('two')]));
  expect(key([message('one')])).not.toBe(key([message('one'), message('one')]));
});

it.each([
  { codexAccountId: 'other' },
  { providerSessionId: 'other' },
  { conversationEpoch: 1 },
  { provider: 'CODEX' as const },
  { startedAt: new Date(1) },
])('retains stable scope distinction %j', (change) => {
  expect(
    getClosedSessionArchiveKey({ ...scope, messages: [message('answer')], ...change })
  ).not.toBe(key([message('answer')]));
});

it('canonicalizes tool input key order while preserving real tool IDs and inputs', () => {
  const tool = (input: Record<string, unknown>, id = 'tool-call'): ChatMessage => ({
    ...message(''),
    message: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 8,
        content_block: { type: 'tool_use', id, name: 'tool', input },
      },
    },
  });
  expect(key([tool({ x: 1, y: 2 })])).toBe(key([tool({ y: 2, x: 1 })]));
  expect(key([tool({ x: 1 })])).not.toBe(key([tool({ x: 2 })]));
  expect(key([tool({ x: 1 })])).not.toBe(key([tool({ x: 1 }, 'new-call')]));
});

it('uses image bytes rather than regenerated attachment display metadata', () => {
  const user: ChatMessage = {
    id: 'upload',
    source: 'user',
    text: 'image',
    timestamp: '2026-01-01',
    order: 0,
    attachments: [
      {
        id: 'upload-1',
        name: 'upload.png',
        type: 'image/png',
        contentType: 'image',
        size: 1,
        data: 'AQ==',
      },
    ],
  };
  expect(key([user])).toBe(
    key([
      {
        ...user,
        attachments: [
          { ...user.attachments![0]!, id: 'history-image-clock-9', name: 'image-1.png', size: 2 },
        ],
      },
    ])
  );
  expect(key([user])).not.toBe(
    key([{ ...user, attachments: [{ ...user.attachments![0]!, data: 'Ag==' }] }])
  );
});

it('keeps durable local event identity independent of its reconstructed timeline placement', () => {
  const local: ChatMessage = {
    ...message(''),
    message: {
      type: 'session_lifecycle',
      lifecycle: {
        eventId: 'durable-stop',
        kind: 'SESSION_STOPPED',
        reason: 'USER_STOP',
        message: 'Stopped',
        timestamp: '2026-01-01',
      },
    },
  };
  expect(key([message('one'), local, message('two')])).toBe(
    key([local, message('one'), message('two')])
  );
  expect(key([message('one'), local])).not.toBe(
    key([
      message('one'),
      {
        ...local,
        message: {
          type: 'session_lifecycle',
          lifecycle: { ...local.message!.lifecycle!, eventId: 'later-stop' },
        },
      },
    ])
  );
});

it('normalizes the successful tool-result default without conflating real errors', () => {
  const result = (isError?: boolean): ChatMessage => ({
    ...message(''),
    message: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call',
            content: 'saved output',
            ...(isError !== undefined ? { is_error: isError } : {}),
          },
        ],
      },
    },
  });
  expect(key([result()])).toBe(key([result(false)]));
  expect(key([result()])).not.toBe(key([result(true)]));
});
