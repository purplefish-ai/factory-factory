import { Loader2 } from 'lucide-react';
import { memo } from 'react';
import { ToolInfoRenderer } from '@/components/agent-activity/tool-renderers';
import { MarkdownRenderer } from '@/components/ui/markdown';
import type { AgentMessage } from '@/lib/chat-protocol';
import {
  extractTextFromMessage,
  isThinkingContent,
  isToolResultMessage,
  isToolUseMessage,
} from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
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
  message: AgentMessage;
  /** The ID of the ChatMessage containing this AgentMessage (for thinking completion tracking) */
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
    const firstContent = contentItems[0];
    if (contentItems.length === 1 && firstContent && isThinkingContent(firstContent)) {
      return (
        <ThinkingRenderer
          text={firstContent.thinking}
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
  message: AgentMessage;
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
  latestReasoning?: string | null;
  className?: string;
}

const LOADING_TEXT_MAX_LENGTH = 200;
const LOADING_TEXT_ELLIPSIS = '...';
const LOADING_TEXT_BODY_MAX_LENGTH = LOADING_TEXT_MAX_LENGTH - LOADING_TEXT_ELLIPSIS.length;

function countMatches(input: string, pattern: RegExp): number {
  return (input.match(pattern) ?? []).length;
}

function hasUnbalancedMarkdown(input: string): boolean {
  if (input.length === 0) {
    return false;
  }

  const withoutInlineWordUnderscores = input.replace(/(?<=\w)_(?=\w)/g, '');

  if (countMatches(input, /(?<!\\)`/g) % 2 !== 0) {
    return true;
  }

  if (countMatches(input, /(?<!\\)\*\*/g) % 2 !== 0) {
    return true;
  }

  const withoutDoubleAsterisks = input.replace(/(?<!\\)\*\*/g, '');
  if (countMatches(withoutDoubleAsterisks, /(?<!\\)\*/g) % 2 !== 0) {
    return true;
  }

  if (countMatches(withoutInlineWordUnderscores, /(?<!\\)__/g) % 2 !== 0) {
    return true;
  }

  const withoutDoubleUnderscores = withoutInlineWordUnderscores.replace(/(?<!\\)__/g, '');
  if (countMatches(withoutDoubleUnderscores, /(?<!\\)_/g) % 2 !== 0) {
    return true;
  }

  if (countMatches(input, /(?<!\\)~~/g) % 2 !== 0) {
    return true;
  }

  const lastChar = input[input.length - 1];
  return lastChar === '*' || lastChar === '_' || lastChar === '`' || lastChar === '~';
}

function stripMarkdownSyntax(input: string): string {
  return input
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(?<!\\)`([^`]+)`/g, '$1')
    .replace(/(?<!\\)\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\\)\*([^*]+)\*/g, '$1')
    .replace(/(?<!\\)__([^_]+)__/g, '$1')
    .replace(/(?<!\\)_([^_]+)_/g, '$1')
    .replace(/(?<!\\)~~([^~]+)~~/g, '$1')
    .replace(/(?<!\\)[`~*_]/g, '');
}

function truncateLoadingText(input: string): string {
  if (input.length <= LOADING_TEXT_MAX_LENGTH) {
    return input;
  }

  const truncated = input.slice(0, LOADING_TEXT_BODY_MAX_LENGTH).trimEnd();
  if (!hasUnbalancedMarkdown(truncated)) {
    return `${truncated}${LOADING_TEXT_ELLIPSIS}`;
  }

  const stripped = stripMarkdownSyntax(truncated).trimEnd();
  return `${stripped}${LOADING_TEXT_ELLIPSIS}`;
}

function getLoadingText(latestReasoning: string | null | undefined): string {
  const normalized = latestReasoning?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Agent is working...';
  }
  return truncateLoadingText(normalized);
}

/**
 * Shows a loading/typing indicator when the agent is processing.
 */
export const LoadingIndicator = memo(function LoadingIndicator({
  latestReasoning = null,
  className,
}: LoadingIndicatorProps) {
  const loadingText = getLoadingText(latestReasoning);
  return (
    <div className={cn('flex items-start gap-2 text-muted-foreground', className)}>
      <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />
      <MarkdownRenderer
        content={loadingText}
        className="min-w-0 flex-1 text-muted-foreground text-sm leading-normal [&_p]:m-0 [&_ul]:my-0 [&_ol]:my-0"
      />
    </div>
  );
});
