import { useCallback, useEffect, useRef, useState } from 'react';

interface UseDevLogsResult {
  connected: boolean;
  output: string;
  scrollToBottom: () => void;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Hook to manage the dev logs WebSocket connection.
 * Returns connection status and output data for use in both
 * the tab indicator and the DevLogsPanel content.
 */
export function useDevLogs(workspaceId: string): UseDevLogsResult {
  const [connected, setConnected] = useState(false);
  const [output, setOutput] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const outputEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Connect to dev logs WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/dev-logs?workspaceId=${workspaceId}`;

    // Add debug output to help diagnose connection issues
    setOutput(`Connecting to ${wsUrl}...\n`);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setOutput((prev) => `${prev}Connected!\n\n`);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'output') {
          setOutput((prev) => prev + message.data);
          // Scroll to bottom after a short delay to allow render
          setTimeout(scrollToBottom, 10);
        } else if (message.type === 'status') {
          setOutput((prev) => `${prev}Status: ${JSON.stringify(message)}\n`);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      setOutput((prev) => `${prev}WebSocket error occurred\n`);
    };

    ws.onclose = (event) => {
      setConnected(false);
      setOutput((prev) => `${prev}Disconnected (code: ${event.code})\n`);
    };

    return () => {
      ws.close();
    };
  }, [workspaceId, scrollToBottom]);

  return { connected, output, scrollToBottom, outputEndRef };
}
