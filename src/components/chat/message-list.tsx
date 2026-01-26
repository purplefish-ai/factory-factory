'use client';

import { useEffect, useRef } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import type { ChatMessage, MessageGroup } from '@/lib/claude-types';
import { groupMessages } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

import { MessageRenderer } from './message-renderer';

// =============================================================================
// Types
// =============================================================================

interface MessageListProps {
  messages: ChatMessage[];
  running?: boolean;
  messagesEndRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
}

interface MessageGroupRendererProps {
  group: MessageGroup;
  isLastGroup: boolean;
  running?: boolean;
}

// =============================================================================
// Helper Components
// =============================================================================

/**
 * Renders a group of messages.
 */
function MessageGroupRenderer({ group, isLastGroup, running }: MessageGroupRendererProps) {
  const isUserGroup = group.type === 'user';
  const isToolGroup = group.type === 'tool_group';
  const isAssistantGroup = group.type === 'assistant';

  // Determine if the last message in this group should show streaming cursor
  const lastMessageIndex = group.messages.length - 1;
  const shouldShowStreamingOnLast = isLastGroup && running && !isUserGroup;

  return (
    <div
      className={cn(
        'flex flex-col gap-1',
        isUserGroup && 'items-end',
        (isAssistantGroup || isToolGroup) && 'items-start'
      )}
    >
      {group.messages.map((message, index) => {
        const isLastMessage = index === lastMessageIndex;
        const isStreaming = shouldShowStreamingOnLast && isLastMessage;

        return <MessageRenderer key={message.id} message={message} isStreaming={isStreaming} />;
      })}
    </div>
  );
}

/**
 * Empty state when there are no messages.
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <div className="text-muted-foreground space-y-2">
        <p className="text-lg font-medium">No messages yet</p>
        <p className="text-sm">Start a conversation by typing a message below.</p>
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Main message list component that displays chat messages.
 * Groups messages intelligently and handles auto-scrolling.
 */
export function MessageList({
  messages,
  running = false,
  messagesEndRef,
  className,
}: MessageListProps) {
  // Local ref for scrolling if none provided
  const localEndRef = useRef<HTMLDivElement>(null);
  const endRef = messagesEndRef ?? localEndRef;
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Track if user is near bottom for auto-scroll
  const isNearBottomRef = useRef(true);

  // Auto-scroll to bottom when messages change, but only if user is near bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: We intentionally trigger on messages.length changes
  useEffect(() => {
    if (isNearBottomRef.current && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, endRef]);

  // Handle scroll to detect if user is near bottom
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const threshold = 100; // pixels from bottom
    const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < threshold;
    isNearBottomRef.current = isNearBottom;
  };

  // Group messages for rendering
  const groups = groupMessages(messages);

  if (messages.length === 0) {
    return (
      <div className={cn('flex-1 overflow-hidden', className)}>
        <EmptyState />
      </div>
    );
  }

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div ref={scrollContainerRef} className="flex flex-col gap-4 p-4" onScroll={handleScroll}>
        {groups.map((group, index) => (
          <MessageGroupRenderer
            key={group.id}
            group={group}
            isLastGroup={index === groups.length - 1}
            running={running}
          />
        ))}
        <div ref={endRef} className="h-px" />
      </div>
    </ScrollArea>
  );
}
