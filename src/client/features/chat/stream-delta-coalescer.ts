import { useEffect, useState } from 'react';
import { isStreamEventMessage } from '@/lib/chat-protocol';
import type { ChatAction, StreamDeltaAction } from './reducer';

/**
 * Stream deltas reach the reducer at most once per window, so a streaming
 * reply commits about ten times a second instead of once per 25 ms delta.
 * Streaming Markdown renders directly from these commits.
 */
export const STREAM_DELTA_WINDOW_MS = 100;

/** Runs `callback` once after `delayMs` and returns a cancel function. */
export type DeltaTimer = (callback: () => void, delayMs: number) => () => void;

const setDeltaTimer: DeltaTimer = (callback, delayMs) => {
  const timerId = setTimeout(callback, delayMs);
  return () => clearTimeout(timerId);
};

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
  windowMs?: number;
  setTimer?: DeltaTimer;
  now?: () => number;
}

export interface StreamDeltaCoalescer {
  /** Forwards an action, buffering stream deltas until the window closes. */
  dispatch: (action: ChatAction) => void;
  /** Forwards buffered deltas now and cancels the pending timer. */
  flush: () => void;
}

/**
 * Coalesces stream deltas so the reducer receives them at most once per
 * `windowMs`, measured from the last time deltas were forwarded.
 *
 * A delta that arrives at least `windowMs` after the last forwarded delta,
 * with nothing buffered, is forwarded immediately, so a reply's first token is
 * not delayed. Other deltas are buffered and forwarded together, as one
 * `STREAM_DELTA_BATCH` when more than one is pending, once the window closes.
 * No delta waits longer than `windowMs`. Any other action first forwards the
 * buffer, so the reducer receives every action in arrival order.
 *
 * The window is a timer rather than an animation frame, so hidden tabs drain
 * the buffer too, at whatever rate the browser throttles timers to.
 */
export function createStreamDeltaCoalescer(
  forward: (action: ChatAction) => void,
  options: StreamDeltaCoalescerOptions = {}
): StreamDeltaCoalescer {
  const windowMs = options.windowMs ?? STREAM_DELTA_WINDOW_MS;
  const setTimer = options.setTimer ?? setDeltaTimer;
  const now = options.now ?? (() => performance.now());
  let buffer: StreamDeltaAction[] = [];
  let cancelTimer: (() => void) | null = null;
  let lastForwardAt = Number.NEGATIVE_INFINITY;

  const forwardBuffer = () => {
    if (buffer.length === 0) {
      return;
    }
    const actions = buffer;
    buffer = [];
    lastForwardAt = now();
    const [only] = actions;
    forward(
      actions.length === 1 && only ? only : { type: 'STREAM_DELTA_BATCH', payload: { actions } }
    );
  };

  const flush = () => {
    cancelTimer?.();
    cancelTimer = null;
    forwardBuffer();
  };

  const onTimer = () => {
    cancelTimer = null;
    forwardBuffer();
  };

  const dispatch = (action: ChatAction) => {
    if (!isStreamDeltaAction(action)) {
      flush();
      forward(action);
      return;
    }
    const arrivedAt = now();
    const waitMs = lastForwardAt + windowMs - arrivedAt;
    if (buffer.length === 0 && waitMs <= 0) {
      lastForwardAt = arrivedAt;
      forward(action);
      return;
    }
    buffer.push(action);
    cancelTimer ??= setTimer(onTimer, Math.max(0, waitMs));
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
