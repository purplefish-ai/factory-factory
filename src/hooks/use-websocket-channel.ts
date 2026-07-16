import { useCallback } from 'react';
import type { z } from 'zod';
import {
  type UseWebSocketTransportReturn,
  useWebSocketTransport,
  type WebSocketQueuePolicy,
} from '@/hooks/use-websocket-transport';

export interface UseWebSocketChannelOptions<TSchema extends z.ZodType> {
  /** WebSocket URL to connect to. Set to null to defer connection. */
  url: string | null;
  /** Zod schema used to validate every inbound message. */
  schema: TSchema;
  /** Called with each schema-valid message; invalid messages are silently dropped. */
  onMessage: (message: z.infer<TSchema>) => void;
  /** Called when connection is established. */
  onConnected?: () => void;
  /** Called when connection is lost. */
  onDisconnected?: () => void;
  /** How to handle outbound messages while disconnected. @default 'replay' */
  queuePolicy?: WebSocketQueuePolicy;
}

/**
 * Schema-validating wrapper over useWebSocketTransport.
 *
 * Centralizes the per-consumer parse boilerplate: every inbound message is
 * validated against `schema` and delivered typed to `onMessage`; messages
 * that fail validation are silently dropped.
 */
export function useWebSocketChannel<TSchema extends z.ZodType>(
  options: UseWebSocketChannelOptions<TSchema>
): UseWebSocketTransportReturn {
  const { url, schema, onMessage, onConnected, onDisconnected, queuePolicy } = options;

  const handleMessage = useCallback(
    (data: unknown) => {
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        return;
      }
      onMessage(parsed.data);
    },
    [schema, onMessage]
  );

  return useWebSocketTransport({
    url,
    onMessage: handleMessage,
    onConnected,
    onDisconnected,
    queuePolicy,
  });
}
