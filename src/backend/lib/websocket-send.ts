/**
 * Safe WebSocket send helper for fan-out broadcasters.
 *
 * `ws.send` can throw synchronously (e.g. the socket transitions to CLOSING
 * between a readyState check and the send). Broadcasters iterating over many
 * clients must not let one bad socket drop the message for the remaining
 * clients or propagate the error back into the code path that triggered the
 * broadcast.
 */

import { constants as bufferConstants } from 'node:buffer';
import type { WebSocket } from 'ws';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { toError } from './error-utils';

interface SendErrorLogger {
  error(message: string, error: Error): void;
}

interface StreamSendLogger extends SendErrorLogger {
  warn(message: string, data: Record<string, unknown>): void;
}

export const MAX_WEBSOCKET_STREAM_BUFFERED_BYTES = 1024 * 1024;

const congestedStreamSockets = new WeakSet<WebSocket>();

/**
 * Send a message on a WebSocket, swallowing (and logging) synchronous send
 * errors. Returns true if the message was sent, false if the socket was not
 * open or the send threw.
 */
export function safeSend(
  ws: WebSocket,
  message: string,
  logger: SendErrorLogger,
  description = 'WebSocket message'
): boolean {
  if (ws.readyState !== WS_READY_STATE.OPEN) {
    return false;
  }
  try {
    ws.send(message);
    return true;
  } catch (error) {
    logger.error(`Failed to send ${description}`, toError(error));
    return false;
  }
}

/**
 * Send high-volume stream output without allowing a slow socket to accumulate
 * unbounded queued data. Output is dropped above the buffered amount threshold,
 * with one warning per congestion window.
 */
export function sendStreamOutput(
  ws: WebSocket,
  message: string,
  logger: StreamSendLogger,
  description = 'WebSocket stream output'
): boolean {
  if (ws.readyState !== WS_READY_STATE.OPEN) {
    return false;
  }

  if (ws.bufferedAmount + Buffer.byteLength(message) > MAX_WEBSOCKET_STREAM_BUFFERED_BYTES) {
    if (!congestedStreamSockets.has(ws)) {
      congestedStreamSockets.add(ws);
      logger.warn(`Dropping ${description} because WebSocket send buffer is congested`, {
        bufferedAmount: ws.bufferedAmount,
        maxBufferedAmount: MAX_WEBSOCKET_STREAM_BUFFERED_BYTES,
      });
    }
    return false;
  }

  congestedStreamSockets.delete(ws);

  try {
    ws.send(message, (error) => {
      if (error) {
        logger.error(`Failed to send ${description}`, toError(error));
      }
    });
    return true;
  } catch (error) {
    logger.error(`Failed to send ${description}`, toError(error));
    return false;
  }
}

/** Ordinary queued data is bounded independently of a full baseline/replay. */
export const MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES = 1024 * 1024;
// JSON.stringify already requires a Node string. Three UTF-8 bytes per UTF-16
// code unit covers every string it can produce, without imposing a new history
// or project-size limit that would make the same baseline fail every reconnect.
export const MAX_WEBSOCKET_STATEFUL_FRAME_BYTES = 3 * bufferConstants.MAX_STRING_LENGTH;
export const WEBSOCKET_RETIRE_DEADLINE_MS = 5000;

export interface StatefulSendOptions {
  allowLargeFrame?: boolean;
}

const retiredSockets = new WeakSet<WebSocket>();
const largeFrames = new WeakMap<
  WebSocket,
  { bytes: number; queuedBytes: number; cleanup: () => void }
>();

function retireStatefulViewer(ws: WebSocket, logger: SendErrorLogger): void {
  if (retiredSockets.has(ws)) {
    return;
  }
  retiredSockets.add(ws);
  largeFrames.get(ws)?.cleanup();
  if (ws.readyState === WS_READY_STATE.CLOSED) {
    return;
  }
  const cleanup = () => {
    clearTimeout(deadline);
    ws.off('close', cleanup);
  };
  const terminate = () => {
    cleanup();
    if (ws.readyState !== WS_READY_STATE.CLOSED) {
      try {
        ws.terminate();
      } catch (error) {
        logger.error('Failed to terminate retired WebSocket viewer', toError(error));
      }
    }
  };
  const deadline = setTimeout(terminate, WEBSOCKET_RETIRE_DEADLINE_MS);
  deadline.unref();
  ws.once('close', cleanup);
  try {
    ws.close(1013, 'Viewer fell behind; reconnect for current state');
  } catch (error) {
    logger.error('Failed to close retired WebSocket viewer', toError(error));
    terminate();
  }
}

/**
 * Stateful channels must reconnect after any missed write. Never reuse the
 * dropping stream policy for deltas. A single authoritative frame may exceed
 * the ordinary backlog budget only on an empty socket. Its flush callback
 * releases that allowance; follow-up metadata/deltas get a separate budget.
 */
export function sendStateful(
  ws: WebSocket,
  message: string,
  logger: SendErrorLogger,
  description = 'stateful WebSocket message',
  options: StatefulSendOptions = {}
): boolean {
  if (retiredSockets.has(ws) || ws.readyState !== WS_READY_STATE.OPEN) {
    return false;
  }
  if (ws.bufferedAmount === 0) {
    largeFrames.get(ws)?.cleanup();
  }
  const bytes = Buffer.byteLength(message);
  let large = largeFrames.get(ws);
  const isLargeFrame = bytes > MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES;
  const allowLarge = options.allowLargeFrame && ws.bufferedAmount === 0;
  if (
    bytes > MAX_WEBSOCKET_STATEFUL_FRAME_BYTES ||
    (isLargeFrame && !allowLarge) ||
    (!allowLarge &&
      (ws.bufferedAmount + bytes > MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES + (large?.bytes ?? 0) ||
        (large && large.queuedBytes + bytes > MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES)))
  ) {
    retireStatefulViewer(ws, logger);
    return false;
  }
  if (isLargeFrame) {
    const cleanup = () => {
      if (largeFrames.get(ws) === large) {
        largeFrames.delete(ws);
      }
      ws.off('close', cleanup);
    };
    large = { bytes, queuedBytes: 0, cleanup };
    largeFrames.set(ws, large);
    ws.once('close', cleanup);
  } else if (large) {
    large.queuedBytes += bytes;
  }
  const ownLargeFrame = isLargeFrame ? large : undefined;
  try {
    ws.send(message, (error) => {
      ownLargeFrame?.cleanup();
      if (error) {
        logger.error(`Failed to send ${description}`, toError(error));
        retireStatefulViewer(ws, logger);
      }
    });
    return !retiredSockets.has(ws);
  } catch (error) {
    logger.error(`Failed to send ${description}`, toError(error));
    retireStatefulViewer(ws, logger);
    return false;
  }
}
