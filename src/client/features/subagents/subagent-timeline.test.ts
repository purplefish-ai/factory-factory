import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('retains the provider identity on both lifecycle entries for direct navigation', () => {
    const events = createSubagentTimelineEvents([agent]);
    expect(events.map((event) => event.subagentId)).toEqual(['review', 'review']);
  });
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

  // Known bug: session_replay_batch agent_message events carry no timestamp, and
  // the backend never sets AgentMessage.timestamp, so the chat reducer stamps every
  // replayed agent message with the reload time (createClaudeMessage). The merge
  // then treats all agent rows as "after" every lifecycle event, so after a reload
  // or session switch all sub-agent rows bunch up before the first agent reply.
  // Fixing it needs the replay builder to send the transcript timestamp
  // (src/backend/services/session/service/store/session-replay-builder.ts) and the
  // reducer to keep it, which is outside this feature.
  it.fails('places lifecycle entries in their own turn after a session reload', () => {
    const reloadedAt = '2026-10-31T09:00:00.000Z';
    const user = (id: string, timestamp: string): ChatMessage => ({
      id,
      source: 'user',
      text: id,
      timestamp,
      order: 0,
    });
    // Shape produced by chatReducer for replayed history: user rows keep their
    // server timestamp, agent rows get the replay time and no provider timestamp.
    const replayed: ChatMessage[] = [
      user('first ask', '2026-10-30T12:00:00Z'),
      text('first reply', reloadedAt),
      user('second ask', '2026-10-30T12:10:00Z'),
      text('second reply', reloadedAt),
    ];
    const secondTurnAgent: SubagentSummary = {
      ...agent,
      id: 'second',
      name: 'Second turn helper',
      createdAt: '2026-10-30T12:10:01Z',
      completedAt: '2026-10-30T12:10:05Z',
      updatedAt: '2026-10-30T12:10:05Z',
    };
    expect(
      mergeSubagentTimeline(replayed, [agent, secondTurnAgent]).map(
        (message) => message.text ?? message.id
      )
    ).toEqual([
      'first ask',
      'Audit capture fix started working',
      'Audit capture fix finished',
      'first reply',
      'second ask',
      'Second turn helper started working',
      'Second turn helper finished',
      'second reply',
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

// Copy of the pre-cache implementation, kept to prove the cached merge is equivalent.
function legacyTranscriptTimestamp(message: ChatMessage): number {
  const providerTime = Date.parse(message.message?.timestamp ?? '');
  return Number.isFinite(providerTime) ? providerTime : Date.parse(message.timestamp);
}
function legacyMerge(messages: ChatMessage[], pending: ChatMessage[]): ChatMessage[] {
  if (pending.length === 0) {
    return messages;
  }
  const merged: ChatMessage[] = [];
  let index = 0;
  for (const message of messages) {
    while (index < pending.length) {
      const event = pending[index];
      if (!event || Date.parse(event.timestamp) > legacyTranscriptTimestamp(message)) {
        break;
      }
      merged.push(event);
      index += 1;
    }
    merged.push(message);
  }
  merged.push(...pending.slice(index));
  return merged;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const RANDOM_TIMES = [
  '2026-10-30T12:00:00Z',
  '2026-10-30T12:00:01Z',
  '2026-10-30T12:00:01.000Z',
  '2026-10-30T12:00:02Z',
  '2026-10-30T12:00:03Z',
  'not a date',
  '',
];

function randomTranscript(random: () => number, length: number): ChatMessage[] {
  const pick = () => RANDOM_TIMES[Math.floor(random() * RANDOM_TIMES.length)] ?? '';
  return Array.from({ length }, (_, index): ChatMessage => {
    const message = text(`m${index}`, pick());
    const providerRoll = random();
    if (providerRoll < 0.3) {
      return message;
    }
    return {
      ...message,
      message: {
        type: 'assistant',
        ...(providerRoll < 0.8 ? { timestamp: pick() } : {}),
        message: { role: 'assistant', content: message.id },
      },
    };
  });
}

function randomSubagents(random: () => number, count: number): SubagentSummary[] {
  const pick = () => {
    const value = RANDOM_TIMES[Math.floor(random() * (RANDOM_TIMES.length + 1))];
    return value === undefined ? null : value;
  };
  const statuses = ['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
  return Array.from({ length: count }, (_, index) => ({
    ...agent,
    id: `agent-${index}`,
    status: statuses[Math.floor(random() * statuses.length)] ?? 'running',
    createdAt: pick(),
    completedAt: pick(),
    updatedAt: pick(),
  }));
}

describe('cached timeline timestamps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches the uncached merge on randomized transcripts with ties and invalid times', () => {
    const random = seededRandom(42);
    for (let run = 0; run < 300; run += 1) {
      const messages = randomTranscript(random, Math.floor(random() * 30));
      const events = createSubagentTimelineEvents(
        randomSubagents(random, Math.floor(random() * 6))
      );
      const legacyEvents = [...events].sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
      );
      expect(events).toEqual(legacyEvents);
      const expected = legacyMerge(messages, events);
      // Merge twice so the second pass exercises cached message and event times.
      expect(mergeEvents(messages, events)).toEqual(expected);
      const merged = mergeEvents(messages, events);
      expect(merged).toHaveLength(expected.length);
      merged.forEach((item, index) => expect(item).toBe(expected[index]));
    }
  });

  it('matches the uncached merge for externally built events without cached times', () => {
    const random = seededRandom(7);
    for (let run = 0; run < 100; run += 1) {
      const messages = randomTranscript(random, 20);
      const pending = randomTranscript(random, 3).map((event) => ({
        ...event,
        id: `e-${event.id}`,
      }));
      expect(mergeEvents(messages, pending)).toEqual(legacyMerge(messages, pending));
    }
  });

  it('places events before transcript rows whose times cannot be parsed', () => {
    const invalid = text('invalid', 'not a date');
    const missing: ChatMessage = { ...text('missing', ''), message: undefined };
    const valid = text('valid', '2026-10-30T11:00:00Z');
    const merged = mergeSubagentTimeline([valid, invalid, missing], [agent]);
    expect(merged.map((item) => item.text ?? item.id)).toEqual([
      'valid',
      'Audit capture fix started working',
      'Audit capture fix finished',
      'invalid',
      'missing',
    ]);
  });

  it('parses each streamed message once across repeated merges', () => {
    const base = '2026-10-30T12:00:00.000Z';
    const messages = Array.from({ length: 1000 }, (_, index) =>
      text(`m${index}`, new Date(Date.parse(base) + index * 1000).toISOString())
    );
    // A recently finished agent keeps lifecycle events pending until the tail.
    const events = createSubagentTimelineEvents([
      {
        ...agent,
        createdAt: new Date(Date.parse(base) + 998_500).toISOString(),
        completedAt: new Date(Date.parse(base) + 1_000_000).toISOString(),
      },
    ]);
    const parse = vi.spyOn(Date, 'parse');
    let transcript = messages;
    const first = mergeEvents(transcript, events);
    expect(first.at(-1)?.text).toBe('Audit capture fix finished');
    // At most a provider and local parse for each first-seen transcript message.
    expect(parse.mock.calls.length).toBeLessThanOrEqual(2 * messages.length);

    for (let chunk = 0; chunk < 50; chunk += 1) {
      parse.mockClear();
      const tail = transcript.at(-1);
      if (!tail) {
        throw new Error('missing tail');
      }
      transcript = [...transcript.slice(0, -1), { ...tail, id: `${tail.id}-${chunk}` }];
      mergeEvents(transcript, events);
      expect(parse.mock.calls.length).toBeLessThanOrEqual(2);
    }
  });
});
