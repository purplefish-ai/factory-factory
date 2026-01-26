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
  onOutput?: (terminalId: string, data: string) => void;
  onCreated?: (terminalId: string) => void;
  onExit?: (terminalId: string, exitCode: number) => void;
  onError?: (message: string) => void;
}

interface UseTerminalWebSocketReturn {
  connected: boolean;
  create: (cols?: number, rows?: number) => void;
  sendInput: (terminalId: string, data: string) => void;
  resize: (terminalId: string, cols: number, rows: number) => void;
  destroy: (terminalId: string) => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useTerminalWebSocket({
  workspaceId,
  onOutput,
  onCreated,
  onExit,
  onError,
}: UseTerminalWebSocketOptions): UseTerminalWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track intentional closes to prevent reconnection during React Strict Mode unmount
  const intentionalCloseRef = useRef(false);

  // Store callbacks in refs to avoid reconnection on callback changes
  const onOutputRef = useRef(onOutput);
  const onCreatedRef = useRef(onCreated);
  const onExitRef = useRef(onExit);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onOutputRef.current = onOutput;
    onCreatedRef.current = onCreated;
    onExitRef.current = onExit;
    onErrorRef.current = onError;
  }, [onOutput, onCreated, onExit, onError]);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Reset intentional close flag when establishing a new connection
    intentionalCloseRef.current = false;

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
            if (message.terminalId && message.data) {
              onOutputRef.current?.(message.terminalId, message.data);
            }
            break;

          case 'created':
            if (message.terminalId) {
              onCreatedRef.current?.(message.terminalId);
            }
            break;

          case 'exit':
            if (message.terminalId && message.exitCode !== undefined) {
              onExitRef.current?.(message.terminalId, message.exitCode);
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

      // Only attempt to reconnect if this wasn't an intentional close
      // (e.g., from React Strict Mode unmount)
      if (!intentionalCloseRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 3000);
      }
    };

    ws.onerror = () => {
      onErrorRef.current?.('WebSocket connection error');
    };
  }, [workspaceId]);

  // Connect on mount
  useEffect(() => {
    connect();

    return () => {
      // Mark as intentional close to prevent reconnection in onclose handler
      intentionalCloseRef.current = true;
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

  // Send input to a specific terminal
  const sendInput = useCallback((terminalId: string, data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', terminalId, data }));
    }
  }, []);

  // Resize a specific terminal
  const resize = useCallback((terminalId: string, cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', terminalId, cols, rows }));
    }
  }, []);

  // Destroy a specific terminal
  const destroy = useCallback((terminalId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'destroy', terminalId }));
    }
  }, []);

  return {
    connected,
    create,
    sendInput,
    resize,
    destroy,
  };
}
