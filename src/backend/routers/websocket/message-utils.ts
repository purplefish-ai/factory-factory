import type { WebSocket } from 'ws';
import type { z } from 'zod';
import { WS_READY_STATE } from '@/backend/constants/websocket';

export function toMessageString(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString();
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString();
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString();
  }
  return String(data);
}

/**
 * Parse an incoming WebSocket message against a zod schema. Returns the
 * parsed message, or null (after a warn log) when the payload is not valid
 * JSON or fails schema validation.
 */
export function parseWebSocketMessage<TSchema extends z.ZodType>(
  schema: TSchema,
  data: unknown,
  logger: { warn(message: string, meta?: Record<string, unknown>): void },
  description: string,
  meta?: Record<string, unknown>
): z.infer<TSchema> | null {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(toMessageString(data));
  } catch (error) {
    logger.warn(`Invalid ${description} format`, {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const parseResult = schema.safeParse(rawMessage);
  if (!parseResult.success) {
    logger.warn(`Invalid ${description} format`, {
      ...meta,
      errors: parseResult.error.issues,
    });
    return null;
  }

  return parseResult.data as z.infer<TSchema>;
}

/**
 * Send a `{ type: 'error' }` payload to the client if the socket is open.
 * `requestId` is omitted from the payload when not provided.
 */
export function sendJsonError(ws: WebSocket, message: string, requestId?: string): void {
  if (ws.readyState === WS_READY_STATE.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message, requestId }));
  }
}
