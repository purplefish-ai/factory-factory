'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

interface ClaudeMessage {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

interface WebSocketMessage {
  type: string;
  data?: unknown;
  sessionId?: string;
  claudeSessionId?: string;
  running?: boolean;
  message?: string;
  code?: number;
  sessions?: string[];
  messages?: HistoryMessage[];
}

interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: string;
  uuid: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

// ============================================================================
// Message Renderers
// ============================================================================

function AssistantMessageRenderer({ message }: { message: ClaudeMessage }) {
  const content = (message.message as { content?: Array<{ type?: string; text?: string }> })
    ?.content;
  // Filter to only text blocks (skip tool_use, thinking, etc.)
  const text =
    content
      ?.filter((c) => c.type === 'text' || !c.type)
      ?.map((c) => c.text)
      .filter(Boolean)
      .join('') || '';

  // Don't render if no text content
  if (!text) {
    return null;
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">{text}</div>
  );
}

function ToolUseRenderer({ message }: { message: ClaudeMessage }) {
  const tool = message.tool as string;
  const input = message.input as Record<string, unknown>;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className="text-xs font-medium text-blue-700 dark:text-blue-300">Tool: {tool}</span>
        <span className="text-xs text-blue-500">{expanded ? '[-]' : '[+]'}</span>
      </button>
      {expanded && (
        <pre className="mt-2 text-xs bg-blue-100 dark:bg-blue-900/50 p-2 rounded overflow-x-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultRenderer({ message }: { message: ClaudeMessage }) {
  const result = message.result as string | Record<string, unknown>;
  const isError = message.is_error as boolean;
  const [expanded, setExpanded] = useState(false);

  const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const isTruncated = resultText.length > 500;

  return (
    <div
      className={`p-4 rounded-lg border ${
        isError
          ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
          : 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span
          className={`text-xs font-medium ${isError ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
        >
          {isError ? 'Tool Error' : 'Tool Result'}
        </span>
        {isTruncated && (
          <span className="text-xs text-muted-foreground">{expanded ? '[-]' : '[+]'}</span>
        )}
      </button>
      <pre
        className={`mt-2 text-xs p-2 rounded overflow-x-auto ${
          isError ? 'bg-red-100 dark:bg-red-900/50' : 'bg-green-100 dark:bg-green-900/50'
        }`}
      >
        {expanded || !isTruncated ? resultText : `${resultText.slice(0, 500)}...`}
      </pre>
    </div>
  );
}

function ResultRenderer({ message }: { message: ClaudeMessage }) {
  const usage = message.usage as { input_tokens?: number; output_tokens?: number };
  const durationMs = message.duration_ms as number;
  const costUsd = message.total_cost_usd as number;

  const totalTokens = (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
  // Format cost - show cents if < $0.01
  const costDisplay = costUsd < 0.01 ? `${(costUsd * 100).toFixed(2)}¢` : `$${costUsd.toFixed(4)}`;

  return (
    <div className="text-xs text-muted-foreground flex items-center gap-3 py-1">
      <span>{totalTokens.toLocaleString()} tokens</span>
      <span>{((durationMs || 0) / 1000).toFixed(1)}s</span>
      <span>{costDisplay}</span>
    </div>
  );
}

function SystemMessageRenderer({ message }: { message: ClaudeMessage }) {
  return (
    <div className="p-2 text-xs text-muted-foreground italic text-center">
      {message.message as string}
    </div>
  );
}

function ErrorRenderer({ message }: { message: ClaudeMessage }) {
  return (
    <div className="p-4 bg-red-50 dark:bg-red-950/30 rounded-lg border border-red-200 dark:border-red-800">
      <div className="text-sm font-medium text-red-700 dark:text-red-300">Error</div>
      <div className="text-sm text-red-600 dark:text-red-400 mt-1">{message.error as string}</div>
    </div>
  );
}

function StreamDeltaRenderer({ message }: { message: ClaudeMessage }) {
  const delta = message.delta as { text?: string };
  if (!delta?.text) {
    return null;
  }

  return <span className="prose prose-sm dark:prose-invert whitespace-pre-wrap">{delta.text}</span>;
}

// Helper to extract tool info from messages (handles both flat and nested formats)
interface ToolInfo {
  type: 'tool_use' | 'tool_result';
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

// Extract tool_use info from a content item
function extractToolUse(item: Record<string, unknown>): ToolInfo {
  return {
    type: 'tool_use',
    name: item.name as string,
    id: item.id as string,
    input: item.input as Record<string, unknown>,
  };
}

// Extract tool_result info from a content item
function extractToolResult(item: Record<string, unknown>): ToolInfo {
  const content = item.content ?? item.result;
  return {
    type: 'tool_result',
    id: (item.tool_use_id ?? item.id) as string,
    result: typeof content === 'string' ? content : JSON.stringify(content),
    isError: item.is_error as boolean,
  };
}

// Extract tool info from nested content array (streaming format)
function extractFromContent(content: Record<string, unknown>[]): ToolInfo | null {
  for (const item of content) {
    if (item.type === 'tool_use') {
      return extractToolUse(item);
    }
    if (item.type === 'tool_result') {
      return extractToolResult(item);
    }
  }
  return null;
}

function extractToolInfo(msg: ClaudeMessage): ToolInfo | null {
  // Flat format (from history): {type: 'tool_use', tool: '...', input: {...}}
  if (msg.type === 'tool_use') {
    return extractToolUse({ ...msg, name: msg.tool, id: msg.id });
  }
  if (msg.type === 'tool_result') {
    return extractToolResult(msg as unknown as Record<string, unknown>);
  }

  // Nested format (from streaming): {type: 'assistant', message: {content: [{type: 'tool_use', ...}]}}
  const content = (msg.message as { content?: Record<string, unknown>[] })?.content;
  if (Array.isArray(content)) {
    return extractFromContent(content);
  }

  return null;
}

function hasToolContent(msg: ClaudeMessage): boolean {
  return extractToolInfo(msg) !== null;
}

// Render tool info (works for both formats)
function ToolInfoRenderer({ info }: { info: ToolInfo }) {
  const [expanded, setExpanded] = useState(false);

  if (info.type === 'tool_use') {
    return (
      <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded border border-blue-200 dark:border-blue-800">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full text-left"
        >
          <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
            Tool: {info.name}
          </span>
          <span className="text-xs text-blue-500">{expanded ? '[-]' : '[+]'}</span>
        </button>
        {expanded && info.input && (
          <pre className="mt-2 text-xs bg-blue-100 dark:bg-blue-900/50 p-2 rounded overflow-x-auto">
            {JSON.stringify(info.input, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  // Tool result
  const resultText = info.result || '';
  const isTruncated = resultText.length > 500;

  return (
    <div
      className={`p-3 rounded border ${
        info.isError
          ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
          : 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span
          className={`text-xs font-medium ${info.isError ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
        >
          {info.isError ? 'Error' : 'Result'}
        </span>
        {isTruncated && (
          <span className="text-xs text-muted-foreground">{expanded ? '[-]' : '[+]'}</span>
        )}
      </button>
      <pre
        className={`mt-2 text-xs p-2 rounded overflow-x-auto ${
          info.isError ? 'bg-red-100 dark:bg-red-900/50' : 'bg-green-100 dark:bg-green-900/50'
        }`}
      >
        {expanded || !isTruncated ? resultText : `${resultText.slice(0, 500)}...`}
      </pre>
    </div>
  );
}

// Grouped tool calls renderer - shows multiple tool calls collapsed
function ToolCallGroupRenderer({ messages }: { messages: ClaudeMessage[] }) {
  const [expanded, setExpanded] = useState(false);

  // Extract tool info from all messages
  const toolInfos = messages.map(extractToolInfo).filter((t): t is ToolInfo => t !== null);
  const toolUses = toolInfos.filter((t) => t.type === 'tool_use');
  const toolResults = toolInfos.filter((t) => t.type === 'tool_result');
  const hasErrors = toolResults.some((t) => t.isError);

  // Get unique tool names
  const toolNames = [...new Set(toolUses.map((t) => t.name).filter(Boolean))];
  const summary =
    toolNames.length <= 3 ? toolNames.join(', ') : `${toolNames.slice(0, 3).join(', ')}...`;

  return (
    <div
      className={`rounded-lg border ${hasErrors ? 'border-red-200 dark:border-red-800' : 'border-blue-200 dark:border-blue-800'}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`w-full p-3 flex items-center justify-between text-left ${hasErrors ? 'bg-red-50 dark:bg-red-950/30' : 'bg-blue-50 dark:bg-blue-950/30'} rounded-t-lg ${!expanded ? 'rounded-b-lg' : ''}`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-medium ${hasErrors ? 'text-red-700 dark:text-red-300' : 'text-blue-700 dark:text-blue-300'}`}
          >
            {toolUses.length} tool call{toolUses.length !== 1 ? 's' : ''}: {summary}
          </span>
          {hasErrors && (
            <span className="text-xs px-1.5 py-0.5 bg-red-200 dark:bg-red-800 text-red-800 dark:text-red-200 rounded">
              error
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? '[-]' : '[+]'}</span>
      </button>
      {expanded && (
        <div className="p-2 space-y-2 bg-muted/20">
          {toolInfos.map((info) => (
            <ToolInfoRenderer key={info.id || `${info.type}-${info.name}`} info={info} />
          ))}
        </div>
      )}
    </div>
  );
}

function MessageRenderer({ message }: { message: ClaudeMessage }) {
  switch (message.type) {
    case 'assistant':
      return <AssistantMessageRenderer message={message} />;
    case 'tool_use':
      return <ToolUseRenderer message={message} />;
    case 'tool_result':
      return <ToolResultRenderer message={message} />;
    case 'result':
      return <ResultRenderer message={message} />;
    case 'system':
      return <SystemMessageRenderer message={message} />;
    case 'error':
      return <ErrorRenderer message={message} />;
    case 'content_block_delta':
      return <StreamDeltaRenderer message={message} />;
    default:
      // Skip unknown message types silently
      return null;
  }
}

// ============================================================================
// User Message Component
// ============================================================================

function UserMessage({ text }: { text: string }) {
  return (
    <div className="p-4 bg-primary/10 rounded-lg ml-8">
      <div className="text-xs text-muted-foreground mb-2 font-medium">You</div>
      <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">{text}</div>
    </div>
  );
}

// ============================================================================
// Message Grouping
// ============================================================================

interface MessageGroup {
  type: 'user' | 'assistant' | 'tool_group';
  messages: ChatMessage[];
  id: string;
}

function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentToolGroup: ChatMessage[] = [];
  let currentAssistantGroup: ChatMessage[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) {
      groups.push({
        type: 'tool_group',
        messages: currentToolGroup,
        id: `tool-group-${currentToolGroup[0].id}`,
      });
      currentToolGroup = [];
    }
  };

  const flushAssistantGroup = () => {
    if (currentAssistantGroup.length > 0) {
      groups.push({
        type: 'assistant',
        messages: currentAssistantGroup,
        id: `assistant-group-${currentAssistantGroup[0].id}`,
      });
      currentAssistantGroup = [];
    }
  };

  for (const msg of messages) {
    // Check if this message contains tool calls (handles both flat and nested formats)
    const isToolMessage = msg.message && hasToolContent(msg.message);

    if (isToolMessage) {
      flushAssistantGroup();
      currentToolGroup.push(msg);
    } else if (msg.source === 'user') {
      // User message (not containing tool results) - flush both groups
      flushToolGroup();
      flushAssistantGroup();
      groups.push({ type: 'user', messages: [msg], id: msg.id });
    } else {
      // Assistant message (text, delta, result, system, error, etc.)
      flushToolGroup();
      currentAssistantGroup.push(msg);
    }
  }

  // Flush remaining groups
  flushToolGroup();
  flushAssistantGroup();

  return groups;
}

function AssistantGroupRenderer({ messages }: { messages: ChatMessage[] }) {
  const renderedMessages = messages
    .map((m) => m.message)
    .filter((m): m is ClaudeMessage => m !== undefined);

  // Check if there's any visible content
  const hasContent = renderedMessages.some((msg) => {
    if (msg.type === 'assistant') {
      const content = (msg.message as { content?: Array<{ type?: string; text?: string }> })
        ?.content;
      return content?.some((c) => (c.type === 'text' || !c.type) && c.text);
    }
    if (msg.type === 'content_block_delta') {
      return (msg.delta as { text?: string })?.text;
    }
    if (msg.type === 'result') {
      return true; // Result messages have stats to display
    }
    if (msg.type === 'system') {
      // Only show system messages that have a displayable message string
      return typeof msg.message === 'string' && msg.message.length > 0;
    }
    if (msg.type === 'error') {
      return !!(msg.error as string);
    }
    return false;
  });

  if (!hasContent) {
    return null;
  }

  return (
    <div className="p-4 bg-muted/50 rounded-lg space-y-2">
      <div className="text-xs text-muted-foreground font-medium">Claude</div>
      {renderedMessages.map((msg) => (
        <MessageRenderer key={`${msg.type}-${msg.timestamp}`} message={msg} />
      ))}
    </div>
  );
}

function GroupedMessages({ messages }: { messages: ChatMessage[] }) {
  const groups = groupMessages(messages);

  return (
    <>
      {groups.map((group) => {
        if (group.type === 'user') {
          return <UserMessage key={group.id} text={group.messages[0].text || ''} />;
        } else if (group.type === 'tool_group') {
          const toolMessages = group.messages
            .map((m) => m.message)
            .filter((m): m is ClaudeMessage => m !== undefined);
          return <ToolCallGroupRenderer key={group.id} messages={toolMessages} />;
        } else {
          return <AssistantGroupRenderer key={group.id} messages={group.messages} />;
        }
      })}
    </>
  );
}

// ============================================================================
// History Message Conversion
// ============================================================================

function convertHistoryMessage(msg: HistoryMessage, idx: number): ChatMessage {
  const base = {
    id: `history-${idx}-${msg.uuid}`,
    source: (msg.type === 'user' ? 'user' : 'claude') as 'user' | 'claude',
  };

  switch (msg.type) {
    case 'user':
      return { ...base, text: msg.content };
    case 'assistant':
      return {
        ...base,
        message: {
          type: 'assistant',
          timestamp: msg.timestamp,
          message: { content: [{ text: msg.content }] },
        },
      };
    case 'tool_use':
      return {
        ...base,
        message: {
          type: 'tool_use',
          timestamp: msg.timestamp,
          tool: msg.toolName,
          id: msg.toolId,
          input: msg.toolInput,
        },
      };
    case 'tool_result':
      return {
        ...base,
        message: {
          type: 'tool_result',
          timestamp: msg.timestamp,
          tool_use_id: msg.toolId,
          result: msg.content,
          is_error: msg.isError,
        },
      };
    default:
      return base;
  }
}

// ============================================================================
// Main Chat Component
// ============================================================================

interface ChatMessage {
  id: string;
  source: 'user' | 'claude';
  message?: ClaudeMessage;
  text?: string;
}

export default function ChatPage() {
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
  const freshStartRef = useRef(false); // Track if we want a fresh start (skip URL session)

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
      // Request available sessions
      ws.send(JSON.stringify({ type: 'list_sessions' }));
      // If there's a session in the URL, load it (unless this is a fresh start)
      if (urlClaudeSessionId && !initialSessionLoadedRef.current && !freshStartRef.current) {
        initialSessionLoadedRef.current = true;
        ws.send(JSON.stringify({ type: 'load_session', claudeSessionId: urlClaudeSessionId }));
      }
      // Reset fresh start flag after connection
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
      } catch {
        // Ignore parse errors
      }
    };

    return () => {
      ws.close();
    };
  }, [getSessionId, urlClaudeSessionId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Send message
  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!(text && wsRef.current) || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    // Add user message to chat
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        source: 'user',
        text,
      },
    ]);

    // Send to WebSocket
    wsRef.current.send(JSON.stringify({ type: 'user_input', text }));
    setInput('');

    // Focus back on input
    inputRef.current?.focus();
  }, [input]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  // Clear chat
  const clearChat = useCallback(() => {
    setMessages([]);
    setClaudeSessionId(null);
    initialSessionLoadedRef.current = false;
    freshStartRef.current = true; // Skip loading URL session on reconnect
    // Clear URL
    router.replace('/chat', { scroll: false });
    // Generate new session ID
    const newId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setSessionId(newId);

    // Reconnect with new session
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

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Chat with Claude</h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div
              className={`w-2 h-2 rounded-full ${
                connected
                  ? running
                    ? 'bg-yellow-500 animate-pulse'
                    : 'bg-green-500'
                  : 'bg-red-500'
              }`}
            />
            <span>{connected ? (running ? 'Processing...' : 'Connected') : 'Disconnected'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSessionPicker(!showSessionPicker)}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border rounded-md hover:bg-muted"
            >
              Load Session ({availableSessions.length})
            </button>
            {showSessionPicker && availableSessions.length > 0 && (
              <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto bg-background border rounded-lg shadow-lg z-50">
                <div className="p-2 border-b text-xs text-muted-foreground font-medium">
                  Previous Sessions
                </div>
                {availableSessions.map((sid) => (
                  <button
                    key={sid}
                    type="button"
                    onClick={() => loadSession(sid)}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-muted truncate ${
                      sid === claudeSessionId ? 'bg-primary/10 text-primary' : ''
                    }`}
                  >
                    {sid}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={clearChat}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border rounded-md hover:bg-muted"
          >
            New Chat
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <div className="text-lg mb-2">Start a conversation</div>
            <div className="text-sm">Type a message below to chat with Claude</div>
          </div>
        ) : (
          <GroupedMessages messages={messages} />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              connected
                ? 'Type your message... (Enter to send, Shift+Enter for new line)'
                : 'Connecting...'
            }
            disabled={!connected}
            className="flex-1 min-h-[80px] max-h-[200px] px-4 py-3 border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:bg-muted disabled:cursor-not-allowed"
            rows={3}
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={!(connected && input.trim())}
            className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed self-end"
          >
            Send
          </button>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Claude CLI JSON Streaming POC
          {claudeSessionId && (
            <span className="ml-2">| Claude Session: {claudeSessionId.slice(0, 8)}...</span>
          )}
        </div>
      </div>
    </div>
  );
}
