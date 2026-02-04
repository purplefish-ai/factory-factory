import { AlertTriangle, Loader2 } from 'lucide-react';
import * as React from 'react';
import { memo } from 'react';
import { CompactBoundaryIndicator } from '@/components/chat/compact-boundary-indicator';
import { MarkdownRenderer } from '@/components/ui/markdown';
import type { ClaudeMessage, ClaudeStreamEvent, ContentBlockDelta } from '@/lib/claude-types';
import { isTextContent, isThinkingContent } from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import { useIsThinkingInProgress } from './thinking-completion-context';

// =============================================================================
// Stream Event Renderer
// =============================================================================

interface StreamEventRendererProps {
  event: ClaudeStreamEvent;
  /** The ID of the ChatMessage containing this event (for thinking completion tracking) */
  messageId?: string;
  className?: string;
}

/**
 * Renders a stream event, handling different event types.
 */
export const StreamEventRenderer = memo(function StreamEventRenderer({
  event,
  messageId,
  className,
}: StreamEventRendererProps) {
  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block;
      if (isTextContent(block)) {
        return (
          <div className={cn('prose prose-sm dark:prose-invert max-w-none text-sm', className)}>
            <TextRenderer text={block.text} />
          </div>
        );
      }
      if (isThinkingContent(block)) {
        return (
          <ThinkingRenderer text={block.thinking} messageId={messageId} className={className} />
        );
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
});

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
export const StreamDeltaRenderer = memo(function StreamDeltaRenderer({
  delta,
  className,
}: StreamDeltaRendererProps) {
  if (delta.type === 'text_delta') {
    return <span className={cn('', className)}>{delta.text}</span>;
  }

  if (delta.type === 'thinking_delta') {
    return <span className={cn('text-muted-foreground italic', className)}>{delta.thinking}</span>;
  }

  return null;
});

// =============================================================================
// Text Renderer
// =============================================================================

interface TextRendererProps {
  text: string;
}

/**
 * Renders text content with full markdown support.
 */
const TextRenderer = memo(function TextRenderer({ text }: TextRendererProps) {
  return <MarkdownRenderer content={text} />;
});

// =============================================================================
// Thinking Renderer
// =============================================================================

/** Default number of characters to show before truncating thinking content */
const DEFAULT_THINKING_TRUNCATE_LENGTH = 200;

interface ThinkingRendererProps {
  text: string;
  /** The ID of the ChatMessage containing this thinking block (for completion tracking) */
  messageId?: string;
  /** Number of characters to show before truncating (default: 200) */
  truncateLength?: number;
  className?: string;
}

/**
 * Renders thinking/reasoning content.
 * Only shows animated spinner when the thinking is actively in progress.
 * Completion is inferred from the chat context:
 * - If there's subsequent content after this thinking block, it's complete
 * - Only the last thinking block (while agent is running) shows animation
 */
const ThinkingRenderer = memo(function ThinkingRenderer({
  text,
  messageId,
  truncateLength = DEFAULT_THINKING_TRUNCATE_LENGTH,
  className,
}: ThinkingRendererProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const isInProgress = useIsThinkingInProgress(messageId);

  // Show truncated version if long
  const shouldTruncate = text.length > truncateLength;
  const displayText = shouldTruncate && !isExpanded ? `${text.slice(0, truncateLength)}...` : text;

  return (
    <div
      className={cn(
        'rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-2',
        className
      )}
    >
      <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
        <Loader2 className={cn('h-3 w-3', isInProgress && 'animate-spin')} />
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
});

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
export const ErrorRenderer = memo(function ErrorRenderer({
  message,
  className,
}: ErrorRendererProps) {
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
});

// =============================================================================
// System Message Renderer
// =============================================================================

interface SystemMessageRendererProps {
  message: ClaudeMessage;
  className?: string;
}

/**
 * Renders system messages (init, status, compact_boundary, hook events, etc.).
 */
export const SystemMessageRenderer = memo(function SystemMessageRenderer({
  message,
  className,
}: SystemMessageRendererProps) {
  switch (message.subtype) {
    case 'init':
      // System init messages with tools - optional display
      if (message.tools) {
        return (
          <div className={cn('text-xs text-muted-foreground', className)}>
            <span>Session initialized with {message.tools.length} tools</span>
            {message.model && <span className="ml-2">Model: {message.model}</span>}
          </div>
        );
      }
      return null;

    case 'status':
      // Status messages are handled by the reducer - no visual rendering needed
      return null;

    case 'compact_boundary':
      // Render the compact boundary indicator
      return <CompactBoundaryIndicator className={className} />;

    case 'hook_started':
    case 'hook_response':
      // Hook events are stored in state but don't need visual rendering here
      // Future hook UI (#449) can use the activeHooks state from reducer
      return null;

    default:
      // Unknown system messages - don't render
      return null;
  }
});

// =============================================================================
// Result Renderer
// =============================================================================

interface ResultRendererProps {
  message: ClaudeMessage;
  className?: string;
}

/**
 * Renders a result message, typically showing completion info.
 * Uses markdown rendering to match history-loaded message display.
 */
export const ResultRenderer = memo(function ResultRenderer({
  message,
  className,
}: ResultRendererProps) {
  // Result messages often just indicate completion; we may not need to render them visibly
  // But if there's result content, show it with proper markdown formatting
  if (message.result && typeof message.result === 'string') {
    return (
      <div className={cn('prose prose-sm dark:prose-invert max-w-none text-sm', className)}>
        <MarkdownRenderer content={message.result} />
      </div>
    );
  }

  // Don't render empty result messages
  return null;
});
