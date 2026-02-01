'use client';

import { X } from 'lucide-react';
import { memo } from 'react';
import { AttachmentPreview } from '@/components/chat/attachment-preview';
import type { ChatMessage, GroupedMessageItem } from '@/lib/claude-types';
import { extractTextFromMessage, isToolSequence, THINKING_SUFFIX } from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import { CopyMessageButton } from './copy-message-button';
import { AssistantMessageRenderer, MessageWrapper } from './message-renderers';
import { ToolSequenceGroup } from './tool-renderers';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Strips the thinking suffix from user message text for display.
 * This is appended when thinking mode is enabled but shouldn't be shown in the UI.
 */
function stripThinkingSuffix(text: string | undefined): string {
  if (!text) {
    return '';
  }
  if (text.endsWith(THINKING_SUFFIX)) {
    return text.slice(0, -THINKING_SUFFIX.length);
  }
  return text;
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
}

export const MessageItem = memo(function MessageItem({
  message,
  isQueued,
  onRemove,
}: MessageItemProps) {
  // User messages
  if (message.source === 'user') {
    const userText = stripThinkingSuffix(message.text);
    return (
      <MessageWrapper>
        <div
          className={cn(
            'group relative inline-block max-w-full space-y-2',
            isQueued && 'opacity-50'
          )}
        >
          {/* Cancel button for queued messages - at message level so it works for text and attachment-only messages */}
          {isQueued && onRemove && (
            <button
              onClick={onRemove}
              className={cn(
                'absolute -top-1 -right-1 p-1.5 rounded-md',
                'bg-background/90 hover:bg-destructive/10',
                'border border-border hover:border-destructive/50',
                'shadow-sm',
                'opacity-0 group-hover:opacity-100',
                'transition-all',
                'z-10',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
              title="Cancel queued message"
              type="button"
              aria-label="Cancel queued message"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          )}
          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <AttachmentPreview attachments={message.attachments} readOnly />
          )}
          {/* Text */}
          {message.text && (
            <div className="group relative inline-block max-w-full">
              <div className="rounded bg-background border border-border px-3 py-2 break-words text-sm text-left whitespace-pre-wrap">
                {userText}
              </div>
              {userText && <CopyMessageButton textContent={userText} />}
            </div>
          )}
        </div>
      </MessageWrapper>
    );
  }

  // Claude messages
  if (message.message) {
    const assistantText = extractTextFromMessage(message.message);
    return (
      <MessageWrapper>
        {assistantText ? (
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
}

/**
 * Renders either a regular message or a tool sequence group.
 */
export const GroupedMessageItemRenderer = memo(function GroupedMessageItemRenderer({
  item,
  isQueued,
  onRemove,
}: GroupedMessageItemRendererProps) {
  if (isToolSequence(item)) {
    return <ToolSequenceGroup sequence={item} />;
  }
  return <MessageItem message={item} isQueued={isQueued} onRemove={onRemove} />;
});
