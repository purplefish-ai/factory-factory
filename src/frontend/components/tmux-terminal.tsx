'use client';

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, ServerMessage, TerminalDimensions } from '../types/terminal';

interface XtermTerminalProps {
  sessionName: string;
  agentId?: string; // Keep for backwards compatibility
}

// Default terminal dimensions
const DEFAULT_DIMENSIONS: TerminalDimensions = {
  cols: 80,
  rows: 24,
};

// WebSocket URL builder
function getWebSocketUrl(sessionName: string, cols: number, rows: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = process.env.NEXT_PUBLIC_BACKEND_URL
    ? new URL(process.env.NEXT_PUBLIC_BACKEND_URL).host
    : `${window.location.hostname}:3001`;
  return `${protocol}//${host}/terminal?session=${encodeURIComponent(sessionName)}&cols=${cols}&rows=${rows}`;
}

export function TmuxTerminal({ sessionName, agentId: _agentId }: XtermTerminalProps) {
  // Refs for xterm instances
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastDimensionsRef = useRef<TerminalDimensions>(DEFAULT_DIMENSIONS);

  // State
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [dimensions, setDimensions] = useState<TerminalDimensions>(DEFAULT_DIMENSIONS);
  const [terminalReady, setTerminalReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The actual session to connect to
  const effectiveSession = sessionName;

  // Send message to WebSocket
  const send = useCallback(
    (message: { type: string; data?: string; cols?: number; rows?: number }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
      }
    },
    []
  );

  // Send resize message
  const sendResize = useCallback(
    (cols: number, rows: number) => {
      send({ type: 'resize', cols, rows });
    },
    [send]
  );

  // Connect to WebSocket
  const connect = useCallback(
    (cols: number, rows: number) => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      setStatus('connecting');
      setError(null);

      const url = getWebSocketUrl(effectiveSession, cols, rows);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ServerMessage;

          switch (message.type) {
            case 'output':
              if (xtermRef.current) {
                xtermRef.current.write(message.data);
              }
              break;

            case 'error':
              setError(message.message);
              setStatus('error');
              break;

            case 'exit':
              setStatus('disconnected');
              break;
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = () => {
        setStatus('error');
        setError('WebSocket connection error');
      };

      ws.onclose = () => {
        setStatus((current) => (current === 'error' ? 'error' : 'disconnected'));
      };
    },
    [effectiveSession]
  );

  // Initialize xterm.js
  useEffect(() => {
    if (!terminalRef.current || terminalReady) {
      return;
    }

    let disposed = false;

    async function initTerminal() {
      // Dynamic import to avoid SSR issues
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');

      if (disposed || !terminalRef.current) {
        return;
      }

      // Create terminal with dark theme
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"Cascadia Code", "Fira Code", "Source Code Pro", Menlo, Monaco, monospace',
        theme: {
          background: '#1a1b26',
          foreground: '#c0caf5',
          cursor: '#c0caf5',
          cursorAccent: '#1a1b26',
          selectionBackground: '#33467c',
          black: '#15161e',
          red: '#f7768e',
          green: '#9ece6a',
          yellow: '#e0af68',
          blue: '#7aa2f7',
          magenta: '#bb9af7',
          cyan: '#7dcfff',
          white: '#a9b1d6',
          brightBlack: '#414868',
          brightRed: '#f7768e',
          brightGreen: '#9ece6a',
          brightYellow: '#e0af68',
          brightBlue: '#7aa2f7',
          brightMagenta: '#bb9af7',
          brightCyan: '#7dcfff',
          brightWhite: '#c0caf5',
        },
        scrollback: 10_000,
        convertEol: true,
      });

      // Create and load addons
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);

      // Open terminal in container
      term.open(terminalRef.current);

      // Initial fit
      fitAddon.fit();

      // Store refs
      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      // Get initial dimensions
      const initialDims = {
        cols: term.cols,
        rows: term.rows,
      };
      setDimensions(initialDims);

      // Set up input handler
      term.onData((data) => {
        send({ type: 'input', data });
      });

      setTerminalReady(true);
    }

    initTerminal().catch(() => {
      setError('Failed to initialize terminal');
    });

    return () => {
      disposed = true;
    };
  }, [send, terminalReady]);

  // Connect when terminal is ready (reconnects if session changes)
  useEffect(() => {
    if (!terminalReady) {
      return;
    }

    // Use current terminal dimensions for initial connection
    const cols = xtermRef.current?.cols ?? DEFAULT_DIMENSIONS.cols;
    const rows = xtermRef.current?.rows ?? DEFAULT_DIMENSIONS.rows;
    connect(cols, rows);

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [terminalReady, connect]);

  // Set up ResizeObserver for dynamic sizing
  useEffect(() => {
    if (!(terminalRef.current && terminalReady)) {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current) {
        try {
          fitAddonRef.current.fit();
          const newDims = {
            cols: xtermRef.current.cols,
            rows: xtermRef.current.rows,
          };

          // Only send resize if dimensions actually changed
          const lastDims = lastDimensionsRef.current;
          if (newDims.cols !== lastDims.cols || newDims.rows !== lastDims.rows) {
            lastDimensionsRef.current = newDims;
            setDimensions(newDims);
            sendResize(newDims.cols, newDims.rows);
          }
        } catch {
          // Ignore fit errors during resize
        }
      }
    });

    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [terminalReady, sendResize]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // Reconnect handler
  const handleReconnect = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.clear();
    }
    const cols = xtermRef.current?.cols ?? DEFAULT_DIMENSIONS.cols;
    const rows = xtermRef.current?.rows ?? DEFAULT_DIMENSIONS.rows;
    connect(cols, rows);
  }, [connect]);

  // Status indicator component
  const StatusIndicator = () => {
    const statusConfig = {
      disconnected: { color: 'bg-gray-500', text: 'Disconnected' },
      connecting: { color: 'bg-yellow-500 animate-pulse', text: 'Connecting...' },
      connected: { color: 'bg-green-500', text: 'Connected' },
      error: { color: 'bg-red-500', text: 'Error' },
    };

    const config = statusConfig[status];

    return (
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${config.color}`} />
        <span className="text-xs text-gray-400">{config.text}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Terminal Header */}
      <div className="flex items-center justify-between bg-gray-800 text-gray-300 px-4 py-2 rounded-t text-sm shrink-0">
        <div className="flex items-center gap-2">
          <span className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full bg-red-500" />
            <span className="w-3 h-3 rounded-full bg-yellow-500" />
            <span className="w-3 h-3 rounded-full bg-green-500" />
          </span>
          <span className="ml-2 font-mono text-xs">{effectiveSession}</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-500">
            {dimensions.cols}x{dimensions.rows}
          </span>
          <StatusIndicator />
          {(status === 'disconnected' || status === 'error') && (
            <button
              onClick={handleReconnect}
              className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
            >
              Reconnect
            </button>
          )}
        </div>
      </div>

      {/* Error message */}
      {error && <div className="bg-red-900/50 text-red-200 px-4 py-2 text-sm">{error}</div>}

      {/* Terminal Container */}
      <div
        ref={terminalRef}
        className="terminal-container flex-1 bg-[#1a1b26] rounded-b overflow-hidden min-h-[300px]"
      />
    </div>
  );
}
