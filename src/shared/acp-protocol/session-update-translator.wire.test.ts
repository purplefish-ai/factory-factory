import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { expect, it } from 'vitest';
import { parseChatServerMessage } from './protocol/chat-server-message-schema';
import { AcpEventTranslator } from './session-update-translator';

type TranslatorSessionUpdate = Parameters<AcpEventTranslator['translateSessionUpdate']>[0];

/** Provider updates the chat client receives live, in the shapes adapters send. */
const updates: TranslatorSessionUpdate[] = [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } },
  {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read file',
    kind: 'read',
    status: 'pending',
    rawInput: { path: '/repo/a.ts' },
    locations: [{ path: '/repo/a.ts', line: 3 }],
  },
  { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    title: 'Read file',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
  },
  {
    sessionUpdate: 'plan',
    entries: [{ content: 'Fix tests', status: 'in_progress', priority: 'high' }],
  },
  {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: 'path' } }],
  },
  {
    sessionUpdate: 'usage_update',
    size: 200_000,
    used: 15_000,
    cost: { amount: 0.05, currency: 'USD' },
  },
  { sessionUpdate: 'context_compaction', state: 'started' },
];

const configOptionUpdate = {
  sessionUpdate: 'config_option_update',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      description: null,
      category: 'model',
      type: 'select',
      currentValue: 'opus',
      options: [{ value: 'opus', name: 'Opus', description: null }],
    },
    { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: false },
  ],
} as unknown as SessionUpdate;

it('translates provider updates into frames the chat client accepts', () => {
  const translator = new AcpEventTranslator({ warn: () => undefined });
  const deltas = [...updates, configOptionUpdate].flatMap((update) =>
    translator.translateSessionUpdate(update)
  );

  expect(new Set(deltas.map((delta) => delta.type))).toEqual(
    new Set([
      'agent_message',
      'tool_progress',
      'task_notification',
      'slash_commands',
      'compacting_start',
      'config_options_update',
    ])
  );
  for (const [order, delta] of deltas.entries()) {
    // The event processor assigns a transcript order before publishing agent messages.
    const frame = { type: 'session_delta', data: { ...delta, order } };
    const parsed = parseChatServerMessage(JSON.parse(JSON.stringify(frame)));
    expect(parsed.success ? parsed.dropped : parsed.error.issues).toEqual([]);
  }
});
