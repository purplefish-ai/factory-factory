import { describe, expect, it } from 'vitest';
import {
  type AgentContentItem,
  type ChatMessage,
  extractToolResultInfo,
  groupAdjacentToolCalls,
  isToolSequence,
  type PairedToolCall,
  type ToolGroupingTrace,
  type ToolResultContent,
} from '@/lib/chat-protocol';

function row(id: string, content: AgentContentItem[]): ChatMessage {
  return {
    id,
    source: 'agent',
    timestamp: '',
    order: 0,
    message: { type: 'assistant', message: { role: 'assistant', content } },
  };
}
const call = (id: string, name = 'Read'): AgentContentItem => ({
  type: 'tool_use',
  id,
  name,
  input: {},
});
const result = (id: string): ToolResultContent => ({
  type: 'tool_result',
  tool_use_id: id,
  content: 'equal content',
});

describe('optional tool grouping observation', () => {
  it.each(['adjacent', 'late', 'result-before-call'])(
    'reports the actual selected block and paired objects for %s assignment',
    (mode) => {
      const a = result('A');
      const b = result('B');
      const tool = row('call', [call('A')]);
      const output = row('result', [a, b]);
      const text = row('text', [{ type: 'text', text: 'between' }]);
      const messages =
        mode === 'late'
          ? [tool, text, output]
          : mode === 'adjacent'
            ? [tool, output]
            : [output, tool];
      const calls: [ChatMessage, PairedToolCall][] = [];
      const consumed: [ChatMessage, ToolResultContent, PairedToolCall][] = [];
      const sequences: ChatMessage[][] = [];
      const trace: ToolGroupingTrace = {
        onToolCall: (message, paired) => calls.push([message, paired]),
        onToolResult: (message, block, paired) => consumed.push([message, block, paired]),
        onToolSequence: (_sequence, source) => sequences.push([...source]),
      };
      const grouped = groupAdjacentToolCalls(messages, trace);
      expect(grouped).toStrictEqual(groupAdjacentToolCalls(messages));
      expect(consumed).toHaveLength(1);
      expect(consumed[0]?.[0]).toBe(output);
      expect(consumed[0]?.[1]).toBe(a);
      expect(calls[0]?.[0]).toBe(tool);
      const paired = grouped.filter(isToolSequence)[0]?.pairedCalls[0];
      expect(consumed[0]?.[2]).toBe(paired);
      expect(calls[0]?.[1]).toBe(paired);
      expect(paired).toMatchObject({ id: 'A', status: 'success' });
      expect(sequences).toEqual([mode === 'late' ? [tool] : messages]);
    }
  );

  it('observes repeated-ID FIFO assignments without conflating equal strings', () => {
    const first = result('A');
    const second = result('A');
    const messages = [
      row('same', [call('A')]),
      row('same', [call('A')]),
      row('text', [{ type: 'text', text: 'flush' }]),
      row('same', [first]),
      row('same', [second]),
    ];
    const consumed: [ToolResultContent, PairedToolCall][] = [];
    const grouped = groupAdjacentToolCalls(messages, {
      onToolResult: (_message, block, paired) => consumed.push([block, paired]),
    });
    const paired = grouped.filter(isToolSequence)[0]?.pairedCalls;
    expect(grouped).toStrictEqual(groupAdjacentToolCalls(messages));
    expect(consumed.map(([block]) => block)).toEqual([first, second]);
    expect(consumed[0]?.[0]).toBe(first);
    expect(consumed[1]?.[0]).toBe(second);
    expect(consumed[0]?.[1]).toBe(paired?.[0]);
    expect(consumed[1]?.[1]).toBe(paired?.[1]);
  });

  it('reports event-block identity, and never consumes reasoning or filtered results', () => {
    const block = result('A');
    const event: ChatMessage = {
      ...row('event', []),
      message: {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: block },
      },
    };
    const hidden: ChatMessage = {
      ...row('hidden', [result('A')]),
      message: { type: 'result', message: { role: 'user', content: [result('A')] } },
    };
    const messages = [
      row('reasoning', [call('R', 'reasoning')]),
      row('reason-result', [result('R')]),
      row('call', [call('A')]),
      hidden,
      event,
    ];
    const consumed: ToolResultContent[] = [];
    const calls: string[] = [];
    const grouped = groupAdjacentToolCalls(messages, {
      onToolCall: (_message, paired) => calls.push(paired.id),
      onToolResult: (_message, selected) => consumed.push(selected),
    });
    expect(grouped).toStrictEqual(groupAdjacentToolCalls(messages));
    expect(calls).toEqual(['A']);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toBe(block);
  });

  it('keeps default extraction free of trace selection fields', () => {
    expect(extractToolResultInfo(row('result', [result('A')]).message!)).toStrictEqual({
      toolUseId: 'A',
      content: 'equal content',
      isError: false,
    });
  });
});
