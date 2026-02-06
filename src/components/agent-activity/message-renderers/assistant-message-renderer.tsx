import { Loader2 } from 'lucide-react';
import { memo } from 'react';
import { MarkdownRenderer } from '@/components/ui/markdown';
import type { ClaudeMessage } from '@/lib/claude-types';
import {
  extractTextFromMessage,
  isThinkingContent,
  isToolResultMessage,
  isToolUseMessage,
} from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import { ToolInfoRenderer } from '../tool-renderers';
import {
  ErrorRenderer,
  ResultRenderer,
  StreamEventRenderer,
  SystemMessageRenderer,
  ThinkingRenderer,
} from './stream-event-renderer';

// =============================================================================
// Assistant Message Renderer
// =============================================================================

interface AssistantMessageRendererProps {
  message: ClaudeMessage;
  /** The ID of the ChatMessage containing this ClaudeMessage (for thinking completion tracking) */
  messageId?: string;
  className?: string;
}

/**
 * Renders an assistant message, handling different message types.
 */
export const AssistantMessageRenderer = memo(function AssistantMessageRenderer({
  message,
  messageId,
  className,
}: AssistantMessageRendererProps) {
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
    return (
      <StreamEventRenderer event={message.event} messageId={messageId} className={className} />
    );
  }

  if (message.message && Array.isArray(message.message.content)) {
    const contentItems = message.message.content;
    // biome-ignore lint/style/noNonNullAssertion: length === 1 checked
    if (contentItems.length === 1 && isThinkingContent(contentItems[0]!)) {
      return (
        <ThinkingRenderer
          // biome-ignore lint/style/noNonNullAssertion: length === 1 checked
          text={contentItems[0]!.thinking}
          messageId={messageId}
          className={className}
        />
      );
    }
  }

  // Handle regular assistant/user messages with content
  const text = extractTextFromMessage(message);
  if (text) {
    return (
      <div
        className={cn('prose prose-sm dark:prose-invert max-w-none text-sm break-words', className)}
      >
        <TextRenderer text={text} />
      </div>
    );
  }

  // Fallback for system messages
  if (message.type === 'system') {
    return <SystemMessageRenderer message={message} className={className} />;
  }

  return null;
});

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
export const ToolCallRenderer = memo(function ToolCallRenderer({
  message,
  className,
}: ToolCallRendererProps) {
  return (
    <div className={cn('my-1', className)}>
      <ToolInfoRenderer message={message} />
    </div>
  );
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
// Message Wrapper
// =============================================================================

interface MessageWrapperProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Wrapper component for consistent message styling.
 */
export const MessageWrapper = memo(function MessageWrapper({
  children,
  className,
}: MessageWrapperProps) {
  return (
    <div className={cn('py-2', className)}>
      <div className="max-w-full">{children}</div>
    </div>
  );
});

// =============================================================================
// Loading Indicator
// =============================================================================

interface LoadingIndicatorProps {
  className?: string;
}

/**
 * Shows a loading/typing indicator when the agent is processing.
 */
export const LoadingIndicator = memo(function LoadingIndicator({
  className,
}: LoadingIndicatorProps) {
  return (
    <div className={cn('flex items-center gap-2 text-muted-foreground', className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">Agent is working...</span>
    </div>
  );
});
