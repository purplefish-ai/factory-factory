import { afterEach, describe, expect, it, vi } from 'vitest';
import * as protocol from '@/lib/chat-protocol';
import type { AgentContentItem, AgentMessage } from '@/lib/chat-protocol';
import { ArchivedJsonValueSchema } from '@/shared/acp-protocol/protocol/archived-content-schema';
import { projectClosedSessionTranscriptRows } from './closed-session-transcript-items';

const tool = (id: string, name = 'Read'): AgentContentItem => ({
  type: 'tool_use',
  id,
  name,
  input: { nested: [null, { kept: true }] },
});
const result = (id: string, content = 'equal'): AgentContentItem => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});
const text = (value = 'between'): AgentContentItem => ({ type: 'text', text: value });
function row(id: string, content: AgentContentItem[], message: Partial<AgentMessage> = {}) {
  return {
    id,
    source: 'agent',
    timestamp: '',
    order: 0,
    message: { type: 'assistant', message: { role: 'assistant', content }, ...message },
  };
}
const raw = (...values: unknown[]) => ArchivedJsonValueSchema.array().parse(values);
const values = (...rows: unknown[]) =>
  projectClosedSessionTranscriptRows(raw(...rows)).map(({ item }) => item);

afterEach(() => vi.restoreAllMocks());

describe('passive closed session transcript projection', () => {
  it('preserves ordinary rich rows and the existing late-result grouping output', () => {
    const current = raw(
      row('call', [tool('A')]),
      row('text', [text()]),
      row('result', [result('A')])
    );
    const projected = projectClosedSessionTranscriptRows(current);
    const rich = projected.flatMap(({ item }) => (item.kind === 'rich' ? [item.value] : []));
    expect(projected.every(({ item }) => item.kind === 'rich')).toBe(true);
    // The input is current, but the projection must establish this through the full codec.
    expect(rich).toEqual([
      {
        type: 'tool_sequence',
        id: 'tool-seq-call',
        pairedCalls: [
          {
            id: 'A',
            name: 'Read',
            input: { nested: [null, { kept: true }] },
            status: 'success',
            result: { content: 'equal', isError: false },
          },
        ],
      },
      current[1],
    ]);
  });

  it.each(['adjacent', 'late'])(
    'exposes an unselected result from an %s multi-result row exactly once',
    (mode) => {
      const mixed = row('results', [result('A'), result('B'), result('C')]);
      const input = raw(
        row('call', [tool('A')]),
        ...(mode === 'late' ? [row('text', [text()])] : []),
        mixed
      );
      const spy = vi.spyOn(protocol, 'groupAdjacentToolCalls');
      const projected = projectClosedSessionTranscriptRows(input);
      const items = projected.map(({ item }) => item);
      const fallbacks = items.filter((item) => item.kind === 'fallback');
      expect(fallbacks).toEqual([
        { kind: 'fallback', value: mixed, sourceIndex: input.length - 1 },
      ]);
      expect(fallbacks[0]?.value).toBe(input.at(-1));
      const group = items.find(
        (item) => item.kind === 'rich' && protocol.isToolSequence(item.value)
      );
      const original = spy.mock.results[0]?.value?.filter(protocol.isToolSequence)[0];
      expect(
        group?.kind === 'rich' && protocol.isToolSequence(group.value) && group.value.pairedCalls[0]
      ).toBe(original?.pairedCalls[0]);
      expect(original?.pairedCalls[0]).toMatchObject({ id: 'A', status: 'success' });
      expect(new Set(projected.map(({ key }) => key)).size).toBe(projected.length);
    }
  );

  it('retains call origins and rich-before-fallback ties in a call/results/text row', () => {
    const mixed = row('mixed', [tool('B'), result('A'), result('C'), text('also inspectable')]);
    const spy = vi.spyOn(protocol, 'groupAdjacentToolCalls');
    const projected = values(
      row('call', [tool('A')]),
      mixed,
      row('next', [tool('D')]),
      row('done', [result('D')])
    );
    expect(projected.map((item) => item.kind)).toEqual(['rich', 'fallback', 'rich']);
    expect(projected[1]).toEqual({ kind: 'fallback', sourceIndex: 1, value: mixed });
    const groups = projected.flatMap((item) =>
      item.kind === 'rich' && protocol.isToolSequence(item.value) ? [item.value] : []
    );
    expect(groups.map((group) => group.pairedCalls.map((call) => [call.id, call.status]))).toEqual([
      [
        ['A', 'success'],
        ['B', 'pending'],
      ],
      [['D', 'success']],
    ]);
    const original = spy.mock.results[0]?.value?.filter(protocol.isToolSequence)[0];
    expect(groups[0]?.pairedCalls[0]).toBe(original?.pairedCalls[0]);
    expect(groups[0]?.pairedCalls[1]).toBe(original?.pairedCalls[1]);
    expect(groups[1]?.pairedCalls[0]).toBe(original?.pairedCalls[2]);
  });

  it('keeps actual late consumption while exposing the rest of a skipped mixed row', () => {
    const mixed = row('mixed', [tool('B'), result('A'), result('C'), text()]);
    const projected = values(row('call', [tool('A')]), row('text', [text()]), mixed);
    expect(projected.map((item) => item.kind)).toEqual(['rich', 'rich', 'fallback']);
    expect(projected[2]).toEqual({ kind: 'fallback', value: mixed, sourceIndex: 2 });
    const group = projected[0];
    expect(
      group?.kind === 'rich' && protocol.isToolSequence(group.value) && group.value.pairedCalls
    ).toMatchObject([{ id: 'A', status: 'success' }]);
    expect(
      values(
        row('call', [tool('A')]),
        row('text', [text()]),
        row('mixed', [tool('B'), result('A'), text()])
      ).map((item) => item.kind)
    ).toEqual(['rich', 'rich']);
  });

  it('places leading/orphan-only results and opaque barriers at their serialized indices', () => {
    const opaque = {
      order: -100,
      timestamp: 'earlier',
      future: { type: 'tool_result', tool_use_id: 'A' },
    };
    const input = raw(
      row('leading', [result('missing')]),
      row('call', [tool('A')]),
      opaque,
      row('orphan', [result('A')]),
      row('text', [text()])
    );
    const projected = projectClosedSessionTranscriptRows(input).map(({ item }) => item);
    expect(projected.map((item) => item.kind)).toEqual([
      'fallback',
      'rich',
      'fallback',
      'fallback',
      'rich',
    ]);
    expect(
      projected
        .filter((item) => item.kind === 'fallback')
        .map((item) => [item.sourceIndex, item.value])
    ).toEqual([
      [0, input[0]],
      [2, input[2]],
      [3, input[3]],
    ]);
    expect(
      projected[1]?.kind === 'rich' &&
        protocol.isToolSequence(projected[1].value) &&
        projected[1].value.pairedCalls
    ).toMatchObject([{ id: 'A', status: 'pending' }]);
  });

  it('preserves result-before-call pairing when another orphan lies between them', () => {
    const orphan = row('orphan', [result('B')]);
    const projected = values(row('before', [result('A')]), orphan, row('after', [tool('A')]));
    expect(projected[0]).toEqual({ kind: 'fallback', sourceIndex: 1, value: orphan });
    expect(
      projected[1]?.kind === 'rich' &&
        protocol.isToolSequence(projected[1].value) &&
        projected[1].value.pairedCalls
    ).toMatchObject([{ id: 'A', status: 'success', result: { content: 'equal' } }]);
  });

  it('uses serialized positions instead of misleading order or timestamps', () => {
    const first = { ...row('duplicate', [text('first')]), order: 900, timestamp: '2050' };
    const second = { ...row('duplicate', [text('second')]), order: -1, timestamp: '1900' };
    const opaque = { order: -1000, timestamp: '1800', unknown: true };
    expect(values(first, opaque, second)).toEqual([
      { kind: 'rich', value: first },
      { kind: 'fallback', value: opaque, sourceIndex: 1 },
      { kind: 'rich', value: second },
    ]);
  });

  it('independently parses repeated raw references and identical result blocks', () => {
    const shared = raw(row('same', [result('A'), result('A')]))[0]!;
    const input = [...raw(row('same', [tool('A')]), row('same', [tool('A')])), shared, shared];
    const projected = projectClosedSessionTranscriptRows(input);
    expect(
      projected.filter(({ item }) => item.kind === 'fallback').map(({ item }) => item)
    ).toEqual([
      { kind: 'fallback', sourceIndex: 2, value: shared },
      { kind: 'fallback', sourceIndex: 3, value: shared },
    ]);
    const group = projected[0]?.item;
    expect(
      group?.kind === 'rich' &&
        protocol.isToolSequence(group.value) &&
        group.value.pairedCalls.map((call) => call.status)
    ).toEqual(['success', 'success']);
    expect(new Set(projected.map(({ key }) => key)).size).toBe(projected.length);
  });

  it('inventories stream-event, ordinary content and message-start result occurrences', () => {
    const event = row('event', [result('B')], {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: result('A') },
    });
    const start = row('start', [], {
      type: 'stream_event',
      event: { type: 'message_start', message: { role: 'assistant', content: [result('C')] } },
    });
    const projected = values(row('call', [tool('A')]), event, start);
    expect(projected.filter((item) => item.kind === 'fallback')).toEqual([
      { kind: 'fallback', sourceIndex: 1, value: event },
      { kind: 'fallback', sourceIndex: 2, value: start },
    ]);
    expect(
      projected[0]?.kind === 'rich' &&
        protocol.isToolSequence(projected[0].value) &&
        projected[0].value.pairedCalls[0]
    ).toMatchObject({ id: 'A', status: 'success' });
  });

  it('exposes unconsumed reasoning and filtered result blocks without reinterpreting JSON inputs', () => {
    const filtered = row('filtered', [result('A')], { type: 'result' });
    const projected = values(
      row('reason', [tool('R', 'reasoning')]),
      row('reason-result', [result('R')]),
      row('call', [tool('A')]),
      filtered,
      row('ok', [result('A')])
    );
    expect(
      projected.filter((item) => item.kind === 'fallback').map((item) => item.sourceIndex)
    ).toEqual([1, 3]);
    expect(
      values(
        row('input', [
          {
            type: 'tool_use',
            id: 'x',
            name: 'Read',
            input: {
              ignored: { type: 'tool_result', tool_use_id: 'missing', content: 'opaque tool JSON' },
            },
          },
        ])
      ).every((item) => item.kind === 'rich')
    ).toBe(true);
  });

  it('preserves late/repeated tool-ID FIFO and separates equal IDs across opaque rows', () => {
    const projected = values(
      row('same', [tool('A')]),
      row('text', [text()]),
      row('same', [tool('A')]),
      row('text', [text()]),
      row('r', [result('A', 'first')]),
      row('r', [result('A', 'second')]),
      null,
      row('r', [result('A', 'third')])
    );
    const groups = projected.flatMap((item) =>
      item.kind === 'rich' && protocol.isToolSequence(item.value) ? [item.value] : []
    );
    expect(groups.map((group) => group.pairedCalls[0]?.result?.content)).toEqual([
      'first',
      'second',
    ]);
    expect(projected.at(-1)).toMatchObject({ kind: 'fallback', sourceIndex: 7 });
  });

  it('preserves each opaque value, invalid nested known field and future tag without flattening', () => {
    const input = raw(
      null,
      1,
      'hello',
      false,
      ['array', { nested: true }],
      { role: 'user', content: 'legacy', extra: [null] },
      { ...row('future', []), message: { type: 'future' } },
      {
        ...row('invalid', []),
        message: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 1 }],
          },
        },
      }
    );
    expect(projectClosedSessionTranscriptRows(input).map(({ item }) => item)).toEqual(
      input.map((value, sourceIndex) => ({ kind: 'fallback', value, sourceIndex }))
    );
    expect(projectClosedSessionTranscriptRows([])).toEqual([]);
  });

  it('keeps original reserved/unknown keys while rich output contains declared fields only', () => {
    const reserved = ArchivedJsonValueSchema.parse(
      JSON.parse('{"__proto__":{"nested":[null]},"constructor":false}')
    );
    const current = {
      ...row('current', [text('known')]),
      extra: reserved,
      ...Object.fromEntries([['__proto__', reserved]]),
    };
    const opaque = { future: reserved };
    const input = raw(current, opaque);
    const before = structuredClone(input);
    const projected = projectClosedSessionTranscriptRows(input).map(({ item }) => item);
    expect(input).toStrictEqual(before);
    expect(Object.getOwnPropertyDescriptor(input[0], '__proto__')).toBeDefined();
    expect(projected[0]).toEqual({ kind: 'rich', value: row('current', [text('known')]) });
    expect(projected[1]).toEqual({ kind: 'fallback', value: opaque, sourceIndex: 1 });
    expect(projected[1]?.kind === 'fallback' && projected[1].value).toBe(input[1]);
  });

  it('gives final mixed group/message/part/fallback collisions globally unique keys', () => {
    const projected = projectClosedSessionTranscriptRows(
      raw(
        row('x', [tool('A')]),
        row('orphan', [result('B')]),
        row('later', [tool('C')]),
        row('tool-seq-x:archive:0', [text()]),
        row('tool-seq-x:archive:2', [text()]),
        row('fallback-6', [text()]),
        null,
        null,
        row('same', [text()]),
        row('same', [text()]),
        row('other', [tool('D')]),
        row('tool-seq-other', [text()])
      )
    );
    const keys = projected.map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      projected.flatMap(({ item }) => (item.kind === 'fallback' ? [item.sourceIndex] : []))
    ).toEqual([1, 6, 7]);
  });

  it.each([
    {
      type: 'pr_update',
      prDeliveryState: 'delivered',
      text: 'PR',
      childWorkspaceId: 'child',
      parentWorkspaceId: 'parent',
    },
    {
      type: 'system',
      subtype: 'subagent_started',
      tools: [{ name: 'Read', description: 'rich', input_schema: { any: [null] } }],
    },
    {
      type: 'session_lifecycle',
      lifecycle: {
        eventId: 'e',
        kind: 'SESSION_STOPPED',
        reason: 'USER_STOP',
        message: 'stopped',
        timestamp: '',
      },
    },
    { type: 'child_workspace_update', childWorkspaceName: 'child', childProjectName: 'project' },
    {
      type: 'parent_workspace_update',
      parentWorkspaceName: 'parent',
      parentProjectName: 'project',
    },
    {
      type: 'result',
      result: 'done',
      usage: { input_tokens: 1 },
      model_usage: {
        m: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 1,
          contextWindow: 3,
          maxOutputTokens: 4,
        },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'stream' },
      },
    },
  ])('keeps rich optional fields on $type', (message) => {
    const current = {
      id: 'rich',
      source: 'agent',
      timestamp: '',
      order: 0,
      subagentId: 'sub',
      subagentIconIndex: 2,
      attachments: [
        {
          id: 'attachment',
          name: 'name',
          type: 'text/plain',
          size: 1,
          data: 'x',
          contentType: 'text',
        },
      ],
      message,
    };
    expect(values(current)).toEqual([{ kind: 'rich', value: current }]);
  });
});
