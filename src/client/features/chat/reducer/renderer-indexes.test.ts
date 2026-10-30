import { describe, expect, it } from 'vitest';
import type { AgentMessage, ChatMessage, WebSocketMessage } from '@/lib/chat-protocol';
import { getToolUseIdFromEvent, isStreamEventMessage } from '@/lib/chat-protocol';
import { chatReducer, createInitialChatState } from './index';
import {
  getRendererTranscriptIds,
  resolveRendererTranscript,
  runRendererTranscriptBatch,
} from './renderer-indexes';

const timestamp = '2026-10-30T00:00:00.000Z';

function toolUse(order: number): ChatMessage {
  const message: AgentMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: `call-${order}`, name: 'Read', input: {} },
    },
  };
  return { id: `tool-${order}`, source: 'agent', message, timestamp, order };
}

function assistant(order: number, text = `text-${order}`): ChatMessage {
  return {
    id: `assistant-${order}`,
    source: 'agent',
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
    timestamp,
    order,
  };
}

function user(order: number): ChatMessage {
  return { id: `user-${order}`, source: 'user', text: `ask ${order}`, timestamp, order };
}

/** The lookups a full rescan produces, written independently of the implementation. */
function expectedIndexes(messages: ChatMessage[]) {
  const toolUseIdToIndex = new Map<string, number>();
  const agentMessageOrderToIndex = new Map<number, number>();
  messages.forEach((message, index) => {
    if (message.message && isStreamEventMessage(message.message)) {
      const toolUseId = getToolUseIdFromEvent(message.message.event);
      if (toolUseId) {
        toolUseIdToIndex.set(toolUseId, index);
      }
    }
    if (message.source === 'agent' && message.order >= 0) {
      agentMessageOrderToIndex.set(message.order, index);
    }
  });
  return { toolUseIdToIndex, agentMessageOrderToIndex };
}

function expectMatchesRescan(resolved: ReturnType<typeof resolveRendererTranscript>) {
  const expected = expectedIndexes(resolved.retained);
  expect(resolved.indexes.toolUseIdToIndex).toEqual(expected.toolUseIdToIndex);
  expect(resolved.indexes.agentMessageOrderToIndex).toEqual(expected.agentMessageOrderToIndex);
  expect(getRendererTranscriptIds(resolved.retained, resolved.indexes)).toEqual(
    new Set(resolved.retained.map((message) => message.id))
  );
}

describe('resolveRendererTranscript', () => {
  it('derives lookups for appended and in-place replaced messages', () => {
    let current: ChatMessage[] = [];
    for (let order = 0; order < 30; order += 1) {
      const message =
        order % 3 === 0 ? user(order) : order % 3 === 1 ? toolUse(order) : assistant(order);
      const resolved = resolveRendererTranscript(current, [...current, message], 1000);
      expectMatchesRescan(resolved);
      current = resolved.retained;
    }

    const replaced = [...current];
    replaced[5] = assistant(5, 'edited');
    const resolved = resolveRendererTranscript(current, replaced, 1000);
    expect(resolved.retained).toBe(replaced);
    expectMatchesRescan(resolved);
  });

  it('falls back to the renderer trim and a rescan for other changes', () => {
    const current = resolveRendererTranscript([], [assistant(1), assistant(3)], 1000).retained;

    const outOfOrder = resolveRendererTranscript(current, [...current, assistant(2)], 1000);
    expect(outOfOrder.retained.map((message) => message.order)).toEqual([1, 2, 3]);
    expectMatchesRescan(outOfOrder);

    const overLimit = resolveRendererTranscript(current, [...current, assistant(4)], 2);
    expect(overLimit.retained.map((message) => message.order)).toEqual([3, 4]);
    expectMatchesRescan(overLimit);

    const renamed = [...current];
    renamed[0] = { ...assistant(1), id: 'other-id' };
    expectMatchesRescan(resolveRendererTranscript(current, renamed, 1000));
  });

  it('remaps a tool call replaced in place under a different tool-use id', () => {
    const current = resolveRendererTranscript([], [assistant(1), toolUse(2), assistant(3)], 1000);
    expect(current.indexes.toolUseIdToIndex.get('call-2')).toBe(1);

    // Same message id and order, so only the tool-use key changes.
    const original = toolUse(2);
    const retargeted = toolUse(9);
    const replaced = [...current.retained];
    replaced[1] = { ...retargeted, id: original.id, order: original.order };
    const resolved = resolveRendererTranscript(current.retained, replaced, 1000);

    expect(resolved.indexes.toolUseIdToIndex.has('call-2')).toBe(false);
    expect(resolved.indexes.toolUseIdToIndex.get('call-9')).toBe(1);
    expectMatchesRescan(resolved);
    // The previous transcript's lookups are untouched.
    expect(current.indexes.toolUseIdToIndex.get('call-2')).toBe(1);
  });

  it('never changes lookups that belong to a committed transcript', () => {
    const committed = resolveRendererTranscript([], [assistant(1), toolUse(2)], 1000);
    const snapshot = expectedIndexes(committed.retained);

    resolveRendererTranscript(committed.retained, [...committed.retained, assistant(3)], 1000);
    runRendererTranscriptBatch(() =>
      resolveRendererTranscript(committed.retained, [...committed.retained, toolUse(4)], 1000)
    );

    expect(committed.indexes.toolUseIdToIndex).toEqual(snapshot.toolUseIdToIndex);
    expect(committed.indexes.agentMessageOrderToIndex).toEqual(snapshot.agentMessageOrderToIndex);
  });
});

describe('session replay lookups', () => {
  function replayEvents(groups: number): WebSocketMessage[] {
    return Array.from({ length: groups }, (_, group): WebSocketMessage[] => {
      const base = group * 4;
      const id = `user-${group}`;
      return [
        {
          type: 'message_state_changed',
          id,
          newState: 'ACCEPTED',
          userMessage: { text: `ask ${group}`, timestamp, order: base },
        },
        { type: 'message_state_changed', id, newState: 'COMMITTED' },
        {
          type: 'agent_message',
          data: toolUse(base + 1).message,
          messageId: `t${group}`,
          order: base + 1,
        },
        {
          type: 'agent_message',
          data: assistant(base + 2).message,
          messageId: `a${group}`,
          order: base + 2,
        },
      ] as WebSocketMessage[];
    }).flat();
  }

  it('matches a full rescan after replay, inside and beyond the renderer limit', () => {
    for (const rendererTranscriptLimit of [1000, 25]) {
      const state = chatReducer(createInitialChatState({ rendererTranscriptLimit }), {
        type: 'SESSION_REPLAY_BATCH',
        payload: { replayEvents: replayEvents(40) },
      });
      expect(state.messages.length).toBeLessThanOrEqual(rendererTranscriptLimit);
      const expected = expectedIndexes(state.messages);
      expect(state.toolUseIdToIndex).toEqual(expected.toolUseIdToIndex);
      expect(state.agentMessageOrderToIndex).toEqual(expected.agentMessageOrderToIndex);
    }
  });

  it('keeps the replayed state intact when live messages follow', () => {
    const replayed = chatReducer(createInitialChatState(), {
      type: 'SESSION_REPLAY_BATCH',
      payload: { replayEvents: replayEvents(3) },
    });
    const before = expectedIndexes(replayed.messages);
    const next = chatReducer(replayed, {
      type: 'WS_AGENT_MESSAGE',
      payload: { message: assistant(100).message!, order: 100 },
    });

    expect(next.messages).toHaveLength(replayed.messages.length + 1);
    expect(replayed.agentMessageOrderToIndex).toEqual(before.agentMessageOrderToIndex);
    expect(next.agentMessageOrderToIndex.get(100)).toBe(replayed.messages.length);
  });
});
