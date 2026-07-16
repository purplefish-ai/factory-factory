import { useCallback, useRef, useState } from 'react';
import { z } from 'zod';
import { useWebSocketChannel } from '@/hooks/use-websocket-channel';
import { buildWebSocketUrl } from '@/lib/websocket-config';
import {
  appendToRollingOutput,
  WORKSPACE_LOG_OUTPUT_MAX_CHARS,
  WORKSPACE_LOG_TRUNCATION_MARKER,
} from './rolling-output';

const LogStreamMessageSchema = z.object({
  type: z.literal('output'),
  data: z.string().optional(),
});

const LOG_ROLLING_OUTPUT_OPTIONS = {
  maxChars: WORKSPACE_LOG_OUTPUT_MAX_CHARS,
  truncationMarker: WORKSPACE_LOG_TRUNCATION_MARKER,
};

// =============================================================================
// Types
// =============================================================================

export type LogStreamEndpoint = '/dev-logs' | '/post-run-logs';

export interface UseLogStreamResult {
  connected: boolean;
  hasDisconnected: boolean;
  output: string;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to manage a push-only log WebSocket connection (dev logs or post-run
 * logs). Returns connection status and output data for use in both the tab
 * indicator and the DevLogsPanel content.
 *
 * Note: The WebSocket connection remains active even when the corresponding
 * tab is not visible. This is intentional to:
 * 1. Show the connection status indicator in the tab bar
 * 2. Buffer log output so users don't miss messages while viewing Terminal
 *
 * Uses useWebSocketChannel for schema validation and automatic reconnection
 * with exponential backoff.
 */
export function useLogStream(endpoint: LogStreamEndpoint, workspaceId: string): UseLogStreamResult {
  const [output, setOutput] = useState<string>('');
  const [hasDisconnected, setHasDisconnected] = useState(false);
  const outputEndRef = useRef<HTMLDivElement | null>(null);

  const url = buildWebSocketUrl(endpoint, { workspaceId });

  const scrollToBottom = useCallback(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleMessage = useCallback(
    (message: z.infer<typeof LogStreamMessageSchema>) => {
      if (message.data) {
        setOutput((prev) =>
          appendToRollingOutput(prev, message.data ?? '', LOG_ROLLING_OUTPUT_OPTIONS)
        );
        // Scroll to bottom after a short delay to allow render
        setTimeout(scrollToBottom, 10);
      }
    },
    [scrollToBottom]
  );

  const handleConnected = useCallback(() => {
    setHasDisconnected(false);
    setOutput((prev) =>
      appendToRollingOutput(
        prev,
        prev ? 'Reconnected!\n\n' : 'Connected!\n\n',
        LOG_ROLLING_OUTPUT_OPTIONS
      )
    );
  }, []);

  const handleDisconnected = useCallback(() => {
    setHasDisconnected(true);
    setOutput((prev) =>
      appendToRollingOutput(prev, 'Disconnected. Reconnecting...\n', LOG_ROLLING_OUTPUT_OPTIONS)
    );
  }, []);

  const { connected } = useWebSocketChannel({
    url,
    schema: LogStreamMessageSchema,
    onMessage: handleMessage,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
    queuePolicy: 'drop',
  });

  return { connected, hasDisconnected, output, outputEndRef };
}
