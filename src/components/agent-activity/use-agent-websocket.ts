'use client';

/**
 * Custom hook for agent activity WebSocket connection and state management
 * Connects to /agent-activity WebSocket with agentId parameter
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { convertHistoryMessage } from '../chat/message-utils';
import type { ClaudeMessage } from '../chat/types';
import type {
  AgentActivityState,
  AgentMetadata,
  AgentWebSocketMessage,
  ChatMessage,
  ConnectionState,
  TokenStats,
} from './types';

export interface UseAgentWebSocketOptions {
  /** Agent ID to connect to */
  agentId: string;
  /** Whether to auto-connect on mount */
  autoConnect?: boolean;
  /** Polling interval for reconnection attempts (ms) */
  reconnectInterval?: number;
  /** Maximum reconnection attempts */
  maxReconnectAttempts?: number;
}

export interface UseAgentWebSocketReturn extends AgentActivityState {
  /** Reconnect to the WebSocket */
  reconnect: () => void;
  /** Reference to messages container for auto-scroll */
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

const INITIAL_TOKEN_STATS: TokenStats = {
  inputTokens: 0,
  outputTokens: 0,
  totalCostUsd: 0,
  totalDurationMs: 0,
  turnCount: 0,
};

export function useAgentWebSocket(options: UseAgentWebSocketOptions): UseAgentWebSocketReturn {
  const {
    agentId,
    autoConnect = true,
    reconnectInterval = 5000,
    maxReconnectAttempts = 3,
  } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [running, setRunning] = useState(false);
  const [agentMetadata, setAgentMetadata] = useState<AgentMetadata | null>(null);
  const [tokenStats, setTokenStats] = useState<TokenStats>(INITIAL_TOKEN_STATS);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clear reconnect timeout on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnectionState('connecting');
    setError(null);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:3001/agent-activity?agentId=${agentId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionState('connected');
      reconnectAttemptsRef.current = 0;
    };

    ws.onclose = () => {
      setConnectionState('disconnected');
      setRunning(false);

      // Attempt reconnection if not at max attempts
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        reconnectAttemptsRef.current++;
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, reconnectInterval);
      }
    };

    ws.onerror = () => {
      setConnectionState('error');
      setError('WebSocket connection failed');
    };

    const handleStatus = (data: AgentWebSocketMessage) => {
      setRunning(data.running ?? false);
      if (data.claudeSessionId) {
        setClaudeSessionId(data.claudeSessionId);
      }
      if (data.agentMetadata) {
        setAgentMetadata(data.agentMetadata);
      }
    };

    const handleSessionLoaded = (data: AgentWebSocketMessage) => {
      setClaudeSessionId(data.claudeSessionId || null);
      if (data.messages) {
        setMessages(data.messages.map(convertHistoryMessage));
      }
    };

    const handleClaudeMessage = (data: AgentWebSocketMessage) => {
      const msg = data.data as ClaudeMessage;

      // Update token stats from result messages
      if (msg.type === 'result') {
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const durationMs = msg.duration_ms as number | undefined;
        const costUsd = msg.total_cost_usd as number | undefined;

        if (usage || durationMs || costUsd) {
          setTokenStats((prev) => ({
            inputTokens: prev.inputTokens + (usage?.input_tokens || 0),
            outputTokens: prev.outputTokens + (usage?.output_tokens || 0),
            totalCostUsd: prev.totalCostUsd + (costUsd || 0),
            totalDurationMs: prev.totalDurationMs + (durationMs || 0),
            turnCount: prev.turnCount + 1,
          }));
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          id: `claude-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          source: 'claude',
          message: { ...msg, timestamp: new Date().toISOString() },
        },
      ]);
    };

    const handleError = (data: AgentWebSocketMessage) => {
      setError(data.message || 'Unknown error');
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          source: 'claude',
          message: {
            type: 'error',
            error: data.message || 'Unknown error',
            timestamp: new Date().toISOString(),
          },
        },
      ]);
    };

    const handleAgentMetadata = (data: AgentWebSocketMessage) => {
      if (data.agentMetadata) {
        setAgentMetadata(data.agentMetadata);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as AgentWebSocketMessage;
        switch (data.type) {
          case 'status':
            handleStatus(data);
            break;
          case 'agent_metadata':
            handleAgentMetadata(data);
            break;
          case 'session_loaded':
            handleSessionLoaded(data);
            break;
          case 'started':
            setRunning(true);
            break;
          case 'stopped':
          case 'process_exit':
            setRunning(false);
            break;
          case 'claude_message':
            handleClaudeMessage(data);
            break;
          case 'error':
            handleError(data);
            break;
        }
      } catch (parseError) {
        // Log parse errors for debugging
        // biome-ignore lint/suspicious/noConsole: intentional debug logging
        console.warn('WebSocket message parse error:', parseError);
      }
    };
  }, [agentId, maxReconnectAttempts, reconnectInterval]);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [autoConnect, connect]);

  // Auto-scroll to bottom when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length is the trigger for scrolling
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Reconnect function for manual reconnection
  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    if (wsRef.current) {
      wsRef.current.close();
    }
    connect();
  }, [connect]);

  return {
    messages,
    connected: connectionState === 'connected',
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
