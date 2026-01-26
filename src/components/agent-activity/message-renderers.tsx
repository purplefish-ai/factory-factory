'use client';

import { AlertTriangle, Bot, Loader2 } from 'lucide-react';
import * as React from 'react';
import { MarkdownRenderer } from '@/components/ui/markdown';
import type {
  ChatMessage,
  ClaudeMessage,
  ClaudeStreamEvent,
  ContentBlockDelta,
} from '@/lib/claude-types';
import {
  extractTextFromMessage,
  isTextContent,
  isThinkingContent,
  isToolResultMessage,
  isToolUseMessage,
} from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import { ToolInfoRenderer } from './tool-renderers';

// =============================================================================
// Agent Running Context
// =============================================================================

/**
 * Context to track whether the agent is currently running.
 * Used by ThinkingRenderer to only animate the spinner when actively streaming.
 */
const AgentRunningContext = React.createContext<boolean>(false);

/**
 * Provider component for the agent running state.
 */
export function AgentRunningProvider({
  running,
  children,
}: {
  running: boolean;
  children: React.ReactNode;
}) {
  return <AgentRunningContext.Provider value={running}>{children}</AgentRunningContext.Provider>;
}

/**
 * Hook to access the agent running state.
 */
function useAgentRunning() {
  return React.useContext(AgentRunningContext);
}

// =============================================================================
// Assistant Message Renderer
// =============================================================================

interface AssistantMessageRendererProps {
  message: ClaudeMessage;
  className?: string;
}

/**
 * Renders an assistant message, handling different message types.
 */
export function AssistantMessageRenderer({ message, className }: AssistantMessageRendererProps) {
  // Handle tool use/result messages
  if (isToolUseMessage(message) || isToolResultMessage(message)) {
    return <ToolCallRenderer message={message} className={className} />;
  }

  // Handle result messages with stats
  if (message.type === 'result') {
    return <ResultRenderer message={message} className={className} />;
  }

  // Handle error messages
  if (message.type === 'error') {
    return <ErrorRenderer message={message} className={className} />;
  }

  // Handle stream events
  if (message.type === 'stream_event' && message.event) {
    return <StreamEventRenderer event={message.event} className={className} />;
  }

  // Handle regular assistant/user messages with content
  const text = extractTextFromMessage(message);
  if (text) {
    return (
      <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
        <TextRenderer text={text} />
      </div>
    );
  }

  // Fallback for system messages
  if (message.type === 'system') {
    return <SystemMessageRenderer message={message} className={className} />;
  }

  return null;
}

// =============================================================================
// Tool Call Renderer
// =============================================================================

interface ToolCallRendererProps {
  message: ClaudeMessage;
  className?: string;
}

/**
 * Renders a tool use or tool result message.
 */
export function ToolCallRenderer({ message, className }: ToolCallRendererProps) {
  return (
    <div className={cn('my-1', className)}>
      <ToolInfoRenderer message={message} />
    </div>
  );
}

// =============================================================================
// Result Renderer
// =============================================================================

interface ResultRendererProps {
  message: ClaudeMessage;
  className?: string;
}

/**
 * Renders a result message, typically showing completion info.
 */
export function ResultRenderer({ message, className }: ResultRendererProps) {
  // Result messages often just indicate completion; we may not need to render them visibly
  // But if there's result content, show it
  if (message.result && typeof message.result === 'string') {
    return (
      <div className={cn('text-sm text-muted-foreground italic', className)}>{message.result}</div>
    );
  }

  // Don't render empty result messages
  return null;
}

// =============================================================================
// Stream Event Renderer
// =============================================================================

interface StreamEventRendererProps {
  event: ClaudeStreamEvent;
  className?: string;
}

/**
 * Renders a stream event, handling different event types.
 */
function StreamEventRenderer({ event, className }: StreamEventRendererProps) {
  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block;
      if (isTextContent(block)) {
        return (
          <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
            <TextRenderer text={block.text} />
          </div>
        );
      }
      if (isThinkingContent(block)) {
        return <ThinkingRenderer text={block.thinking} className={className} />;
      }
      // Tool use blocks are handled by ToolInfoRenderer
      return null;
    }

    case 'content_block_delta':
      return <StreamDeltaRenderer delta={event.delta} className={className} />;

    case 'message_start':
    case 'message_delta':
    case 'message_stop':
    case 'content_block_stop':
      // These are structural events, no need to render
      return null;

    default:
      return null;
  }
}

// =============================================================================
// Stream Delta Renderer
// =============================================================================

interface StreamDeltaRendererProps {
  delta: ContentBlockDelta;
  className?: string;
}

/**
 * Renders a stream delta (partial content update).
 */
export function StreamDeltaRenderer({ delta, className }: StreamDeltaRendererProps) {
  if (delta.type === 'text_delta') {
    return <span className={cn('', className)}>{delta.text}</span>;
  }

  if (delta.type === 'thinking_delta') {
    return <span className={cn('text-muted-foreground italic', className)}>{delta.thinking}</span>;
  }

  return null;
}

// =============================================================================
// Error Renderer
// =============================================================================

interface ErrorRendererProps {
  message: ClaudeMessage;
  className?: string;
}

/**
 * Renders an error message.
 */
export function ErrorRenderer({ message, className }: ErrorRendererProps) {
  const errorText = message.error || 'An unknown error occurred';

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3',
        className
      )}
    >
      <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
      <div className="text-sm text-destructive">{errorText}</div>
    </div>
  );
}

// =============================================================================
// Thinking Renderer
// =============================================================================

interface ThinkingRendererProps {
  text: string;
  className?: string;
}

/**
 * Renders thinking/reasoning content.
 * Only shows animated spinner when agent is actively running.
 */
function ThinkingRenderer({ text, className }: ThinkingRendererProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const isRunning = useAgentRunning();

  // Show truncated version if long
  const shouldTruncate = text.length > 200;
  const displayText = shouldTruncate && !isExpanded ? `${text.slice(0, 200)}...` : text;

  return (
    <div
      className={cn(
        'rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-2',
        className
      )}
    >
      <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
        <Loader2 className={cn('h-3 w-3', isRunning && 'animate-spin')} />
        <span>Thinking</span>
      </div>
      <div className="text-sm text-muted-foreground italic whitespace-pre-wrap">{displayText}</div>
      {shouldTruncate && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs text-primary hover:underline mt-1"
        >
          {isExpanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

// =============================================================================
// System Message Renderer
// =============================================================================

interface SystemMessageRendererProps {
  message: ClaudeMessage;
  className?: string;
}

/**
 * Renders system messages (init, status, etc.).
 */
function SystemMessageRenderer({ message, className }: SystemMessageRendererProps) {
  // System init messages with tools
  if (message.subtype === 'init' && message.tools) {
    return (
      <div className={cn('text-xs text-muted-foreground', className)}>
        <span>Session initialized with {message.tools.length} tools</span>
        {message.model && <span className="ml-2">Model: {message.model}</span>}
      </div>
    );
  }

  // Other system messages - usually don't need to be shown
  return null;
}

// =============================================================================
// Text Renderer
// =============================================================================

interface TextRendererProps {
  text: string;
}

/**
 * Renders text content with full markdown support.
 */
function TextRenderer({ text }: TextRendererProps) {
  return <MarkdownRenderer content={text} />;
}

// =============================================================================
// Message Wrapper
// =============================================================================

interface MessageWrapperProps {
  chatMessage: ChatMessage;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wrapper component for consistent message styling.
 */
export function MessageWrapper({ chatMessage, children, className }: MessageWrapperProps) {
  const isUser = chatMessage.source === 'user';

  return (
    <div className={cn('flex gap-3 py-2', isUser ? 'flex-row-reverse' : '', className)}>
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'
        )}
      >
        {isUser ? <span className="text-xs font-medium">U</span> : <Bot className="h-4 w-4" />}
      </div>
      <div className={cn('flex-1 min-w-0', isUser ? 'text-right' : '')}>{children}</div>
    </div>
  );
}

// =============================================================================
// Loading Indicator
// =============================================================================

interface LoadingIndicatorProps {
  className?: string;
}

/**
 * Shows a loading/typing indicator when the agent is processing.
 */
export function LoadingIndicator({ className }: LoadingIndicatorProps) {
  return (
    <div className={cn('flex items-center gap-2 text-muted-foreground', className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">Agent is working...</span>
    </div>
  );
}
