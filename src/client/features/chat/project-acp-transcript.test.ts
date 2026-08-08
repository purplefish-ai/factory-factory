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
    ]);
    expect(messages.map((message) => message.order)).toEqual([0, 1, 3, 6, 7]);
    expect(messages.map((message) => message.id)).toEqual([
      'subagent-message-0-0',
      'subagent-message-1-1',
      'subagent-message-3-2',
      'subagent-message-6-3',
      'subagent-message-7-4',
    ]);
    expect(messages.every((message) => message.timestamp === FALLBACK_TIMESTAMP)).toBe(true);
    expect(messages[0]).toEqual({
      id: 'subagent-message-0-0',
      source: 'user',
      text: 'Inspect the failing tests',
      timestamp: FALLBACK_TIMESTAMP,
      order: 0,
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
});
