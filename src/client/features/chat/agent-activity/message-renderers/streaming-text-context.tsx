import { createContext, type ReactNode, useContext } from 'react';

const StreamingTextContext = createContext<string | null>(null);

/**
 * Identifies the transcript message whose text may still be growing: the last
 * message while the agent is running. Its Markdown renders from a throttled
 * snapshot; every other message renders its exact text.
 */
export function StreamingTextProvider({
  streamingMessageId,
  children,
}: {
  streamingMessageId: string | null;
  children: ReactNode;
}) {
  return (
    <StreamingTextContext.Provider value={streamingMessageId}>
      {children}
    </StreamingTextContext.Provider>
  );
}

export function useIsTextStreaming(messageId: string | undefined): boolean {
  const streamingMessageId = useContext(StreamingTextContext);
  return messageId !== undefined && messageId === streamingMessageId;
}
