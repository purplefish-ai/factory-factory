import { useCallback, useRef, useState } from 'react';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';

// =============================================================================
// Types
// =============================================================================

interface DevLogsMessage {
  type: 'output' | 'status';
  data?: string;
}

interface UseDevLogsResult {
  connected: boolean;
  output: string;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to manage the dev logs WebSocket connection.
 * Returns connection status and output data for use in both
 * the tab indicator and the DevLogsPanel content.
 *
 * Note: The WebSocket connection remains active even when the Dev Logs tab
 * is not visible. This is intentional to:
 * 1. Show the connection status indicator in the tab bar
 * 2. Buffer log output so users don't miss messages while viewing Terminal
 *
 * Uses useWebSocketTransport for automatic reconnection with exponential backoff.
 */
export function useDevLogs(workspaceId: string): UseDevLogsResult {
  const [output, setOutput] = useState<string>('');
  const outputEndRef = useRef<HTMLDivElement | null>(null);

  const url = buildWebSocketUrl('/dev-logs', { workspaceId });

  const scrollToBottom = useCallback(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleMessage = useCallback(
    (data: unknown) => {
      const message = data as DevLogsMessage;

      if (message.type === 'output' && message.data) {
        setOutput((prev) => prev + message.data);
        // Scroll to bottom after a short delay to allow render
        setTimeout(scrollToBottom, 10);
      } else if (message.type === 'status') {
        setOutput((prev) => `${prev}Status: ${JSON.stringify(message)}\n`);
      }
    },
    [scrollToBottom]
  );

  const handleConnected = useCallback(() => {
    setOutput((prev) => (prev ? `${prev}Reconnected!\n\n` : 'Connected!\n\n'));
  }, []);

  const handleDisconnected = useCallback(() => {
    setOutput((prev) => `${prev}Disconnected. Reconnecting...\n`);
  }, []);

  const { connected } = useWebSocketTransport({
    url,
    onMessage: handleMessage,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
  });

  return { connected, output, outputEndRef };
}
