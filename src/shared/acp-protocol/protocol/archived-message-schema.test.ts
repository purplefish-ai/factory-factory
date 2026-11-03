import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';
import { ArchivedAgentMessageSchema, ArchivedChatMessageSchema } from './archived-message-schema';
import type { AgentContentItem, AgentStreamEvent, ContentBlockDelta } from './content';
import { AGENT_MESSAGE_TYPES, type AgentMessage, type ChatMessage } from './messages';

// Include optional keys and each discriminated branch: assignability alone permits stripping.
// Opaque JSON fields have an intentionally narrower serialized boundary in this codec.
type FieldPaths<T> = T extends readonly (infer Item)[]
  ? FieldPaths<Item>
  : T extends { type: infer Tag extends string }
    ? `${Tag}:${ObjectFieldPaths<T>}`
    : ObjectFieldPaths<T>;
type ObjectFieldPaths<T> = T extends object
  ? string extends keyof T
    ? `[key].${FieldPaths<T[string & keyof T]>}`
    : {
        [Key in keyof T & string]-?:
          | Key
          | (Key extends 'input' | 'input_schema' | 'result'
              ? never
              : `${Key}.${FieldPaths<NonNullable<T[Key]>>}`);
      }[keyof T & string]
  : never;

const image = {
  type: 'image',
  source: { type: 'base64', media_type: '', data: '' },
} satisfies AgentContentItem;
const contents = [
  { type: 'text', text: '' },
  { type: 'thinking', thinking: 'reasoning' },
  { type: 'tool_use', id: '', name: '', input: { nested: [null, { enabled: true }] } },
  { type: 'tool_result', tool_use_id: '', content: 'result', is_error: false },
  { type: 'tool_result', tool_use_id: '', content: [{ type: 'text', text: '' }, image] },
  image,
] satisfies AgentContentItem[];
const deltas = [
  { type: 'text_delta', text: '' },
  { type: 'thinking_delta', thinking: '' },
  { type: 'input_json_delta', partial_json: '{' },
] satisfies ContentBlockDelta[];
const usage = {
  input_tokens: -1,
  output_tokens: 0.5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3,
  service_tier: '',
};
const streamEvents = [
  {
    type: 'message_start',
    message: {
      id: '',
      type: 'provider-payload',
      role: 'user',
      model: '',
      content: contents,
      stop_reason: '',
    },
  },
  ...contents.map((content_block): AgentStreamEvent => ({
    type: 'content_block_start',
    index: -0.5,
    content_block,
  })),
  ...deltas.map((delta): AgentStreamEvent => ({ type: 'content_block_delta', index: -1, delta })),
  { type: 'content_block_stop', index: 0.5 },
  { type: 'message_delta', delta: { stop_reason: '', stop_sequence: '' }, usage },
  { type: 'message_stop' },
] satisfies AgentStreamEvent[];
const richCommon = {
  prDeliveryState: 'delivered',
  timestamp: '',
  childWorkspaceId: '',
  childWorkspaceName: 'Child',
  childProjectName: 'Project',
  parentWorkspaceId: '',
  parentWorkspaceName: 'Parent',
  parentProjectName: 'Project',
  text: '',
  session_id: '',
  parent_tool_use_id: 'subagent-tool',
  message: { role: 'assistant', content: contents },
  event: streamEvents[0],
  usage,
  duration_ms: -1,
  duration_api_ms: 0.5,
  total_cost_usd: -0.5,
  num_turns: 0.5,
  is_error: false,
  error: '',
  result: { nested: [null, false, 3, 'result'] },
  model_usage: {
    model: {
      inputTokens: -1,
      outputTokens: 0.5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: -1,
      costUSD: 0.5,
      contextWindow: 0,
      maxOutputTokens: 0,
    },
  },
  subtype: '',
  tools: [{ name: '', description: '', input_schema: { properties: { value: [null, 1] } } }],
  model: '',
  cwd: '',
  apiKeySource: '',
  status: '',
} satisfies Omit<AgentMessage, 'type' | 'lifecycle'>;
const row = {
  id: '',
  source: 'user',
  timestamp: 'not-an-ISO-date',
  order: -0.5,
  text: '',
  subagentId: '',
  subagentIconIndex: -1,
  attachments: [
    { id: '', name: '', type: '', size: -0.5, data: '', contentType: 'image' },
    { id: '', name: '', type: '', size: 0, data: '', contentType: 'text' },
  ],
  message: { ...richCommon, type: 'assistant' },
} satisfies ChatMessage;

describe('archived current-message codec (passive)', () => {
  it('produces current protocol values without assertions and covers declared field paths', () => {
    const parsedChat: ChatMessage = ArchivedChatMessageSchema.parse(row);
    const parsedAgent: AgentMessage = ArchivedAgentMessageSchema.parse(row.message);
    expect(parsedChat).toStrictEqual(row);
    expect(parsedAgent).toStrictEqual(row.message);
    expectTypeOf<FieldPaths<z.output<typeof ArchivedChatMessageSchema>>>().toEqualTypeOf<
      FieldPaths<ChatMessage>
    >();
    expectTypeOf<FieldPaths<z.output<typeof ArchivedAgentMessageSchema>>>().toEqualTypeOf<
      FieldPaths<AgentMessage>
    >();
    expectTypeOf<(typeof contents)[number]['type']>().toEqualTypeOf<AgentContentItem['type']>();
    expectTypeOf<(typeof streamEvents)[number]['type']>().toEqualTypeOf<AgentStreamEvent['type']>();
    expectTypeOf<(typeof deltas)[number]['type']>().toEqualTypeOf<ContentBlockDelta['type']>();
  });

  it.each(AGENT_MESSAGE_TYPES)('preserves all common rich fields on %s', (type) => {
    const message =
      type === 'session_lifecycle'
        ? {
            ...richCommon,
            type,
            lifecycle: {
              eventId: '',
              kind: 'SESSION_STOPPED',
              reason: 'USER_STOP',
              message: '',
              timestamp: '',
            },
          }
        : { ...richCommon, type };
    const input = { ...row, message };
    expect(ArchivedChatMessageSchema.parse(JSON.parse(JSON.stringify(input)))).toStrictEqual(input);
  });

  it.each(streamEvents)('preserves complete stream event $type', (event) => {
    const input = { ...row, message: { ...row.message, event } };
    expect(ArchivedChatMessageSchema.parse(input)).toStrictEqual(input);
  });

  it.each(Object.values(SessionLifecycleEventKind))('accepts lifecycle kind %s', (kind) => {
    for (const reason of Object.values(SessionLifecycleEventReason)) {
      const input = {
        type: 'session_lifecycle',
        lifecycle: { eventId: '', kind, reason, message: '', timestamp: '' },
      };
      expect(ArchivedAgentMessageSchema.parse(input)).toStrictEqual(input);
    }
  });

  it('accepts minimal rows, both roles, content strings and empty nested collections', () => {
    for (const source of ['agent', 'user']) {
      const input = { id: '', source, timestamp: '', order: -1 };
      expect(ArchivedChatMessageSchema.parse(input)).toStrictEqual(input);
    }
    for (const role of ['user', 'assistant']) {
      for (const content of ['', []]) {
        const input = {
          type: 'system',
          message: { role, content },
          event: { type: 'message_start', message: { role, content } },
          usage: {},
          model_usage: {},
          tools: [{ name: '' }],
          result: null,
        };
        expect(ArchivedAgentMessageSchema.parse(input)).toStrictEqual(input);
      }
    }
    for (const event of [{ type: 'message_delta' }, { type: 'message_delta', delta: {} }]) {
      expect(ArchivedAgentMessageSchema.parse({ type: 'stream_event', event })).toStrictEqual({
        type: 'stream_event',
        event,
      });
    }
  });

  it('preserves optional undefined versus missing properties where representable', () => {
    const input = {
      ...row,
      text: undefined,
      attachments: undefined,
      message: {
        type: 'assistant',
        result: undefined,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_result', tool_use_id: '', content: [], is_error: undefined }],
        },
      },
    };
    expect(ArchivedChatMessageSchema.parse(input)).toStrictEqual(input);
    expect(
      ArchivedChatMessageSchema.parse({ id: '', source: 'agent', timestamp: '', order: 0 })
    ).toStrictEqual({ id: '', source: 'agent', timestamp: '', order: 0 });
  });

  it('preserves every JSON record key, including nested own __proto__ properties', () => {
    const record: unknown = JSON.parse(
      '{"__proto__":{"kept":true},"nested":{"__proto__":[1,null]},"constructor":false}'
    );
    const input = {
      type: 'result',
      result: record,
      tools: [{ name: '', input_schema: record }],
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '', name: '', input: record }],
      },
    };
    const parsed = ArchivedAgentMessageSchema.parse(input);
    expect(parsed).toStrictEqual(input);
    expect(Object.getPrototypeOf(parsed.result)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.tools?.[0]?.input_schema)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'kept')).toBeUndefined();
    expect(
      ArchivedAgentMessageSchema.safeParse({
        type: 'result',
        result: Object.fromEntries([['__proto__', () => null]]),
      }).success
    ).toBe(false);
  });

  it('preserves reserved model names while validating their complete usage payload', () => {
    const model_usage = Object.fromEntries([['__proto__', richCommon.model_usage.model]]);
    const input = { type: 'result', model_usage };
    const parsed = ArchivedAgentMessageSchema.parse(input);
    expect(parsed).toStrictEqual(input);
    expect(Object.getPrototypeOf(parsed.model_usage)).toBe(Object.prototype);
    expect(
      ArchivedAgentMessageSchema.safeParse({
        type: 'result',
        model_usage: Object.fromEntries([['__proto__', {}]]),
      }).success
    ).toBe(false);
  });

  it.each(['queued', 'delivered', 'failed', 'cancelled'])(
    'preserves PR delivery state %s',
    (prDeliveryState) => {
      const input = { type: 'pr_update', prDeliveryState };
      expect(ArchivedAgentMessageSchema.parse(input)).toStrictEqual(input);
    }
  );

  it.each([
    { type: 'future-agent-type' },
    { type: 'assistant', lifecycle: {} },
    { type: 'session_lifecycle' },
    {
      type: 'session_lifecycle',
      lifecycle: { eventId: '', kind: 'future', reason: 'USER_STOP', message: '', timestamp: '' },
    },
    {
      type: 'session_lifecycle',
      lifecycle: {
        eventId: '',
        kind: 'SESSION_STOPPED',
        reason: 'future',
        message: '',
        timestamp: '',
      },
    },
    { type: 'assistant', message: { role: 'tool', content: '' } },
    ...[
      { type: 'future-content', text: '' },
      { type: 'text', text: 1 },
      { type: 'thinking', thinking: false },
      { type: 'image', source: { type: 'url', data: '', media_type: '' } },
      { type: 'image', source: { type: 'base64', data: 1, media_type: '' } },
      { type: 'tool_use', id: '', name: '', input: [] },
      { type: 'tool_use', id: '', name: 1, input: {} },
      { type: 'tool_result', tool_use_id: 1, content: '' },
      { type: 'tool_result', tool_use_id: '', content: [{ type: 'text', text: 1 }] },
      {
        type: 'tool_result',
        tool_use_id: '',
        content: [{ type: 'image', source: { type: 'base64', data: '', media_type: false } }],
      },
      { type: 'tool_result', tool_use_id: '', content: [], is_error: '' },
    ].map((content) => ({ type: 'assistant', message: { role: 'assistant', content: [content] } })),
    ...[
      { type: 'future-stream' },
      { type: 'message_start', message: { role: 'assistant', content: [], stop_reason: false } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: false } },
      { type: 'content_block_stop', index: '0' },
      { type: 'message_delta', delta: { stop_sequence: 1 } },
      { type: 'message_delta', usage: { service_tier: false } },
      ...[
        { type: 'future-delta' },
        { type: 'text_delta', text: false },
        { type: 'thinking_delta', thinking: 1 },
        { type: 'input_json_delta', partial_json: {} },
      ].map((delta) => ({ type: 'content_block_delta', index: 0, delta })),
    ].map((event) => ({ type: 'stream_event', event })),
    { type: 'result', usage: { cache_read_input_tokens: '0' } },
    {
      type: 'result',
      model_usage: { model: { ...richCommon.model_usage.model, contextWindow: '1' } },
    },
    { type: 'system', tools: [{ name: '', input_schema: [] }] },
    { type: 'pr_update', prDeliveryState: 'future' },
  ])('rejects invalid nested current agent data %#', (input) => {
    expect(ArchivedAgentMessageSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { ...row, source: 'future' },
    { ...row, subagentIconIndex: '' },
    { ...row, order: '0' },
    { ...row, attachments: [{ ...row.attachments[0], size: '0' }] },
    { ...row, attachments: [{ ...row.attachments[0], contentType: 'future' }] },
    { ...row, message: { type: 'future' } },
  ])('rejects malformed current chat row %#', (input) => {
    expect(ArchivedChatMessageSchema.safeParse(input).success).toBe(false);
  });

  it.each([undefined, () => null, new Error('not JSON'), 1n])(
    'rejects non-JSON values in opaque tool records %#',
    (value) => {
      for (const message of [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: '', name: '', input: { value } }],
          },
        },
        { type: 'system', tools: [{ name: '', input_schema: { value } }] },
        { type: 'result', result: { value } },
      ]) {
        expect(ArchivedAgentMessageSchema.safeParse(message).success).toBe(false);
      }
    }
  );
});
