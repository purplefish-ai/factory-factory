import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { GroupedMessageItemRenderer, LoadingIndicator } from '@/components/agent-activity';
import { ThinkingCompletionProvider } from '@/components/agent-activity/message-renderers';
import {
  createToolCallExpansionKey,
  createToolSequenceExpansionKey,
  useWorkspaceToolExpansionState,
} from '@/components/agent-activity/tool-renderers/tool-expansion-state';
import type { GroupedMessageItem } from '@/lib/chat-protocol';
import { isStreamEventMessage, isToolSequence } from '@/lib/chat-protocol';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { CompactingIndicator } from './compacting-indicator';

// =============================================================================
// Types
// =============================================================================

interface VirtualizedMessageListProps {
  /** Workspace ID (enables persisted tool expansion state per workspace) */
  workspaceId?: string;
  messages: GroupedMessageItem[];
  running: boolean;
  startingSession: boolean;
  loadingSession: boolean;
  latestThinking?: string | null;
  startingLabel?: string;
  /** Ref to the scroll container (viewport) */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Called when user scrolls */
  onScroll?: () => void;
  /** Ref for scrolling to bottom */
  messagesEndRef?: React.RefObject<HTMLDivElement | null>;
  /** Whether user is near bottom of scroll - used to gate auto-scroll */
  isNearBottom?: boolean;
  /** Set of message IDs that are still queued (not yet dispatched to agent) */
  queuedMessageIds?: Set<string>;
  /** Callback to remove/cancel a queued message */
  onRemoveQueuedMessage?: (id: string) => void;
  /** Whether context compaction is in progress */
  isCompacting?: boolean;
  /** Get the SDK-assigned UUID for a user message by its stable message ID */
  getUuidForMessageId?: (messageId: string) => string | undefined;
  /** Callback when user initiates rewind to a message */
  onRewindToMessage?: (uuid: string) => void;
  /** Init banner for showing workspace initialization status */
  initBanner?: WorkspaceInitBanner | null;
}

const STICK_TO_BOTTOM_THRESHOLD = 48;

// =============================================================================
// Empty State Component
// =============================================================================

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <div className="text-muted-foreground space-y-2">
        <p className="text-lg font-medium">Ready to start</p>
        <p className="text-sm">Send a message to start the agent and begin your conversation.</p>
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
  isQueued?: boolean;
  onRemove?: () => void;
  /** SDK-assigned UUID for user messages (enables rewind functionality) */
  userMessageUuid?: string;
  /** Callback when user initiates rewind to this message */
  onRewindToMessage?: (uuid: string) => void;
  /** Reads persisted expansion state for tool rows/groups */
  getToolExpansionState?: (key: string, defaultOpen: boolean) => boolean;
  /** Persists expansion state for tool rows/groups */
  setToolExpansionState?: (key: string, open: boolean) => void;
  /** Per-row token used to rerender row when this row's tool expansion state changes */
  toolExpansionToken?: string;
}

const VirtualRow = memo(function VirtualRow({
  item,
  index,
  measureElement,
  isQueued,
  onRemove,
  userMessageUuid,
  onRewindToMessage,
  getToolExpansionState,
  setToolExpansionState,
  toolExpansionToken,
}: VirtualRowProps) {
  return (
    <div ref={measureElement} data-index={index} className="pb-2">
      <GroupedMessageItemRenderer
        item={item}
        isQueued={isQueued}
        onRemove={onRemove}
        userMessageUuid={userMessageUuid}
        onRewindToMessage={onRewindToMessage}
        getToolExpansionState={getToolExpansionState}
        setToolExpansionState={setToolExpansionState}
        toolExpansionToken={toolExpansionToken}
      />
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export const VirtualizedMessageList = memo(function VirtualizedMessageList({
  workspaceId,
  messages,
  running,
  startingSession,
  loadingSession,
  latestThinking = null,
  startingLabel = 'Starting agent...',
  scrollContainerRef,
  onScroll,
  messagesEndRef,
  isNearBottom = true,
  queuedMessageIds,
  onRemoveQueuedMessage,
  isCompacting = false,
  getUuidForMessageId,
  onRewindToMessage,
  initBanner,
}: VirtualizedMessageListProps) {
  const { getExpansionState, setExpansionState } = useWorkspaceToolExpansionState(workspaceId);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const prevMessageCountRef = useRef(messages.length);
  const prevLatestThinkingRef = useRef<string | null>(latestThinking);
  const loadingSessionRef = useRef(loadingSession);
  const resizeStickRafRef = useRef<number | null>(null);
  const newMessagePinRafRef = useRef<number | null>(null);
  // Track isNearBottom in a ref to avoid stale closures in effects
  const isNearBottomRef = useRef(isNearBottom);
  isNearBottomRef.current = isNearBottom;
  loadingSessionRef.current = loadingSession;
  const showingInitSpinner = initBanner?.kind === 'info';
  const hasScrollableContent =
    messages.length > 0 || running || startingSession || showingInitSpinner;
  const getToolExpansionState = workspaceId ? getExpansionState : undefined;
  const setToolExpansionState = workspaceId ? setExpansionState : undefined;
  const getToolExpansionToken = useCallback(
    (item: GroupedMessageItem): string | undefined => {
      if (!(workspaceId && getToolExpansionState && isToolSequence(item))) {
        return undefined;
      }

      const sequenceDefaultOpen = item.pairedCalls.length > 1;
      const sequenceState = getToolExpansionState(
        createToolSequenceExpansionKey(item.id),
        sequenceDefaultOpen
      )
        ? '1'
        : '0';
      const callState = item.pairedCalls
        .map((call) =>
          getToolExpansionState(createToolCallExpansionKey(item.id, call.id), false) ? '1' : '0'
        )
        .join('');

      return `${sequenceState}:${callState}`;
    },
    [workspaceId, getToolExpansionState]
  );

  const lastThinkingMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const item = messages[i];
      if (!item) {
        continue;
      }
      if (isToolSequence(item)) {
        continue;
      }
      if (!(item.message && isStreamEventMessage(item.message))) {
        continue;
      }
      const event = item.message.event;
      if (event?.type === 'content_block_start' && event.content_block.type === 'thinking') {
        return item.id;
      }
    }
    return null;
  }, [messages]);

  // Initialize virtualizer with dynamic measurement
  // Reduce overscan during active running to improve performance
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 80, // Estimated average height
    overscan: running ? 3 : 5, // Fewer items when streaming for better performance
    getItemKey: (index) => {
      const message = messages[index];
      return message ? message.id : `missing-message-${index}`;
    },
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const stickToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [scrollContainerRef]);

  // Auto-scroll to bottom when new messages are added (only if user is near bottom)
  useEffect(() => {
    const currentCount = messages.length;
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = currentCount;

    // Let hydration/scroll-restore settle before auto-scroll logic runs.
    // Running virtualizer scroll commands during loading can apply stale offsets.
    if (loadingSession) {
      return;
    }

    // If messages were added and user was near bottom at append time, scroll to bottom.
    // This snapshot prevents programmatic scroll events from clearing the follow-up pin.
    const shouldPinAfterAppend =
      currentCount > prevCount && isNearBottomRef.current && !!scrollContainerRef.current;
    if (shouldPinAfterAppend) {
      if (newMessagePinRafRef.current !== null) {
        cancelAnimationFrame(newMessagePinRafRef.current);
        newMessagePinRafRef.current = null;
      }
      // Use 'auto' behavior instead of smooth to prevent animation jitter during rapid updates
      // Wrap in try-catch to handle edge cases where scroll element becomes null during unmount
      // or rapid component updates (see: https://github.com/TanStack/virtual/issues/696)
      try {
        virtualizer.scrollToIndex(currentCount - 1, { align: 'end', behavior: 'auto' });
      } catch {
        // Scroll element likely became null during unmount - safe to ignore.
      }
      // Pin to real bottom after measurement/layout settles.
      newMessagePinRafRef.current = requestAnimationFrame(() => {
        newMessagePinRafRef.current = null;
        if (!(shouldPinAfterAppend && isNearBottomRef.current) || loadingSessionRef.current) {
          return;
        }
        stickToBottom();
      });
    }
  }, [loadingSession, messages.length, scrollContainerRef, stickToBottom, virtualizer]);

  // Cancel pending append pins when switching into loading/hydration states.
  useEffect(() => {
    if (!loadingSession) {
      return;
    }
    if (newMessagePinRafRef.current !== null) {
      cancelAnimationFrame(newMessagePinRafRef.current);
      newMessagePinRafRef.current = null;
    }
  }, [loadingSession]);

  // Keep viewport pinned when inline reasoning text grows while user is at bottom.
  useEffect(() => {
    const prevLatestThinking = prevLatestThinkingRef.current;
    prevLatestThinkingRef.current = latestThinking;

    if (loadingSession || !isNearBottomRef.current) {
      return;
    }
    if (latestThinking === null || latestThinking === prevLatestThinking) {
      return;
    }

    const container = scrollContainerRef.current;
    if (container) {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom >= -1 && distanceFromBottom <= 1) {
        return;
      }
    }

    stickToBottom();
  }, [latestThinking, loadingSession, scrollContainerRef, stickToBottom]);

  // Keep viewport pinned while content grows (e.g., large messages/images/measurements)
  // when the user is already at the bottom.
  useEffect(() => {
    if (loadingSession || typeof ResizeObserver === 'undefined' || !hasScrollableContent) {
      return;
    }

    const content = contentRef.current;
    if (!content) {
      return;
    }

    let previousContentHeight: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const nextContentHeight = entry.contentRect.height;
      if (previousContentHeight === null) {
        // Seed baseline from ResizeObserver's content-box measurements.
        previousContentHeight = nextContentHeight;
        return;
      }

      const growthAmount = nextContentHeight - previousContentHeight;
      const grew = growthAmount > 0;
      previousContentHeight = nextContentHeight;
      if (!grew) {
        return;
      }

      const container = scrollContainerRef.current;
      if (!container) {
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const wasNearBottomBeforeGrowth =
        distanceFromBottom - growthAmount < STICK_TO_BOTTOM_THRESHOLD;
      if (!wasNearBottomBeforeGrowth) {
        return;
      }
      if (resizeStickRafRef.current !== null) {
        return;
      }
      resizeStickRafRef.current = requestAnimationFrame(() => {
        resizeStickRafRef.current = null;
        if (loadingSessionRef.current) {
          return;
        }
        stickToBottom();
      });
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
      if (resizeStickRafRef.current !== null) {
        cancelAnimationFrame(resizeStickRafRef.current);
        resizeStickRafRef.current = null;
      }
    };
  }, [hasScrollableContent, loadingSession, scrollContainerRef, stickToBottom]);

  useEffect(() => {
    if (!loadingSession) {
      return;
    }
    if (resizeStickRafRef.current !== null) {
      cancelAnimationFrame(resizeStickRafRef.current);
      resizeStickRafRef.current = null;
    }
  }, [loadingSession]);

  useEffect(
    () => () => {
      if (resizeStickRafRef.current !== null) {
        cancelAnimationFrame(resizeStickRafRef.current);
      }
      if (newMessagePinRafRef.current !== null) {
        cancelAnimationFrame(newMessagePinRafRef.current);
      }
    },
    []
  );

  // Handle scroll events
  const handleScroll = useCallback(() => {
    onScroll?.();
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

  // Show loading state while session is loading (prevents flicker during event replay)
  // If there's also an init banner, show both spinners
  if (loadingSession) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8 gap-4">
        {showingInitSpinner && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{initBanner?.message}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-sm">Loading session...</span>
        </div>
      </div>
    );
  }

  // Show empty state if no messages and not starting/initializing
  if (!hasScrollableContent) {
    return <EmptyState />;
  }

  return (
    <ThinkingCompletionProvider lastThinkingMessageId={lastThinkingMessageId} running={running}>
      <div ref={contentRef} className="p-4 min-w-0">
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
            if (!item) {
              return null;
            }
            const isQueued = queuedMessageIds?.has(item.id) ?? false;
            // Get UUID for user messages to enable rewind functionality
            // Use message ID (stable identifier) instead of array index to avoid issues
            // when messages are grouped or filtered
            const userMessageUuid =
              'source' in item && item.source === 'user'
                ? getUuidForMessageId?.(item.id)
                : undefined;
            const toolExpansionToken = getToolExpansionToken(item);
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
                  isQueued={isQueued}
                  onRemove={
                    isQueued && onRemoveQueuedMessage
                      ? () => onRemoveQueuedMessage(item.id)
                      : undefined
                  }
                  userMessageUuid={userMessageUuid}
                  onRewindToMessage={onRewindToMessage}
                  getToolExpansionState={getToolExpansionState}
                  setToolExpansionState={setToolExpansionState}
                  toolExpansionToken={toolExpansionToken}
                />
              </div>
            );
          })}
        </div>

        {/* Context compaction indicator */}
        <CompactingIndicator isCompacting={isCompacting} className="mb-4" />

        {/* Workspace initialization spinner (e.g., creating worktree, running init script) */}
        {initBanner && initBanner.kind === 'info' && (
          <div className="flex items-center gap-2 text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{initBanner.message}</span>
          </div>
        )}

        {/* Agent starting spinner */}
        {startingSession && !running && (
          <div className="flex items-center gap-2 text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{startingLabel}</span>
          </div>
        )}

        {/* Loading indicators after messages */}
        {running && <LoadingIndicator latestReasoning={latestThinking} className="py-4" />}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} className="h-px" />
      </div>
    </ThinkingCompletionProvider>
  );
});
