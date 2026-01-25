'use client';

/**
 * Message grouping and group renderers
 */

import { MessageRenderer } from './message-renderers';
import { groupMessages } from './message-utils';
import { ToolCallGroupRenderer } from './tool-renderers';
import type { ChatMessage, ClaudeMessage } from './types';
import { UserMessage } from './user-message';

/** Render a group of assistant messages */
export function AssistantGroupRenderer({ messages }: { messages: ChatMessage[] }) {
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

/** Render grouped messages */
export function GroupedMessages({ messages }: { messages: ChatMessage[] }) {
  const groups = groupMessages(messages);

  return (
    <>
      {groups.map((group) => {
        if (group.type === 'user') {
          return <UserMessage key={group.id} text={group.messages[0].text || ''} />;
        }
        if (group.type === 'tool_group') {
          const toolMessages = group.messages
            .map((m) => m.message)
            .filter((m): m is ClaudeMessage => m !== undefined);
          return <ToolCallGroupRenderer key={group.id} messages={toolMessages} />;
        }
        return <AssistantGroupRenderer key={group.id} messages={group.messages} />;
      })}
    </>
  );
}
