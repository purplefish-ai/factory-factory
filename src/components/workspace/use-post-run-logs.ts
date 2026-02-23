import { useCallback, useRef, useState } from 'react';
import { z } from 'zod';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';

const PostRunLogsMessageSchema = z.object({
  type: z.literal('output'),
  data: z.string().optional(),
});

type PostRunLogsMessage = z.infer<typeof PostRunLogsMessageSchema>;

// =============================================================================
// Types
// =============================================================================

interface UsePostRunLogsResult {
  connected: boolean;
  output: string;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to manage the post-run logs WebSocket connection.
 * Returns connection status and output data for use in both
 * the tab indicator and the DevLogsPanel content.
 *
 * Uses useWebSocketTransport for automatic reconnection with exponential backoff.
 */
export function usePostRunLogs(workspaceId: string): UsePostRunLogsResult {
  const [output, setOutput] = useState<string>('');
  const outputEndRef = useRef<HTMLDivElement | null>(null);

  const url = buildWebSocketUrl('/post-run-logs', { workspaceId });

  const scrollToBottom = useCallback(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleMessage = useCallback(
    (data: unknown) => {
      const parsed = PostRunLogsMessageSchema.safeParse(data);
      if (!parsed.success) {
        return;
      }
      const message: PostRunLogsMessage = parsed.data;

      if (message.type === 'output' && message.data) {
        setOutput((prev) => prev + message.data);
        setTimeout(scrollToBottom, 10);
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
    queuePolicy: 'drop',
  });

  return { connected, output, outputEndRef };
}
