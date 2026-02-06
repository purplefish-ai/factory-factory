import { useCallback, useRef, useState } from 'react';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';

// =============================================================================
// Types
// =============================================================================

type WorkspaceStatus = 'NEW' | 'PROVISIONING' | 'READY' | 'FAILED' | 'ARCHIVED';

interface InitLogsMessage {
  type: 'connected' | 'output' | 'status';
  data?: string;
  status?: WorkspaceStatus;
  errorMessage?: string | null;
}

interface UseInitLogsResult {
  connected: boolean;
  output: string;
  status: WorkspaceStatus | null;
  errorMessage: string | null;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to manage the init logs WebSocket connection.
 * Returns connection status, output data, and workspace status for use
 * in the Init Logs tab.
 *
 * The WebSocket connection streams real-time output from the startup script
 * during workspace initialization.
 *
 * Uses useWebSocketTransport for automatic reconnection with exponential backoff.
 */
export function useInitLogs(workspaceId: string): UseInitLogsResult {
  const [output, setOutput] = useState<string>('');
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const outputEndRef = useRef<HTMLDivElement | null>(null);

  const url = buildWebSocketUrl('/init-logs', { workspaceId });

  const scrollToBottom = useCallback(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleMessage = useCallback(
    (data: unknown) => {
      const message = data as InitLogsMessage;

      if (message.type === 'output' && message.data) {
        setOutput((prev) => prev + message.data);
        // Scroll to bottom after a short delay to allow render
        setTimeout(scrollToBottom, 10);
      } else if (message.type === 'status') {
        if (message.status) {
          setStatus(message.status);
        }
        if (message.errorMessage !== undefined) {
          setErrorMessage(message.errorMessage);
        }
      }
    },
    [scrollToBottom]
  );

  const handleConnected = useCallback(() => {
    // Don't clear output on reconnect - we'll receive the full buffer from the server
  }, []);

  const handleDisconnected = useCallback(() => {
    // Could add a disconnection indicator if needed
  }, []);

  const { connected } = useWebSocketTransport({
    url,
    onMessage: handleMessage,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
  });

  return { connected, output, status, errorMessage, outputEndRef };
}
