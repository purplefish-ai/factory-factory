import { ChatsCircleIcon } from '@phosphor-icons/react/dist/csr/ChatsCircle';
import { useEffect, useRef } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { GroupedMessageItemRenderer } from '@/client/features/chat';
import { trpc } from '@/client/lib/trpc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { parseClosedSessionReadTranscript } from '@/shared/acp-protocol/protocol/closed-session-transcript-schema';
import { projectClosedSessionTranscriptRows } from './closed-session-transcript-items';

interface ClosedSessionTranscriptViewProps {
  sessionId: string;
}

export function ClosedSessionTranscriptView({ sessionId }: ClosedSessionTranscriptViewProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const {
    data: transcript,
    isLoading,
    error,
    isFetching,
    refetch,
  } = trpc.closedSessions.getTranscriptJson.useQuery(
    { id: sessionId },
    { select: parseClosedSessionReadTranscript, structuralSharing: false }
  );

  // Auto-scroll to bottom when transcript loads
  useEffect(() => {
    if (transcript && scrollAreaRef.current) {
      const viewport = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }, [transcript]);

  if (isLoading) {
    return <Loading message="Loading transcript…" />;
  }

  if (error && error.data?.code !== 'NOT_FOUND' && !transcript) {
    return (
      <QueryErrorState
        title="Couldn't load transcript"
        error={error}
        onRetry={() => {
          void refetch();
        }}
        isRetrying={isFetching}
        className="h-full"
      />
    );
  }

  if (!transcript || error?.data?.code === 'NOT_FOUND') {
    return (
      <EmptyState
        icon={ChatsCircleIcon}
        title="Transcript not found"
        description="This session's history is no longer available."
        className="h-full"
      />
    );
  }

  const notice = error ? (
    <div role="status" aria-live="polite" className="shrink-0 border-b p-3 text-sm">
      Latest transcript read failed. Showing previously loaded history.
    </div>
  ) : null;

  if (transcript.messages.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {notice}
        <EmptyState
          icon={ChatsCircleIcon}
          title="No messages in this session"
          className="min-h-0 flex-1"
        />
      </div>
    );
  }

  const items = projectClosedSessionTranscriptRows(transcript.messages);

  const history = (
    <ScrollArea ref={scrollAreaRef} className="min-h-0 flex-1">
      <div className="p-4 space-y-4">
        {items.map(({ item, key }) =>
          item.kind === 'rich' ? (
            <GroupedMessageItemRenderer key={key} item={item.value} />
          ) : (
            <section key={key} aria-label="Archived message JSON">
              <div className="text-xs text-muted-foreground">Archived message JSON</div>
              <pre className="whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(item.value, null, 2)}
              </pre>
            </section>
          )
        )}
      </div>
    </ScrollArea>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {notice}
      {history}
    </div>
  );
}
