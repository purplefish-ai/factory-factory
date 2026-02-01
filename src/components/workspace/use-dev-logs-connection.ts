import { useEffect, useState } from 'react';

/**
 * Hook to track the dev logs WebSocket connection status.
 * This allows the tab bar to show a connection indicator without
 * needing to render the full DevLogsPanel.
 */
export function useDevLogsConnection(workspaceId: string): boolean {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/dev-logs?workspaceId=${workspaceId}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [workspaceId]);

  return connected;
}
