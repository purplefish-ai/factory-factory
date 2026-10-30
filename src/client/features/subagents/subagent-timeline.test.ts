import { describe, expect, it } from 'vitest';
import {
  groupAdjacentToolCalls,
  filterDuplicateResultMessages,
  type ChatMessage,
  isToolSequence,
} from '@/lib/chat-protocol';
import type { SubagentSummary } from '@/shared/acp-protocol';
import {
  createSubagentTimelineEvents,
  mergeSubagentTimeline as mergeEvents,
} from './subagent-timeline';

function mergeSubagentTimeline(
  messages: ChatMessage[],
  subagents: SubagentSummary[]
): ChatMessage[] {
  return mergeEvents(messages, createSubagentTimelineEvents(subagents));
}

const agent: SubagentSummary = {
  id: 'review',
  name: 'Audit capture fix',
  status: 'completed',
  createdAt: '2026-10-30T12:00:01Z',
  updatedAt: '2026-10-30T12:00:04Z',
  completedAt: '2026-10-30T12:00:03Z',
  latestActivity: null,
  resultPreview: null,
};
function text(id: string, timestamp: string): ChatMessage {
  return {
    id,
    timestamp,
    order: 0,
    source: 'agent',
    message: { type: 'assistant', message: { role: 'assistant', content: id } },
  };
}

describe('mergeSubagentTimeline', () => {
  it('interleaves separate start and finish entries without reordering the transcript', () => {
    const messages = [
      text('before', '2026-10-30T12:00:00Z'),
      text('during', '2026-10-30T12:00:02Z'),
      text('after', '2026-10-30T12:00:04Z'),
    ];
    const merged = mergeSubagentTimeline(messages, [agent, agent]);
    expect(merged.map((item) => item.text ?? item.id)).toEqual([
      'before',
      'Audit capture fix started working',
      'during',
      'Audit capture fix finished',
      'after',
    ]);
    expect(merged.filter((item) => item.message?.subtype === 'subagent_started')).toHaveLength(1);
    expect(mergeSubagentTimeline(messages, [agent]).map((item) => item.id)).toEqual(
      merged.map((item) => item.id)
    );
    expect(merged[0]).toBe(messages[0]);
  });

  it('uses original provider timestamps when chat wrappers were rebuilt during history replay', () => {
    const replayed = [
      text('before', '2026-10-30T12:00:00Z'),
      text('during', '2026-10-30T12:00:02Z'),
      text('after', '2026-10-30T12:00:04Z'),
    ].map((message): ChatMessage => ({
      ...message,
      timestamp: '2026-10-31T00:00:00Z',
      message: {
        type: 'assistant',
        timestamp: message.timestamp,
        message: { role: 'assistant', content: message.id },
      },
    }));
    expect(
      mergeSubagentTimeline(replayed, [agent]).map((message) => message.text ?? message.id)
    ).toEqual([
      'before',
      'Audit capture fix started working',
      'during',
      'Audit capture fix finished',
      'after',
    ]);
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'preserves %s outcomes and uses a known terminal update time',
    (status) => {
      const merged = mergeSubagentTimeline(
        [],
        [{ ...agent, name: null, status, completedAt: null }]
      );
      expect(merged.map((item) => item.text)).toEqual([
        'Sub-agent started working',
        `Sub-agent ${status}`,
      ]);
      expect(merged[1]?.timestamp).toBe(agent.updatedAt);
    }
  );

  it('does not invent missing timestamps or a finish for a running agent', () => {
    expect(
      mergeSubagentTimeline([], [{ ...agent, status: 'running', completedAt: null }])
    ).toHaveLength(1);
    const messages = [text('hello', '2026-10-30T12:00:00Z')];
    expect(
      mergeSubagentTimeline(messages, [
        { ...agent, createdAt: null, completedAt: null, updatedAt: null },
      ])
    ).toBe(messages);
    expect(mergeSubagentTimeline(messages, [])).toBe(messages);
  });

  it('breaks tool groups at lifecycle entries and still pairs late tool results', () => {
    const tool: ChatMessage = {
      id: 'tool',
      order: 0,
      source: 'agent',
      timestamp: '2026-10-30T12:00:00Z',
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pnpm test' } },
          ],
        },
      },
    };
    const result: ChatMessage = {
      id: 'result',
      order: 1,
      source: 'agent',
      timestamp: '2026-10-30T12:00:02Z',
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'passed' }],
        },
      },
    };
    const grouped = groupAdjacentToolCalls(mergeSubagentTimeline([tool, result], [agent]));
    const sequence = grouped.find(isToolSequence);
    expect(sequence?.pairedCalls[0]?.status).toBe('success');
    expect(grouped.flatMap((item) => (isToolSequence(item) ? [] : [item.text]))).toEqual([
      'Audit capture fix started working',
      'Audit capture fix finished',
    ]);
  });
  it('keeps duplicate final answers suppressed across lifecycle entries', () => {
    const answer = text('answer', '2026-10-30T12:00:02Z');
    const result: ChatMessage = {
      id: 'result',
      source: 'agent',
      order: 2,
      timestamp: '2026-10-30T12:00:04Z',
      message: { type: 'result', result: 'answer' },
    };
    expect(
      filterDuplicateResultMessages(mergeSubagentTimeline([answer, result], [agent])).map(
        (message) => message.id
      )
    ).not.toContain('result');
  });
});

it('assigns distinct icons in creation order and retains them for finish events', () => {
  const events = createSubagentTimelineEvents([
    { ...agent, id: 'd', createdAt: '2026-10-30T12:00:02Z' },
    { ...agent, id: 'a' },
  ]);
  expect(
    events
      .filter((event) => event.message?.subtype === 'subagent_started')
      .map((event) => event.subagentIconIndex)
  ).toEqual([0, 1]);
  expect(
    events
      .filter((event) => event.id.startsWith('subagent-d-'))
      .map((event) => event.subagentIconIndex)
  ).toEqual([1, 1]);
});
