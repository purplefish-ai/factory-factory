import { describe, expect, it } from 'vitest';
import { groupAdjacentToolCalls, isToolSequence } from '@/lib/chat-protocol';
import type { SubagentTranscriptUpdate } from '@/shared/acp-protocol/subagents';
import { projectAcpTranscriptUpdates } from './project-acp-transcript';

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function createTranscript(): SubagentTranscriptUpdate[] {
  return [
    {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Inspect the failing tests' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'I will inspect them.' },
    },
    {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking the focused failure first.' },
    },
    {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: ' Then I will inspect the reducer path.' },
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'command-1',
      title: 'Terminal',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'pnpm test' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'command-1',
      title: 'Terminal',
      kind: 'execute',
      status: 'completed',
      rawOutput: 'All focused tests passed',
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The focused tests pass.' },
    },
  ];
}

describe('projectAcpTranscriptUpdates', () => {
  it('projects transcript updates through the chat model in stable order', () => {
    const updates = createTranscript();

    const messages = projectAcpTranscriptUpdates(updates);

    expect(messages.map((message) => message.source)).toEqual([
      'user',
      'agent',
      'agent',
      'agent',
      'agent',
      'agent',
    ]);
    expect(messages.map((message) => message.order)).toEqual([0, 1, 2, 4, 7, 8]);
    expect(messages.map((message) => message.id)).toEqual([
      'subagent-message-0-0',
      'subagent-message-1-1',
      'subagent-message-2-2',
      'subagent-message-4-3',
      'subagent-message-7-4',
      'subagent-message-8-5',
    ]);
    expect(messages.every((message) => message.timestamp === FALLBACK_TIMESTAMP)).toBe(true);
    expect(messages[0]).toEqual({
      id: 'subagent-message-0-0',
      source: 'user',
      text: 'Inspect the failing tests',
      timestamp: FALLBACK_TIMESTAMP,
      order: 0,
    });

    const reasoningMessages = messages.filter(
      (message) =>
        message.message?.type === 'stream_event' &&
        message.message.event?.type === 'content_block_start' &&
        message.message.event.content_block.type === 'thinking'
    );
    expect(reasoningMessages).toHaveLength(1);
    expect(reasoningMessages[0]?.message?.event).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'thinking',
        thinking: 'Checking the focused failure first. Then I will inspect the reducer path.',
      },
    });

    const grouped = groupAdjacentToolCalls(messages);
    const toolSequence = grouped.find(isToolSequence);
    expect(toolSequence?.pairedCalls).toEqual([
      {
        id: 'command-1',
        name: 'Terminal',
        input: { command: 'pnpm test' },
        status: 'success',
        result: { content: 'All focused tests passed', isError: false },
      },
    ]);
  });

  it('is deterministic when the same ordered pages are recombined', () => {
    const updates = createTranscript();
    const pages = [updates.slice(0, 2), updates.slice(2, 5), updates.slice(5)];

    const firstProjection = projectAcpTranscriptUpdates(updates);
    const recombinedProjection = projectAcpTranscriptUpdates([
      ...pages[0]!,
      ...pages[1]!,
      ...pages[2]!,
    ]);

    expect(recombinedProjection).toEqual(firstProjection);
  });

  it('does not coerce non-text user content into composer messages', () => {
    const updates: SubagentTranscriptUpdate[] = [
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'image', data: 'encoded-image', mimeType: 'image/png' },
      },
      {
        sessionUpdate: 'user_message_chunk',
        content: {
          type: 'resource',
          resource: { uri: 'file:///notes.txt', text: 'hidden resource text' },
        },
      },
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Keep this user text' },
      },
    ];

    expect(projectAcpTranscriptUpdates(updates)).toEqual([
      {
        id: 'subagent-message-2-0',
        source: 'user',
        text: 'Keep this user text',
        timestamp: FALLBACK_TIMESTAMP,
        order: 2,
      },
    ]);
  });

  it('does not seed a reasoning message for an empty thought chunk', () => {
    const updates: SubagentTranscriptUpdate[] = [
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '' },
      },
    ];

    expect(projectAcpTranscriptUpdates(updates)).toEqual([]);
  });

  it('projects every requested historical message beyond the live renderer window', () => {
    const updates: SubagentTranscriptUpdate[] = Array.from({ length: 1001 }, (_, index) => ({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `Historical message ${index}` },
    }));

    const messages = projectAcpTranscriptUpdates(updates);

    expect(messages).toHaveLength(1001);
    expect(messages[0]?.text).toBe('Historical message 0');
    expect(messages.at(-1)?.text).toBe('Historical message 1000');
  });
});
