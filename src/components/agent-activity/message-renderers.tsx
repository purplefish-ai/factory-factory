'use client';

/**
 * Message type renderers for agent activity
 * Extends chat renderers with agent-specific formatting
 */

import type { ClaudeMessage } from '../chat/types';

/** Render assistant text message */
export function AssistantMessageRenderer({ message }: { message: ClaudeMessage }) {
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

/** Render result stats (tokens, duration, cost) */
export function ResultRenderer({ message }: { message: ClaudeMessage }) {
  const usage = message.usage as { input_tokens?: number; output_tokens?: number };
  const durationMs = message.duration_ms as number;
  const costUsd = message.total_cost_usd as number;

  const totalTokens = (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
  // Format cost - show cents if < $0.01
  const costDisplay = costUsd < 0.01 ? `${(costUsd * 100).toFixed(2)}c` : `$${costUsd.toFixed(4)}`;

  return (
    <div className="text-xs text-muted-foreground flex items-center gap-3 py-1 border-t border-border/50 mt-2 pt-2">
      <span>{totalTokens.toLocaleString()} tokens</span>
      <span className="text-border">|</span>
      <span>{((durationMs || 0) / 1000).toFixed(1)}s</span>
      <span className="text-border">|</span>
      <span>{costDisplay}</span>
    </div>
  );
}

/** Render system message */
export function SystemMessageRenderer({ message }: { message: ClaudeMessage }) {
  return (
    <div className="p-2 text-xs text-muted-foreground italic text-center">
      {message.message as string}
    </div>
  );
}

/** Render error message */
export function ErrorRenderer({ message }: { message: ClaudeMessage }) {
  return (
    <div className="p-4 bg-red-50 dark:bg-red-950/30 rounded-lg border border-red-200 dark:border-red-800">
      <div className="text-sm font-medium text-red-700 dark:text-red-300">Error</div>
      <div className="text-sm text-red-600 dark:text-red-400 mt-1">{message.error as string}</div>
    </div>
  );
}

/** Render streaming text delta */
export function StreamDeltaRenderer({ message }: { message: ClaudeMessage }) {
  const delta = message.delta as { text?: string };
  if (!delta?.text) {
    return null;
  }

  return <span className="prose prose-sm dark:prose-invert whitespace-pre-wrap">{delta.text}</span>;
}

/** Dispatch to appropriate renderer based on message type */
export function MessageRenderer({ message }: { message: ClaudeMessage }) {
  switch (message.type) {
    case 'assistant':
      return <AssistantMessageRenderer message={message} />;
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
