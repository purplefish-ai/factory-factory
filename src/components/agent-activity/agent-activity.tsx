import { Copy, RotateCcw, X } from 'lucide-react';
import { memo } from 'react';
import { AttachmentPreview } from '@/components/chat/attachment-preview';
import type { ChatMessage, GroupedMessageItem } from '@/lib/chat-protocol';
import { extractTextFromMessage, isThinkingContent, isToolSequence } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { CopyMessageButton } from './copy-message-button';
import { AssistantMessageRenderer, MessageWrapper } from './message-renderers';
import { ToolSequenceGroup } from './tool-renderers';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Gets message text for display, handling undefined values.
 */
function getMessageText(text: string | undefined): string {
  return text ?? '';
}

function getAssistantCopyText(message: ChatMessage['message']): string | null {
  if (!message) {
    return null;
  }

  const extracted = extractTextFromMessage(message);
  if (extracted) {
    return extracted;
  }

  if (
    message.message &&
    Array.isArray(message.message.content) &&
    message.message.content.length === 1
  ) {
    const firstContent = message.message.content[0];
    if (firstContent && isThinkingContent(firstContent)) {
      return firstContent.thinking;
    }
  }

  return null;
}

// =============================================================================
// Message Item
// =============================================================================

export interface MessageItemProps {
  message: ChatMessage;
  /** Whether this message is still queued (not yet dispatched to agent) */
  isQueued?: boolean;
  /** Callback to cancel/remove this queued message */
  onRemove?: () => void;
  /** SDK-assigned UUID for this user message (enables rewind functionality) */
  userMessageUuid?: string;
  /** Callback to initiate rewind to before this message */
  onRewindToMessage?: (uuid: string) => void;
}

export const MessageItem = memo(function MessageItem({
  message,
  isQueued,
  onRemove,
  userMessageUuid,
  onRewindToMessage,
}: MessageItemProps) {
  // User messages
  if (message.source === 'user') {
    const userText = getMessageText(message.text);
    return (
      <MessageWrapper>
        {/* Wrapper for positioning action buttons outside opacity container */}
        <div className="group relative w-full max-w-full">
          {/* Action buttons group - positioned at top-right, outside opacity container */}
          <div
            className={cn(
              'absolute -top-1 -right-1 flex items-center gap-1',
              'opacity-0 group-hover:opacity-100',
              'transition-all',
              'z-10'
            )}
          >
            {/* Copy button */}
            {userText && (
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(userText);
                  } catch {
                    // Silently fail
                  }
                }}
                onMouseDown={(e) => e.preventDefault()}
                className={cn(
                  'p-1.5 rounded-md',
                  'bg-background/90 hover:bg-background',
                  'border border-border',
                  'shadow-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
                title="Copy to clipboard"
                type="button"
                aria-label="Copy message to clipboard"
              >
                <Copy className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
              </button>
            )}
            {/* Rewind button for messages with tracked UUIDs */}
            {userMessageUuid && onRewindToMessage && (
              <button
                onClick={() => onRewindToMessage(userMessageUuid)}
                onMouseDown={(e) => e.preventDefault()}
                className={cn(
                  'p-1.5 rounded-md',
                  'bg-background/90 hover:bg-amber-50 dark:hover:bg-amber-900/20',
                  'border border-border hover:border-amber-500/50',
                  'shadow-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
                title="Rewind files to before this message"
                type="button"
                aria-label="Rewind files to before this message"
              >
                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400" />
              </button>
            )}
            {/* Cancel button for queued messages */}
            {isQueued && onRemove && (
              <button
                onClick={onRemove}
                className={cn(
                  'p-1.5 rounded-md',
                  'bg-background/90 hover:bg-destructive/10',
                  'border border-border hover:border-destructive/50',
                  'shadow-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
                title="Cancel queued message"
                type="button"
                aria-label="Cancel queued message"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            )}
          </div>
          {/* Message content - opacity applied here to fade queued messages without affecting buttons */}
          <div className={cn('space-y-2', isQueued && 'opacity-50')}>
            {/* Attachments */}
            {message.attachments && message.attachments.length > 0 && (
              <AttachmentPreview attachments={message.attachments} readOnly />
            )}
            {/* Text */}
            {message.text && (
              <div className="relative w-full max-w-full">
                <div className="w-full rounded border border-border/70 bg-muted/35 px-3 py-2 break-words text-sm text-left whitespace-pre-wrap">
                  {userText}
                </div>
              </div>
            )}
          </div>
        </div>
      </MessageWrapper>
    );
  }

  // Claude messages
  if (message.message) {
    const assistantText = getAssistantCopyText(message.message);
    return (
      <MessageWrapper>
        {assistantText !== null ? (
          <div className="group relative">
            <AssistantMessageRenderer message={message.message} messageId={message.id} />
            <CopyMessageButton textContent={assistantText} />
          </div>
        ) : (
          <AssistantMessageRenderer message={message.message} messageId={message.id} />
        )}
      </MessageWrapper>
    );
  }

  return null;
});

// =============================================================================
// Grouped Message Item Renderer
// =============================================================================

export interface GroupedMessageItemRendererProps {
  item: GroupedMessageItem;
  /** Whether this message is still queued (not yet dispatched to agent) */
  isQueued?: boolean;
  /** Callback to cancel/remove this queued message */
  onRemove?: () => void;
  /** SDK-assigned UUID for user messages (enables rewind functionality) */
  userMessageUuid?: string;
  /** Callback to initiate rewind to before this message */
  onRewindToMessage?: (uuid: string) => void;
}

/**
 * Renders either a regular message or a tool sequence group.
 */
export const GroupedMessageItemRenderer = memo(function GroupedMessageItemRenderer({
  item,
  isQueued,
  onRemove,
  userMessageUuid,
  onRewindToMessage,
}: GroupedMessageItemRendererProps) {
  if (isToolSequence(item)) {
    return <ToolSequenceGroup sequence={item} summaryOrder="latest-first" />;
  }
  return (
    <MessageItem
      message={item}
      isQueued={isQueued}
      onRemove={onRemove}
      userMessageUuid={userMessageUuid}
      onRewindToMessage={onRewindToMessage}
    />
  );
});
