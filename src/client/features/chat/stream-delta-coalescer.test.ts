// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocketMessage } from '@/lib/chat-protocol';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';
import { parseChatServerMessage } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
import { type ChatAction, type ChatState, chatReducer, createInitialChatState } from './reducer';
import {
  createFrameScheduler,
  createStreamDeltaCoalescer,
  type FrameScheduler,
  isStreamDeltaAction,
  STREAM_DELTA_FALLBACK_FLUSH_MS,
  STREAM_DELTA_IDLE_MS,
} from './stream-delta-coalescer';
import { createToolInputAccumulatorState } from './streaming-utils';
import { useChatTransport } from './use-chat-transport';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// Helpers
// =============================================================================

function createManualFrames() {
  const pending = new Set<() => void>();
  const scheduleFrame: FrameScheduler = (callback) => {
    const entry = () => callback();
    pending.add(entry);
    return () => pending.delete(entry);
  };
  return {
    scheduleFrame,
    runFrame: () => {
      const callbacks = [...pending];
      pending.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    get pending() {
      return pending.size;
    },
  };
}

function TransportHarness({
  dispatch,
  result,
}: {
  dispatch: (action: ChatAction) => void;
  result: { handleMessage?: (message: WebSocketMessage) => void };
}) {
  result.handleMessage = useChatTransport({
    dispatch,
    stateRef: { current: createInitialChatState() },
    toolInputAccumulatorRef: { current: createToolInputAccumulatorState() },
  }).handleMessage;
  return null;
}

function renderTransport(dispatch: (action: ChatAction) => void) {
  const root = createRoot(document.createElement('div'));
  const result: { handleMessage?: (message: WebSocketMessage) => void } = {};
  flushSync(() => root.render(createElement(TransportHarness, { dispatch, result })));
  const { handleMessage } = result;
  if (!handleMessage) {
    throw new Error('Expected the transport harness to expose handleMessage');
  }
  return { handleMessage, unmount: () => flushSync(() => root.unmount()) };
}

const textDelta = (order: number, offset: number, text: string): ChatAction => ({
  type: 'WS_ASSISTANT_TEXT_DELTA',
  payload: { messageId: `assistant-${order}`, order, offset, text },
});

// =============================================================================
// Randomised wire sequences
// =============================================================================

/** A seeded pseudo-random generator, so failing sequences reproduce by seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A wire frame, an action dispatched outside the transport, or an animation frame. */
type CoalescingStep =
  | { kind: 'message'; message: WebSocketMessage }
  | { kind: 'local'; action: ChatAction }
  | { kind: 'frame' };

const WORDS = ['alpha ', 'beta ', 'gamma ', 'delta ', '`code` ', '**bold** ', '\n\n', '- item\n'];

const streamEvent = (event: unknown, order: number): WebSocketMessage =>
  ({ type: 'agent_message', data: { type: 'stream_event', event }, order }) as never;

function runtime(phase: 'running' | 'idle', at: number) {
  return {
    phase,
    processState: 'alive' as const,
    activity: phase === 'running' ? ('WORKING' as const) : ('IDLE' as const),
    updatedAt: new Date(Date.UTC(2026, 10, 9, 0, 0, at)).toISOString(),
  };
}

/**
 * Builds a plausible sequence of validated wire events for one session: text,
 * thinking and tool-input streams (including overlapping, gapped, stale and
 * repeated deltas) interleaved with runtime, notice, message and local actions.
 */
class CoalescingStepGenerator {
  private readonly steps: CoalescingStep[] = [];
  private readonly random: () => number;
  private order = 0;
  private text: { order: number; value: string } | null = null;
  private thinkingIndex = 0;
  private thinkingOrder = 0;
  private toolIndex = 100;
  private tool: { index: number; chunks: string[] } | null = null;

  constructor(seed: number) {
    this.random = mulberry32(seed);
  }

  generate(length: number): CoalescingStep[] {
    const frameChance = this.random();
    const weighted: [number, () => void][] = [
      [30, () => this.textDelta()],
      [6, () => this.thinkingStart()],
      [20, () => this.thinkingDelta()],
      [6, () => this.toolStart()],
      [10, () => this.toolInput()],
      [4, () => this.runtimeUpdate('running')],
      [3, () => this.runtimeUpdate('idle')],
      [5, () => this.notice()],
      [3, () => this.assistantMessage()],
      [3, () => this.localAction()],
    ];
    const total = weighted.reduce((sum, [weight]) => sum + weight, 0);
    while (this.steps.length < length) {
      let roll = this.random() * total;
      const entry = weighted.find(([weight]) => {
        roll -= weight;
        return roll < 0;
      });
      entry?.[1]();
      if (this.random() < frameChance) {
        this.steps.push({ kind: 'frame' });
      }
    }
    return this.steps;
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)] as T;
  }

  private push(message: WebSocketMessage): void {
    const parsed = parseChatServerMessage(
      this.random() < 0.3 ? { type: 'session_delta', data: message } : message
    );
    if (!parsed.success) {
      throw new Error(`Generated an invalid frame: ${JSON.stringify(message)}`);
    }
    this.steps.push({ kind: 'message', message: parsed.message });
  }

  private pushText(order: number, offset: number, text: string): void {
    this.push({
      type: 'assistant_text_delta',
      messageId: `assistant-${order}`,
      order,
      offset,
      text,
    });
  }

  private textDelta(): void {
    if (!this.text || this.random() < 0.1) {
      this.order += 1;
      this.text = { order: this.order, value: '' };
    }
    const text = this.text;
    const chunk = this.pick(WORDS);
    const variant = this.random();
    if (variant < 0.8) {
      this.pushText(text.order, text.value.length, chunk);
      text.value += chunk;
    } else if (variant < 0.9 && text.value.length > 0) {
      // Replayed overlap: resends the tail of the existing text plus new text.
      const overlap = Math.min(text.value.length, 3);
      this.pushText(text.order, text.value.length - overlap, text.value.slice(-overlap) + chunk);
      text.value += chunk;
    } else {
      // Gapped delta, which the reducer ignores.
      this.pushText(text.order, text.value.length + 5, chunk);
    }
  }

  private thinkingStart(): void {
    this.order += 1;
    this.thinkingIndex += 1;
    this.thinkingOrder = this.order;
    const block = { type: 'thinking', thinking: this.pick(WORDS) };
    this.push(
      streamEvent(
        { type: 'content_block_start', index: this.thinkingIndex, content_block: block },
        this.order
      )
    );
  }

  private thinkingDelta(): void {
    // Thinking deltas usually advance the order; some repeat or go stale.
    const variant = this.random();
    if (variant < 0.8) {
      this.order += 1;
      this.thinkingOrder = this.order;
    }
    const index = this.random() < 0.9 ? this.thinkingIndex : this.thinkingIndex + 1;
    const delta = { type: 'thinking_delta', thinking: this.pick(WORDS) };
    const order = variant < 0.9 ? this.thinkingOrder : Math.max(1, this.thinkingOrder - 2);
    this.push(streamEvent({ type: 'content_block_delta', index, delta }, order));
  }

  private toolStart(): void {
    this.order += 1;
    this.toolIndex += 1;
    const index = this.toolIndex;
    const json = JSON.stringify({ command: this.pick(WORDS).trim(), path: `src/${index}.ts` });
    const cut = 1 + Math.floor(this.random() * (json.length - 2));
    this.tool = { index, chunks: [json.slice(0, cut), json.slice(cut)] };
    const block = { type: 'tool_use', id: `tool-${index}`, name: 'Bash', input: {} };
    this.push(
      streamEvent({ type: 'content_block_start', index, content_block: block }, this.order)
    );
  }

  private toolInput(): void {
    const tool = this.tool;
    if (!tool) {
      return;
    }
    const chunk = tool.chunks.shift();
    if (chunk === undefined) {
      this.push(streamEvent({ type: 'content_block_stop', index: tool.index }, this.order));
      this.tool = null;
      return;
    }
    const delta = { type: 'input_json_delta', partial_json: chunk };
    this.push(streamEvent({ type: 'content_block_delta', index: tool.index, delta }, this.order));
  }

  private runtimeUpdate(phase: 'running' | 'idle'): void {
    this.push({ type: 'session_runtime_updated', sessionRuntime: runtime(phase, this.order) });
  }

  private notice(): void {
    this.push(
      this.random() < 0.6
        ? { type: 'task_notification', message: `Indexing ${this.order}` }
        : { type: 'error', message: `Provider error ${this.order}` }
    );
  }

  private assistantMessage(): void {
    this.order += 1;
    const content = [{ type: 'text' as const, text: `Full ${this.order}` }];
    this.push({
      type: 'agent_message',
      data: { type: 'assistant', message: { role: 'assistant', content } },
      order: this.order,
    });
  }

  private localAction(): void {
    this.steps.push({
      kind: 'local',
      action:
        this.random() < 0.7
          ? { type: 'SET_SETTINGS', payload: { ...DEFAULT_CHAT_SETTINGS, thinkingEnabled: true } }
          : { type: 'SESSION_SWITCH_START' },
    });
  }
}

/** Runs the steps with clocks and random ids pinned so generated ids and timestamps repeat. */
function runSteps(steps: CoalescingStep[], coalesce: boolean) {
  vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
  vi.spyOn(Math, 'random').mockImplementation(mulberry32(7));
  let uuid = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1;
    return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`;
  });

  let state: ChatState = createInitialChatState();
  let dispatches = 0;
  let batches = 0;
  const reduce = (action: ChatAction) => {
    dispatches += 1;
    if (action.type === 'STREAM_DELTA_BATCH') {
      batches += 1;
    }
    state = chatReducer(state, action);
  };
  const frames = createManualFrames();
  // The clock never advances, so only the very first delta skips the buffer.
  const coalescer = createStreamDeltaCoalescer(reduce, {
    scheduleFrame: frames.scheduleFrame,
    now: () => 0,
  });
  const dispatch = coalesce ? coalescer.dispatch : reduce;
  const transport = renderTransport(dispatch);

  for (const step of steps) {
    if (step.kind === 'message') {
      transport.handleMessage(step.message);
    } else if (step.kind === 'local') {
      dispatch(step.action);
    } else if (coalesce) {
      frames.runFrame();
    }
  }
  coalescer.flush();
  transport.unmount();
  vi.restoreAllMocks();
  return { state, dispatches, batches };
}

// =============================================================================
// Coalescing semantics
// =============================================================================

describe('stream delta coalescing', () => {
  it('reaches the same reducer state as dispatching every message', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let totalDirect = 0;
    let totalCoalesced = 0;
    let totalBatches = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const steps = new CoalescingStepGenerator(seed).generate(160);
      const direct = runSteps(steps, false);
      const coalesced = runSteps(steps, true);
      expect(coalesced.state, `seed ${seed}`).toEqual(direct.state);
      totalDirect += direct.dispatches;
      totalCoalesced += coalesced.dispatches;
      totalBatches += coalesced.batches;
    }
    // Guard against a vacuous comparison: the sequences must exercise batching.
    expect(totalBatches).toBeGreaterThan(500);
    expect(totalCoalesced).toBeLessThan(totalDirect);
  });

  it('classifies text, thinking and tool-input updates as deltas', () => {
    const streamMessage = (event: unknown): ChatAction =>
      ({
        type: 'WS_AGENT_MESSAGE',
        payload: { message: { type: 'stream_event', event }, order: 1 },
      }) as never;

    expect(isStreamDeltaAction(textDelta(1, 0, 'hi'))).toBe(true);
    expect(
      isStreamDeltaAction({ type: 'TOOL_INPUT_UPDATE', payload: { toolUseId: 't', input: {} } })
    ).toBe(true);
    expect(
      isStreamDeltaAction(
        streamMessage({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
        })
      )
    ).toBe(true);
    expect(
      isStreamDeltaAction(
        streamMessage({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        })
      )
    ).toBe(false);
    expect(isStreamDeltaAction({ type: 'SESSION_SWITCH_START' })).toBe(false);
  });

  it('dispatches the first delta of a burst immediately and buffers the rest', () => {
    const frames = createManualFrames();
    let clock = 0;
    const forward = vi.fn<(action: ChatAction) => void>();
    const coalescer = createStreamDeltaCoalescer(forward, {
      scheduleFrame: frames.scheduleFrame,
      now: () => clock,
    });

    coalescer.dispatch(textDelta(1, 0, 'Hel'));
    expect(forward).toHaveBeenCalledTimes(1);
    expect(frames.pending).toBe(0);

    clock = 25;
    coalescer.dispatch(textDelta(1, 3, 'lo'));
    clock = 40;
    coalescer.dispatch(textDelta(1, 5, '!'));
    expect(forward).toHaveBeenCalledTimes(1);
    expect(frames.pending).toBe(1);

    frames.runFrame();
    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward).toHaveBeenLastCalledWith({
      type: 'STREAM_DELTA_BATCH',
      payload: { actions: [textDelta(1, 3, 'lo'), textDelta(1, 5, '!')] },
    });

    // After a pause, the next reply's first token is not delayed either.
    clock = 40 + STREAM_DELTA_IDLE_MS;
    coalescer.dispatch(textDelta(2, 0, 'Next'));
    expect(forward).toHaveBeenCalledTimes(3);
    expect(forward).toHaveBeenLastCalledWith(textDelta(2, 0, 'Next'));
  });

  it('forwards buffered deltas before any other action and on flush', () => {
    const frames = createManualFrames();
    const forwarded: ChatAction[] = [];
    const coalescer = createStreamDeltaCoalescer((action) => forwarded.push(action), {
      scheduleFrame: frames.scheduleFrame,
      now: () => 0,
    });

    coalescer.dispatch(textDelta(1, 0, 'a'));
    coalescer.dispatch(textDelta(1, 1, 'b'));
    coalescer.dispatch({ type: 'SESSION_SWITCH_START' });
    expect(forwarded).toEqual([
      textDelta(1, 0, 'a'),
      textDelta(1, 1, 'b'),
      { type: 'SESSION_SWITCH_START' },
    ]);
    expect(frames.pending).toBe(0);

    coalescer.dispatch(textDelta(1, 2, 'c'));
    coalescer.flush();
    expect(forwarded.at(-1)).toEqual(textDelta(1, 2, 'c'));
    expect(frames.pending).toBe(0);
  });
});

// =============================================================================
// Dispatch rate with the browser frame scheduler
// =============================================================================

/**
 * Feeds one simulated second of deltas, arriving at `arrivals` (ms), through
 * the real frame scheduler on fake 16 ms animation frames. Returns how many
 * actions reached the reducer, which is the number of React commits.
 */
function countDispatches(arrivals: number[], { animationFrames = true } = {}) {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  });
  if (!animationFrames) {
    // A hidden tab runs no animation frames; only the fallback timer fires.
    vi.stubGlobal('requestAnimationFrame', undefined);
  }
  const forward = vi.fn<(action: ChatAction) => void>();
  const coalescer = createStreamDeltaCoalescer(forward, { scheduleFrame: createFrameScheduler() });
  let offset = 0;
  arrivals.forEach((at, index) => {
    const delta = textDelta(1, offset, `w${index} `);
    setTimeout(() => coalescer.dispatch(delta), at);
    offset += `w${index} `.length;
  });
  vi.advanceTimersByTime(1000 + STREAM_DELTA_FALLBACK_FLUSH_MS);
  const deltas = forward.mock.calls.reduce(
    (count, [action]) =>
      count + (action.type === 'STREAM_DELTA_BATCH' ? action.payload.actions.length : 1),
    0
  );
  vi.unstubAllGlobals();
  return { dispatches: forward.mock.calls.length, deltas };
}

describe('stream delta dispatch rate', () => {
  const second = (spacing: number, burst = 1) =>
    Array.from({ length: 40 }, (_, index) => Math.floor(index / burst) * spacing * burst);

  it('commits an evenly spaced 25 ms stream once per delta', () => {
    // Each 25 ms delta lands in its own 16 ms frame: nothing to merge.
    expect(countDispatches(second(25))).toEqual({ dispatches: 40, deltas: 40 });
  });

  it('commits once per frame when a busy main thread delivers deltas in bursts', () => {
    // 40 deltas per second delivered four at a time, as when a long commit holds
    // the main thread for 100 ms: 40 dispatches without coalescing.
    expect(countDispatches(second(25, 4))).toEqual({ dispatches: 11, deltas: 40 });
  });

  it('drains a hidden tab through the fallback timer', () => {
    const { dispatches, deltas } = countDispatches(second(25), { animationFrames: false });
    expect(deltas).toBe(40);
    expect(dispatches).toBeLessThanOrEqual(1 + 1000 / STREAM_DELTA_FALLBACK_FLUSH_MS);
  });
});
