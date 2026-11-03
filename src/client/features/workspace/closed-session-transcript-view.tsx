import { useEffect, useRef } from 'react';
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
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-muted-foreground">Loading transcript...</div>
      </div>
    );
  }

  if (error && error.data?.code !== 'NOT_FOUND') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-muted-foreground">Failed to load transcript</div>
      </div>
    );
  }

  if (!transcript || error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-muted-foreground">Transcript not found</div>
      </div>
    );
  }

  if (transcript.messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-muted-foreground">No messages in this session</div>
      </div>
    );
  }

  const items = projectClosedSessionTranscriptRows(transcript.messages);

  return (
    <ScrollArea ref={scrollAreaRef} className="h-full">
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
}
