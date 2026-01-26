'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// =============================================================================
// Types
// =============================================================================

interface TerminalMessage {
  type: 'output' | 'created' | 'exit' | 'error' | 'status';
  data?: string;
  terminalId?: string;
  exitCode?: number;
  message?: string;
}

interface UseTerminalWebSocketOptions {
  workspaceId: string;
  onOutput?: (data: string) => void;
  onExit?: (exitCode: number) => void;
  onError?: (message: string) => void;
}

interface UseTerminalWebSocketReturn {
  connected: boolean;
  terminalId: string | null;
  create: (cols?: number, rows?: number) => void;
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  destroy: () => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useTerminalWebSocket({
  workspaceId,
  onOutput,
  onExit,
  onError,
}: UseTerminalWebSocketOptions): UseTerminalWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Store callbacks in refs to avoid reconnection on callback changes
  const onOutputRef = useRef(onOutput);
  const onExitRef = useRef(onExit);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onOutputRef.current = onOutput;
    onExitRef.current = onExit;
    onErrorRef.current = onError;
  }, [onOutput, onExit, onError]);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = process.env.NEXT_PUBLIC_WS_HOST || window.location.host;
    const backendPort = process.env.NEXT_PUBLIC_BACKEND_PORT || '3001';
    const wsHost = host.includes(':') ? host.split(':')[0] : host;
    const wsUrl = `${protocol}//${wsHost}:${backendPort}/terminal?workspaceId=${encodeURIComponent(workspaceId)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebSocket message handler requires handling multiple message types
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as TerminalMessage;

        switch (message.type) {
          case 'output':
            if (message.data) {
              onOutputRef.current?.(message.data);
            }
            break;

          case 'created':
            if (message.terminalId) {
              setTerminalId(message.terminalId);
            }
            break;

          case 'exit':
            setTerminalId(null);
            if (message.exitCode !== undefined) {
              onExitRef.current?.(message.exitCode);
            }
            break;

          case 'error':
            if (message.message) {
              onErrorRef.current?.(message.message);
            }
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Attempt to reconnect after 3 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = () => {
      onErrorRef.current?.('WebSocket connection error');
    };
  }, [workspaceId]);

  // Connect on mount
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // Create a new terminal
  const create = useCallback((cols = 80, rows = 24) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'create', cols, rows }));
    }
  }, []);

  // Send input to terminal
  const sendInput = useCallback(
    (data: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN && terminalId) {
        wsRef.current.send(JSON.stringify({ type: 'input', terminalId, data }));
      }
    },
    [terminalId]
  );

  // Resize terminal
  const resize = useCallback(
    (cols: number, rows: number) => {
      if (wsRef.current?.readyState === WebSocket.OPEN && terminalId) {
        wsRef.current.send(JSON.stringify({ type: 'resize', terminalId, cols, rows }));
      }
    },
    [terminalId]
  );

  // Destroy terminal
  const destroy = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && terminalId) {
      wsRef.current.send(JSON.stringify({ type: 'destroy', terminalId }));
      setTerminalId(null);
    }
  }, [terminalId]);

  return {
    connected,
    terminalId,
    create,
    sendInput,
    resize,
    destroy,
  };
}
