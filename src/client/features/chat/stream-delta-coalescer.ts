import { useEffect, useState } from 'react';
import { isStreamEventMessage } from '@/lib/chat-protocol';
import type { ChatAction, StreamDeltaAction } from './reducer';

/**
 * Upper bound on how long a buffered delta waits when no animation frame
 * arrives. Hidden tabs do not run animation frames, and browsers may throttle
 * this timer there; either way the buffer is always drained.
 */
export const STREAM_DELTA_FALLBACK_FLUSH_MS = 50;

/**
 * A delta arriving this long after the previous one starts a new burst, such as
 * the first token of a reply, and is dispatched without waiting for a frame.
 * The backend flushes every 25 ms, so a steady stream never reaches this gap.
 */
export const STREAM_DELTA_IDLE_MS = 250;

/** Runs a callback once, at the next frame or after the fallback, and returns a cancel function. */
export type FrameScheduler = (callback: () => void) => () => void;

export function createFrameScheduler(
  fallbackMs: number = STREAM_DELTA_FALLBACK_FLUSH_MS
): FrameScheduler {
  return (callback) => {
    let frameId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
    const run = () => {
      cancel();
      callback();
    };
    if (typeof requestAnimationFrame === 'function') {
      frameId = requestAnimationFrame(run);
    }
    timerId = setTimeout(run, fallbackMs);
    return cancel;
  };
}

/**
 * Streamed text, thinking and tool-input updates. Other agent messages, such as
 * block starts, results and tool calls, change structure and are not delayed.
 */
export function isStreamDeltaAction(action: ChatAction): action is StreamDeltaAction {
  switch (action.type) {
    case 'WS_ASSISTANT_TEXT_DELTA':
    case 'TOOL_INPUT_UPDATE':
      return true;
    case 'WS_AGENT_MESSAGE': {
      const message = action.payload.message;
      return isStreamEventMessage(message) && message.event.type === 'content_block_delta';
    }
    default:
      return false;
  }
}

export interface StreamDeltaCoalescerOptions {
  scheduleFrame?: FrameScheduler;
  now?: () => number;
}

export interface StreamDeltaCoalescer {
  /** Forwards an action, buffering stream deltas until the next frame. */
  dispatch: (action: ChatAction) => void;
  /** Forwards buffered deltas now and cancels the pending frame. */
  flush: () => void;
}

/**
 * Coalesces stream deltas so the reducer commits at most once per frame while
 * a reply streams.
 *
 * A delta that follows a pause of `STREAM_DELTA_IDLE_MS` with nothing buffered
 * is forwarded immediately, so a new reply is not delayed. Other deltas are
 * buffered and forwarded together as one `STREAM_DELTA_BATCH` at the next
 * animation frame (or the fallback timer). Any other action first forwards the
 * buffer, so the reducer receives every action in arrival order.
 */
export function createStreamDeltaCoalescer(
  forward: (action: ChatAction) => void,
  options: StreamDeltaCoalescerOptions = {}
): StreamDeltaCoalescer {
  const scheduleFrame = options.scheduleFrame ?? createFrameScheduler();
  const now = options.now ?? (() => performance.now());
  let buffer: StreamDeltaAction[] = [];
  let cancelFrame: (() => void) | null = null;
  let lastDeltaAt = Number.NEGATIVE_INFINITY;

  const forwardBuffer = () => {
    if (buffer.length === 0) {
      return;
    }
    const actions = buffer;
    buffer = [];
    const [only] = actions;
    forward(
      actions.length === 1 && only ? only : { type: 'STREAM_DELTA_BATCH', payload: { actions } }
    );
  };

  const flush = () => {
    cancelFrame?.();
    cancelFrame = null;
    forwardBuffer();
  };

  const onFrame = () => {
    cancelFrame = null;
    forwardBuffer();
  };

  const dispatch = (action: ChatAction) => {
    if (!isStreamDeltaAction(action)) {
      flush();
      forward(action);
      return;
    }
    const arrivedAt = now();
    const startsBurst = arrivedAt - lastDeltaAt >= STREAM_DELTA_IDLE_MS;
    lastDeltaAt = arrivedAt;
    if (startsBurst && buffer.length === 0) {
      forward(action);
      return;
    }
    buffer.push(action);
    cancelFrame ??= scheduleFrame(onFrame);
  };

  return { dispatch, flush };
}

/**
 * Wraps a stable chat reducer dispatch with a `StreamDeltaCoalescer`. Route
 * every dispatch for the reducer through the returned function so buffered
 * deltas always precede later actions, such as session switches and user
 * sends. Buffered deltas are forwarded when the component unmounts.
 */
export function useStreamDeltaCoalescedDispatch(
  dispatch: (action: ChatAction) => void,
  options?: StreamDeltaCoalescerOptions
): (action: ChatAction) => void {
  const [coalescer] = useState(() => createStreamDeltaCoalescer(dispatch, options));
  useEffect(() => coalescer.flush, [coalescer]);
  return coalescer.dispatch;
}
