'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentMetadata,
  ChatMessage,
  ClaudeMessage,
  ConnectionState,
  HistoryMessage,
  TokenStats,
  WebSocketMessage,
} from '@/lib/claude-types';
import {
  convertHistoryMessage,
  createEmptyTokenStats,
  updateTokenStatsFromResult,
} from '@/lib/claude-types';
import { buildWebSocketUrl } from '@/lib/websocket-config';

// =============================================================================
// Types
// =============================================================================

export interface UseAgentWebSocketOptions {
  /** Agent ID to connect to */
  agentId: string;
  /** Whether to automatically connect on mount */
  autoConnect?: boolean;
}

export interface UseAgentWebSocketReturn {
  /** Chat messages from the agent session */
  messages: ChatMessage[];
  /** Whether the WebSocket is connected */
  connected: boolean;
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether the agent is currently running */
  running: boolean;
  /** Agent metadata (type, execution state, tasks, etc.) */
  agentMetadata: AgentMetadata | null;
  /** Accumulated token usage statistics */
  tokenStats: TokenStats;
  /** Claude session ID if available */
  claudeSessionId: string | null;
  /** Error message if any */
  error: string | null;
  /** Manually trigger reconnection */
  reconnect: () => void;
  /** Ref to attach to the end of the message list for auto-scroll */
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// =============================================================================
// Constants
// =============================================================================

// Note: Agent activity uses longer delays/attempts than chat since agents
// may be starting up or restarting
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

// =============================================================================
// Helper Functions
// =============================================================================

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createClaudeMessage(message: ClaudeMessage): ChatMessage {
  return {
    id: generateMessageId(),
    source: 'claude',
    message,
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAgentWebSocket(options: UseAgentWebSocketOptions): UseAgentWebSocketReturn {
  const { agentId, autoConnect = true } = options;

  // State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [running, setRunning] = useState(false);
  const [agentMetadata, setAgentMetadata] = useState<AgentMetadata | null>(null);
  const [tokenStats, setTokenStats] = useState<TokenStats>(createEmptyTokenStats());
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const isUnmountedRef = useRef(false);

  // Auto-scroll to bottom when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length is used as trigger for scrolling
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  // Handle incoming WebSocket messages
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch statement with multiple message types
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data) as WebSocketMessage;

      switch (data.type) {
        case 'status':
          setRunning(data.running ?? false);
          if (data.claudeSessionId) {
            setClaudeSessionId(data.claudeSessionId);
          }
          break;

        case 'started':
          setRunning(true);
          if (data.claudeSessionId) {
            setClaudeSessionId(data.claudeSessionId);
          }
          break;

        case 'stopped':
          setRunning(false);
          break;

        case 'process_exit':
          setRunning(false);
          break;

        case 'claude_message':
          if (data.data) {
            const claudeMsg = data.data as ClaudeMessage;
            setMessages((prev) => [...prev, createClaudeMessage(claudeMsg)]);

            // When we receive a 'result' message, Claude has finished the current turn
            if (claudeMsg.type === 'result') {
              setRunning(false);
              setTokenStats((prev) => updateTokenStatsFromResult(prev, claudeMsg));
            }
          }
          break;

        case 'agent_metadata':
          if (data.agentMetadata) {
            setAgentMetadata(data.agentMetadata);
          }
          break;

        case 'session_loaded':
          if (data.claudeSessionId) {
            setClaudeSessionId(data.claudeSessionId);
          }
          // Convert history messages to chat messages
          if (data.messages) {
            const historyMessages = data.messages as HistoryMessage[];
            const chatMessages = historyMessages.map(convertHistoryMessage);
            setMessages(chatMessages);
          }
          break;

        case 'error':
          if (data.message) {
            setError(data.message);
            // Also add error as a message for visibility
            const errorMsg: ClaudeMessage = {
              type: 'error',
              error: data.message,
              timestamp: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, createClaudeMessage(errorMsg)]);
          }
          break;

        default:
          // Unknown message type, ignore
          break;
      }
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: intentional debug logging for WebSocket parsing
      console.warn('Failed to parse WebSocket message:', err);
    }
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (isUnmountedRef.current) {
      return;
    }

    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clear any pending reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setConnectionState('connecting');
    setError(null);

    const wsUrl = buildWebSocketUrl('/agent-activity', { agentId });

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isUnmountedRef.current) {
          ws.close();
          return;
        }
        setConnected(true);
        setConnectionState('connected');
        reconnectAttemptsRef.current = 0;
        setError(null);
      };

      ws.onclose = () => {
        if (isUnmountedRef.current) {
          return;
        }

        setConnected(false);
        setConnectionState('disconnected');
        wsRef.current = null;

        // Attempt reconnect if we haven't exceeded max attempts
        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current += 1;
          reconnectTimeoutRef.current = setTimeout(() => {
            if (!isUnmountedRef.current) {
              connect();
            }
          }, RECONNECT_DELAY_MS);
        } else {
          setConnectionState('error');
          setError('Max reconnection attempts reached');
        }
      };

      ws.onerror = () => {
        if (isUnmountedRef.current) {
          return;
        }
        setConnectionState('error');
        setError('WebSocket connection error');
      };

      ws.onmessage = handleMessage;
    } catch (err) {
      setConnectionState('error');
      setError(err instanceof Error ? err.message : 'Failed to create WebSocket connection');
    }
  }, [agentId, handleMessage]);

  // Manual reconnect function
  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  // Initialize WebSocket connection
  useEffect(() => {
    isUnmountedRef.current = false;

    if (autoConnect) {
      connect();
    }

    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [autoConnect, connect]);

  // Reconnect when agentId changes
  useEffect(() => {
    if (autoConnect && agentId) {
      // Reset state for new agent
      setMessages([]);
      setTokenStats(createEmptyTokenStats());
      setAgentMetadata(null);
      setClaudeSessionId(null);
      setError(null);
      reconnectAttemptsRef.current = 0;
      connect();
    }
  }, [agentId, autoConnect, connect]);

  return {
    messages,
    connected,
    connectionState,
    running,
    agentMetadata,
    tokenStats,
    claudeSessionId,
    error,
    reconnect,
    messagesEndRef,
  };
}
