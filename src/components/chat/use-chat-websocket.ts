'use client';

/**
 * Custom hook for chat WebSocket connection and state management
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { convertHistoryMessage } from './message-utils';
import type { ChatMessage, ClaudeMessage, WebSocketMessage } from './types';

export interface UseChatWebSocketReturn {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  connected: boolean;
  running: boolean;
  claudeSessionId: string | null;
  availableSessions: string[];
  showSessionPicker: boolean;
  setShowSessionPicker: (value: boolean) => void;
  sendMessage: () => void;
  clearChat: () => void;
  loadSession: (sessionId: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function useChatWebSocket(): UseChatWebSocketReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialSessionLoadedRef = useRef(false);
  const freshStartRef = useRef(false);

  // Get initial Claude session ID from URL
  const urlClaudeSessionId = searchParams.get('session');

  // Update URL when claudeSessionId changes
  useEffect(() => {
    if (claudeSessionId && claudeSessionId !== urlClaudeSessionId) {
      router.replace(`/chat?session=${claudeSessionId}`, { scroll: false });
    }
  }, [claudeSessionId, urlClaudeSessionId, router]);

  // Generate a unique session ID
  const getSessionId = useCallback(() => {
    if (sessionId) {
      return sessionId;
    }
    const newId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setSessionId(newId);
    return newId;
  }, [sessionId]);

  // Connect to WebSocket
  useEffect(() => {
    const id = getSessionId();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:3001/chat?sessionId=${id}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: 'list_sessions' }));
      if (urlClaudeSessionId && !initialSessionLoadedRef.current && !freshStartRef.current) {
        initialSessionLoadedRef.current = true;
        ws.send(JSON.stringify({ type: 'load_session', claudeSessionId: urlClaudeSessionId }));
      }
      freshStartRef.current = false;
    };

    ws.onclose = () => {
      setConnected(false);
      setRunning(false);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    const handleStatus = (data: WebSocketMessage) => {
      setRunning(data.running ?? false);
      if (data.claudeSessionId) {
        setClaudeSessionId(data.claudeSessionId);
      }
    };

    const handleSessionLoaded = (data: WebSocketMessage) => {
      setClaudeSessionId(data.claudeSessionId || null);
      if (data.messages) {
        setMessages(data.messages.map(convertHistoryMessage));
      }
      setShowSessionPicker(false);
    };

    const handleClaudeMessage = (data: WebSocketMessage) => {
      const msg = data.data as ClaudeMessage;
      setMessages((prev) => [
        ...prev,
        {
          id: `claude-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          source: 'claude',
          message: { ...msg, timestamp: new Date().toISOString() },
        },
      ]);
    };

    const handleError = (data: WebSocketMessage) => {
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

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        switch (data.type) {
          case 'status':
            handleStatus(data);
            break;
          case 'sessions':
            setAvailableSessions(data.sessions || []);
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
      } catch (error) {
        // Log parse errors for debugging (per code review feedback)
        // biome-ignore lint/suspicious/noConsole: intentional debug logging
        console.warn('WebSocket message parse error:', error);
      }
    };

    return () => {
      ws.close();
    };
  }, [getSessionId, urlClaudeSessionId]);

  // Auto-scroll to bottom when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: messageCount triggers scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Send message
  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!(text && wsRef.current) || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        source: 'user',
        text,
      },
    ]);

    wsRef.current.send(JSON.stringify({ type: 'user_input', text }));
    setInput('');
    inputRef.current?.focus();
  }, [input]);

  // Clear chat and start fresh session
  // Sets connected=false immediately to prevent sending during transition
  const clearChat = useCallback(() => {
    // Disable sending immediately to prevent race condition
    setConnected(false);

    setMessages([]);
    setClaudeSessionId(null);
    initialSessionLoadedRef.current = false;
    freshStartRef.current = true;
    router.replace('/chat', { scroll: false });

    // Generate new session ID - the useEffect will reconnect on next render
    const newId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setSessionId(newId);

    // Close existing connection (triggers useEffect cleanup and reconnect)
    if (wsRef.current) {
      wsRef.current.close();
    }
  }, [router]);

  // Load a previous session
  const loadSession = useCallback((targetClaudeSessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({ type: 'load_session', claudeSessionId: targetClaudeSessionId })
    );
  }, []);

  return {
    messages,
    input,
    setInput,
    connected,
    running,
    claudeSessionId,
    availableSessions,
    showSessionPicker,
    setShowSessionPicker,
    sendMessage,
    clearChat,
    loadSession,
    inputRef,
    messagesEndRef,
  };
}
