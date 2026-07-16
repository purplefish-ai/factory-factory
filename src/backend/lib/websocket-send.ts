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
