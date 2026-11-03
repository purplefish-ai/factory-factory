import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, ChatMessage } from '@/shared/acp-protocol';
import type { SessionStore } from './session-store.types';
import { findPersistedToolUseStart } from './session-tool-use-index';
import {
  appendClaudeEvent,
  messageSort,
  rebuildTranscriptIndex,
  removeTranscriptMessageById,
  upsertTranscriptMessage,
} from './session-transcript';

function createStore(): SessionStore {
  return {
    sessionId: 's1',
    initialized: true,
    transcript: [],
    transcriptIdToIndex: new Map(),
    queue: [],
    recentRejections: [],
    pendingInteractiveRequest: null,
    runtime: {
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
    nextOrder: 0,
  };
}

const appendOptions = {
  nowIso: () => '2026-02-01T00:00:00.000Z',
  onParityTrace: vi.fn(),
};

function toolUse(id: string, input: Record<string, unknown> = {}): AgentMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name: 'Bash', input },
    },
  };
}

function userToolResult(...ids: string[]): AgentMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
    },
  };
}

function streamToolResult(id: string): AgentMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_result', tool_use_id: id, content: 'ok' },
    },
  };
}

function assistantText(text: string): AgentMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function referenceHasMatchingToolResult(message: AgentMessage, toolUseId: string): boolean {
  const content = message.message?.content;
  if (
    Array.isArray(content) &&
    content.some((item) => item.type === 'tool_result' && item.tool_use_id === toolUseId)
  ) {
    return true;
  }
  return (
    message.type === 'stream_event' &&
    message.event?.type === 'content_block_start' &&
    message.event.content_block.type === 'tool_result' &&
    message.event.content_block.tool_use_id === toolUseId
  );
}

/** The pre-index implementation: walk back to the first entry that answers or starts the tool. */
function referenceScan(store: SessionStore, toolUseId: string): ChatMessage | undefined {
  for (let index = store.transcript.length - 1; index >= 0; index -= 1) {
    const entry = store.transcript[index];
    if (entry?.source !== 'agent' || !entry.message) {
      continue;
    }
    if (referenceHasMatchingToolResult(entry.message, toolUseId)) {
      return undefined;
    }
    if (entry.message.type !== 'stream_event') {
      continue;
    }
    const event = entry.message.event;
    if (event?.type !== 'content_block_start') {
      continue;
    }
    if (event.content_block.type === 'tool_use' && event.content_block.id === toolUseId) {
      return entry;
    }
  }
  return undefined;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TOOL_IDS = ['t0', 't1', 't2', 't3', 't4'];

function randomAgentMessage(random: () => number, pick: <T>(items: T[]) => T): AgentMessage {
  const roll = random();
  if (roll < 0.4) {
    return toolUse(pick(TOOL_IDS), { step: Math.floor(random() * 100) });
  }
  if (roll < 0.6) {
    return userToolResult(pick(TOOL_IDS));
  }
  if (roll < 0.7) {
    return userToolResult(pick(TOOL_IDS), pick(TOOL_IDS));
  }
  if (roll < 0.8) {
    return streamToolResult(pick(TOOL_IDS));
  }
  return assistantText(`text-${Math.floor(random() * 1000)}`);
}

function applyRandomOperation(
  store: SessionStore,
  random: () => number,
  pick: <T>(items: T[]) => T,
  step: number
): void {
  const roll = random();
  if (roll < 0.55) {
    appendClaudeEvent(store, randomAgentMessage(random, pick), appendOptions);
    return;
  }
  if (roll < 0.7) {
    // Out-of-order insert, sometimes an agent entry that starts or answers a tool.
    upsertTranscriptMessage(store, {
      id: `inserted-${step}`,
      source: random() < 0.5 ? 'agent' : 'user',
      message: randomAgentMessage(random, pick),
      text: 'inserted',
      timestamp: '2026-02-01T00:00:00.000Z',
      order: random() * Math.max(1, store.nextOrder),
    });
    return;
  }
  const existing = store.transcript.length > 0 ? pick(store.transcript) : undefined;
  if (!existing) {
    return;
  }
  if (roll < 0.8) {
    removeTranscriptMessageById(store, existing.id);
    return;
  }
  if (roll < 0.9) {
    // Same id: replace in place (same order) or move (new order).
    upsertTranscriptMessage(store, {
      ...existing,
      source: 'agent',
      message: randomAgentMessage(random, pick),
      order: random() < 0.5 ? existing.order : random() * Math.max(1, store.nextOrder),
    });
    return;
  }
  if (roll < 0.95) {
    store.transcript = [...store.transcript].sort(messageSort);
    rebuildTranscriptIndex(store);
    return;
  }
  // A write that bypasses the helpers must still be observed.
  store.transcript.push({
    id: `bypass-${step}`,
    source: 'agent',
    message: randomAgentMessage(random, pick),
    timestamp: '2026-02-01T00:00:00.000Z',
    order: store.nextOrder,
  });
  store.transcriptIdToIndex.set(`bypass-${step}`, store.transcript.length - 1);
}

describe('findPersistedToolUseStart', () => {
  it('matches the linear scan across randomized transcript histories', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = createRandom(seed);
      const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
      const store = createStore();
      for (let step = 0; step < 300; step += 1) {
        applyRandomOperation(store, random, pick, step);
        for (const toolUseId of TOOL_IDS) {
          expect(
            findPersistedToolUseStart(store, toolUseId),
            `seed ${seed} step ${step} ${toolUseId}`
          ).toBe(referenceScan(store, toolUseId));
        }
      }
    }
  });

  it('enriches a pending start in place and starts a new entry after its result', () => {
    const store = createStore();
    const firstOrder = appendClaudeEvent(store, toolUse('t1'), appendOptions);
    const enrichedOrder = appendClaudeEvent(store, toolUse('t1', { cmd: 'ls' }), appendOptions);
    expect(enrichedOrder).toBe(firstOrder);
    expect(store.transcript).toHaveLength(1);
    expect(findPersistedToolUseStart(store, 't1')?.message).toEqual(toolUse('t1', { cmd: 'ls' }));

    appendClaudeEvent(store, userToolResult('t1'), appendOptions);
    expect(findPersistedToolUseStart(store, 't1')).toBeUndefined();

    const restartOrder = appendClaudeEvent(store, toolUse('t1'), appendOptions);
    expect(restartOrder).not.toBe(firstOrder);
    expect(findPersistedToolUseStart(store, 't1')?.order).toBe(restartOrder);
  });

  it('ignores a result inserted before the start and re-exposes a start whose result is removed', () => {
    const store = createStore();
    appendClaudeEvent(store, assistantText('a'), appendOptions);
    appendClaudeEvent(store, toolUse('t1'), appendOptions);
    upsertTranscriptMessage(store, {
      id: 'early-result',
      source: 'agent',
      message: streamToolResult('t1'),
      timestamp: '2026-02-01T00:00:00.000Z',
      order: 0.5,
    });
    expect(findPersistedToolUseStart(store, 't1')?.order).toBe(1);

    appendClaudeEvent(store, userToolResult('t1'), appendOptions);
    expect(findPersistedToolUseStart(store, 't1')).toBeUndefined();

    const resultEntry = store.transcript.at(-1);
    expect(resultEntry).toBeDefined();
    removeTranscriptMessageById(store, resultEntry?.id ?? '');
    expect(findPersistedToolUseStart(store, 't1')?.order).toBe(1);
  });

  it('falls back to the scan when one entry object appears twice', () => {
    const store = createStore();
    appendClaudeEvent(store, toolUse('t1'), appendOptions);
    const start = store.transcript[0];
    expect(start).toBeDefined();
    appendClaudeEvent(store, userToolResult('t1'), appendOptions);
    if (start) {
      store.transcript.push(start);
    }
    expect(findPersistedToolUseStart(store, 't1')).toBe(start);
    expect(findPersistedToolUseStart(store, 't1')).toBe(referenceScan(store, 't1'));
  });

  it('sees entries in a transcript replaced wholesale', () => {
    const store = createStore();
    appendClaudeEvent(store, toolUse('t1'), appendOptions);
    expect(findPersistedToolUseStart(store, 't1')).toBeDefined();

    store.transcript = [];
    rebuildTranscriptIndex(store);
    expect(findPersistedToolUseStart(store, 't1')).toBeUndefined();

    appendClaudeEvent(store, toolUse('t2'), appendOptions);
    expect(findPersistedToolUseStart(store, 't2')).toBe(store.transcript[0]);
  });
});
