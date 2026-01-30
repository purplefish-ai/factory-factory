'use client';

import { memo } from 'react';
import { AttachmentPreview } from '@/components/chat/attachment-preview';
import type { ChatMessage, GroupedMessageItem } from '@/lib/claude-types';
import { extractTextFromMessage, isToolSequence, THINKING_SUFFIX } from '@/lib/claude-types';
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
}

export const MessageItem = memo(function MessageItem({ message }: MessageItemProps) {
  // User messages
  if (message.source === 'user') {
    const userText = stripThinkingSuffix(message.text);
    return (
      <MessageWrapper>
        <div className="inline-block max-w-full space-y-2">
          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <AttachmentPreview attachments={message.attachments} readOnly />
          )}
          {/* Text */}
          {message.text && (
            <div className="relative inline-block max-w-full">
              <div className="rounded bg-primary dark:bg-transparent dark:border dark:border-border text-primary-foreground dark:text-foreground px-3 py-2 break-words text-sm text-left whitespace-pre-wrap">
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
          <div className="relative">
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
}

/**
 * Renders either a regular message or a tool sequence group.
 */
export const GroupedMessageItemRenderer = memo(function GroupedMessageItemRenderer({
  item,
}: GroupedMessageItemRendererProps) {
  if (isToolSequence(item)) {
    return <ToolSequenceGroup sequence={item} />;
  }
  return <MessageItem message={item} />;
});
