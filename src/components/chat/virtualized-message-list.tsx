'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useRef } from 'react';
import { GroupedMessageItemRenderer, LoadingIndicator } from '@/components/agent-activity';
import type { GroupedMessageItem } from '@/lib/claude-types';

// =============================================================================
// Types
// =============================================================================

interface VirtualizedMessageListProps {
  messages: GroupedMessageItem[];
  running: boolean;
  startingSession: boolean;
  loadingSession: boolean;
  /** Ref to the scroll container (viewport) */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Called when user scrolls */
  onScroll?: () => void;
  /** Ref for scrolling to bottom */
  messagesEndRef?: React.RefObject<HTMLDivElement | null>;
  /** Whether user is near bottom of scroll - used to gate auto-scroll */
  isNearBottom?: boolean;
}

// =============================================================================
// Empty State Component
// =============================================================================

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
// Virtualized Row Component
// =============================================================================

interface VirtualRowProps {
  item: GroupedMessageItem;
  index: number;
  measureElement: (node: HTMLElement | null) => void;
}

const VirtualRow = memo(function VirtualRow({ item, index, measureElement }: VirtualRowProps) {
  return (
    <div ref={measureElement} data-index={index} className="pb-2">
      <GroupedMessageItemRenderer item={item} />
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export const VirtualizedMessageList = memo(function VirtualizedMessageList({
  messages,
  running,
  startingSession,
  loadingSession,
  scrollContainerRef,
  onScroll,
  messagesEndRef,
  isNearBottom = true,
}: VirtualizedMessageListProps) {
  const prevMessageCountRef = useRef(messages.length);
  const isAutoScrollingRef = useRef(false);
  // Track isNearBottom in a ref to avoid stale closures in effects
  const isNearBottomRef = useRef(isNearBottom);
  isNearBottomRef.current = isNearBottom;

  // Initialize virtualizer with dynamic measurement
  // Reduce overscan during active running to improve performance
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 80, // Estimated average height
    overscan: running ? 3 : 5, // Fewer items when streaming for better performance
    getItemKey: (index) => messages[index].id,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Auto-scroll to bottom when new messages are added (only if user is near bottom)
  useEffect(() => {
    const currentCount = messages.length;
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = currentCount;

    // If messages were added and user is near bottom, scroll to bottom
    if (currentCount > prevCount && isNearBottomRef.current && scrollContainerRef.current) {
      isAutoScrollingRef.current = true;
      // Use 'auto' behavior instead of smooth to prevent animation jitter during rapid updates
      virtualizer.scrollToIndex(currentCount - 1, { align: 'end', behavior: 'auto' });
      // Reset flag immediately for instant scroll
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false;
      });
    }
  }, [messages.length, virtualizer, scrollContainerRef]);

  // Handle scroll events
  const handleScroll = useCallback(() => {
    if (!isAutoScrollingRef.current) {
      onScroll?.();
    }
  }, [onScroll]);

  // Attach scroll listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollContainerRef, handleScroll]);

  // Show empty/loading states
  if (messages.length === 0) {
    if (loadingSession) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center p-8">
          <div className="flex items-center gap-2 text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading session...</span>
          </div>
        </div>
      );
    }
    if (!(running || startingSession)) {
      return <EmptyState />;
    }
  }

  return (
    <div className="p-4 min-w-0">
      {/* Virtualized message container */}
      <div
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = messages[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <VirtualRow
                item={item}
                index={virtualRow.index}
                measureElement={virtualizer.measureElement}
              />
            </div>
          );
        })}
      </div>

      {/* Loading indicators after messages */}
      {running && <LoadingIndicator className="py-4" />}

      {startingSession && !running && (
        <div className="flex items-center gap-2 text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Starting agent...</span>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={messagesEndRef} className="h-px" />
    </div>
  );
});
