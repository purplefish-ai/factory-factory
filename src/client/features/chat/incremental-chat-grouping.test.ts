import { describe, expect, it } from 'vitest';
import type { AgentMessage, ChatMessage } from '@/lib/chat-protocol';
import {
  filterDuplicateResultMessages,
  groupAdjacentToolCalls,
  isToolSequence,
} from '@/lib/chat-protocol';
import { createIncrementalChatGrouper } from './incremental-chat-grouping';

const timestamp = '2026-09-08T00:00:00.000Z';

function user(id: string, order: number): ChatMessage {
  return { id, source: 'user', text: id, timestamp, order };
}

function assistant(id: string, text: string, order: number): ChatMessage {
  return {
    id,
    source: 'agent',
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
    timestamp,
    order,
  };
}

function toolUse(messageId: string, toolUseId: string, order: number): ChatMessage {
  const message: AgentMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: toolUseId,
        name: 'Read',
        input: { file_path: `${messageId}.ts` },
      },
    },
  };
  return { id: messageId, source: 'agent', message, timestamp, order };
}

function toolResult(
  messageId: string,
  toolUseId: string,
  order: number,
  content = `${messageId} result`
): ChatMessage {
  const message: AgentMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }],
    },
  };
  return { id: messageId, source: 'agent', message, timestamp, order };
}

function result(id: string, text: string, order: number): ChatMessage {
  return {
    id,
    source: 'agent',
    message: { type: 'result', result: text },
    timestamp,
    order,
  };
}

function oracle(messages: ChatMessage[], filterDuplicateResults = false) {
  return groupAdjacentToolCalls(
    filterDuplicateResults ? filterDuplicateResultMessages(messages) : messages
  );
}

function toolSequences(messages: ReturnType<typeof oracle>) {
  return messages.filter(isToolSequence);
}

describe('createIncrementalChatGrouper', () => {
  it('keeps completed historical tool groups stable while the final text streams', () => {
    const grouper = createIncrementalChatGrouper();
    const history = [
      user('user', 0),
      toolUse('tool-use', 'call', 1),
      toolResult('tool-result', 'call', 2),
    ];
    const first = grouper.group([...history, assistant('answer', 'hel', 3)]);
    const secondMessages = [...history, assistant('answer', 'hello', 3)];
    const second = grouper.group(secondMessages);

    expect(second).toEqual(oracle(secondMessages));
    expect(toolSequences(second)[0]).toBe(toolSequences(first)[0]);
    expect(second.at(-1)).toBe(secondMessages.at(-1));
  });

  it('recomputes a pending group when its result arrives after assistant text', () => {
    const grouper = createIncrementalChatGrouper();
    const completed = [
      toolUse('completed-use', 'completed', 0),
      toolResult('completed-result', 'completed', 1),
      assistant('between', 'between', 2),
    ];
    const pending = toolUse('pending-use', 'pending', 3);
    const trailingText = assistant('trailing', 'working', 4);
    const first = grouper.group([...completed, pending, trailingText]);
    const nextMessages = [
      ...completed,
      pending,
      trailingText,
      toolResult('late-result', 'pending', 5),
    ];
    const second = grouper.group(nextMessages);

    expect(second).toEqual(oracle(nextMessages));
    expect(toolSequences(second)[0]).toBe(toolSequences(first)[0]);
    expect(toolSequences(second)[1]).not.toBe(toolSequences(first)[1]);
    expect(toolSequences(second)[1]?.pairedCalls[0]?.status).toBe('success');
  });

  it('pairs late results in occurrence order when tool IDs are reused', () => {
    const grouper = createIncrementalChatGrouper();
    const firstUse = toolUse('use-1', 'reused', 0);
    const firstText = assistant('text-1', 'one', 1);
    const secondUse = toolUse('use-2', 'reused', 2);
    const secondText = assistant('text-2', 'two', 3);

    grouper.group([firstUse, firstText, secondUse, secondText]);
    const afterFirstMessages = [
      firstUse,
      firstText,
      secondUse,
      secondText,
      toolResult('result-1', 'reused', 4, 'first'),
    ];
    const afterFirst = grouper.group(afterFirstMessages);
    const afterSecondMessages = [
      ...afterFirstMessages,
      toolResult('result-2', 'reused', 5, 'second'),
    ];
    const afterSecond = grouper.group(afterSecondMessages);

    expect(afterFirst).toEqual(oracle(afterFirstMessages));
    expect(afterSecond).toEqual(oracle(afterSecondMessages));
    expect(toolSequences(afterSecond)[0]).toBe(toolSequences(afterFirst)[0]);
    expect(
      toolSequences(afterSecond).map((sequence) => sequence.pairedCalls[0]?.result?.content)
    ).toEqual(['first', 'second']);
  });

  it('does not regroup a consumed late result into a following orphan-result sequence', () => {
    const grouper = createIncrementalChatGrouper();
    const initialMessages = [
      toolUse('use-a', 'call-a', 0),
      assistant('boundary', 'working', 1),
      toolResult('late-a', 'call-a', 2),
      toolResult('orphan-b', 'call-b', 3),
    ];
    const initial = grouper.group(initialMessages);
    const initialCopy = structuredClone(initial);
    const nextMessages = [...initialMessages, toolUse('use-c', 'call-c', 4)];
    const next = grouper.group(nextMessages);

    expect(next).toEqual(oracle(nextMessages));
    expect(toolSequences(next).at(-1)?.id).toBe('tool-seq-orphan-b');
    expect(initial).toEqual(initialCopy);
  });

  it('falls back when a reused ID rewind crosses another call late result', () => {
    const grouper = createIncrementalChatGrouper();
    const initialMessages = [
      toolUse('use-b', 'call-b', 0),
      assistant('boundary-b', 'working', 1),
      toolUse('use-a-1', 'call-a', 2),
      assistant('boundary-a-1', 'working', 3),
      toolResult('late-b', 'call-b', 4),
      toolUse('use-a-2', 'call-a', 5),
      assistant('boundary-a-2', 'working', 6),
      toolResult('result-a-1', 'call-a', 7),
      assistant('after-a-1', 'still working', 8),
    ];
    grouper.group(initialMessages);
    const nextMessages = [...initialMessages, toolResult('result-a-2', 'call-a', 9)];

    expect(grouper.group(nextMessages)).toEqual(oracle(nextMessages));
  });

  it('stays equivalent through prepend, window trim, replay, reset, and reorder updates', () => {
    const grouper = createIncrementalChatGrouper();
    const stableToolUse = toolUse('stable-use', 'stable', 2);
    const stableToolResult = toolResult('stable-result', 'stable', 3);
    const stableText = assistant('stable-text', 'done', 4);
    const window = [stableToolUse, stableToolResult, stableText];
    const initial = grouper.group(window);
    const initialToolGroup = toolSequences(initial)[0];

    const prepended = [user('older-0', 0), user('older-1', 1), ...window];
    const afterPrepend = grouper.group(prepended);
    expect(afterPrepend).toEqual(oracle(prepended));
    expect(toolSequences(afterPrepend)[0]).toBe(initialToolGroup);

    const trimmed = prepended.slice(1);
    const afterTrim = grouper.group(trimmed);
    expect(afterTrim).toEqual(oracle(trimmed));
    expect(toolSequences(afterTrim)[0]).toBe(initialToolGroup);

    const replayed = trimmed.map((message) => ({ ...message }));
    expect(grouper.group(replayed)).toEqual(oracle(replayed));
    expect(grouper.group([])).toEqual([]);
    expect(grouper.group([replayed[2]!, replayed[0]!, replayed[1]!])).toEqual(
      oracle([replayed[2]!, replayed[0]!, replayed[1]!])
    );
  });

  it('optionally preserves main-chat duplicate result filtering', () => {
    const messages = [assistant('answer', 'same', 0), result('result', 'same', 1)];

    expect(createIncrementalChatGrouper().group(messages)).toEqual(oracle(messages));
    expect(createIncrementalChatGrouper({ filterDuplicateResults: true }).group(messages)).toEqual(
      oracle(messages, true)
    );
  });
});
