/**
 * Safe WebSocket send helper for fan-out broadcasters.
 *
 * `ws.send` can throw synchronously (e.g. the socket transitions to CLOSING
 * between a readyState check and the send). Broadcasters iterating over many
 * clients must not let one bad socket drop the message for the remaining
 * clients or propagate the error back into the code path that triggered the
 * broadcast.
 */

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

  if (ws.bufferedAmount > MAX_WEBSOCKET_STREAM_BUFFERED_BYTES) {
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
