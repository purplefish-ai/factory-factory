import * as React from 'react';

// =============================================================================
// Thinking Completion Context
// =============================================================================

interface ThinkingCompletionState {
  /**
   * The ID of the last message that contains thinking content.
   * Only this message's thinking could potentially be "in progress".
   */
  lastThinkingMessageId: string | null;
  /**
   * Whether the agent is currently running/streaming.
   */
  running: boolean;
}

const ThinkingCompletionContext = React.createContext<ThinkingCompletionState>({
  lastThinkingMessageId: null,
  running: false,
});

/**
 * Provider component for thinking completion state.
 * Determines which thinking blocks should show as "in progress" vs "complete".
 */
export function ThinkingCompletionProvider({
  lastThinkingMessageId,
  running,
  children,
}: ThinkingCompletionState & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({ lastThinkingMessageId, running }),
    [lastThinkingMessageId, running]
  );
  return (
    <ThinkingCompletionContext.Provider value={value}>
      {children}
    </ThinkingCompletionContext.Provider>
  );
}

/**
 * Hook to check if a thinking block is still in progress.
 * @param messageId - The ID of the message containing the thinking block
 * @returns true if the thinking is in progress (should animate), false if complete
 */
export function useIsThinkingInProgress(messageId: string | undefined): boolean {
  const { lastThinkingMessageId, running } = React.useContext(ThinkingCompletionContext);
  // Thinking is only "in progress" if:
  // 1. The agent is running
  // 2. AND this is the last message with thinking content
  return running && messageId != null && messageId === lastThinkingMessageId;
}
