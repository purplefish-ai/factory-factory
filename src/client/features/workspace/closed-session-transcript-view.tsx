import { ChatsCircleIcon } from '@phosphor-icons/react/dist/csr/ChatsCircle';
import { EmptyState } from '@/client/components/empty-state';
import { QueryState } from '@/client/components/query-state';
import { GroupedMessageItemRenderer } from '@/client/features/chat';
import { useFollowOutput } from '@/client/hooks/use-follow-output';
import { trpc } from '@/client/lib/trpc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { parseClosedSessionReadTranscript } from '@/shared/acp-protocol/protocol/closed-session-transcript-schema';
import { projectClosedSessionTranscriptRows } from './closed-session-transcript-items';

interface ClosedSessionTranscriptViewProps {
  sessionId: string;
}

export function ClosedSessionTranscriptView({ sessionId }: ClosedSessionTranscriptViewProps) {
  const followOutputRef = useFollowOutput();
  const transcriptQuery = trpc.closedSessions.getTranscriptJson.useQuery(
    { id: sessionId },
    { select: parseClosedSessionReadTranscript, structuralSharing: false }
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QueryState
        query={transcriptQuery}
        errorTitle="Couldn't load transcript"
        loadingMessage="Loading transcript…"
        className="h-full"
        notFound={
          <EmptyState
            icon={ChatsCircleIcon}
            title="Transcript not found"
            description="This session's history is no longer available."
            className="h-full"
          />
        }
        isEmpty={(data) => data.messages.length === 0}
        empty={
          <EmptyState
            icon={ChatsCircleIcon}
            title="No messages in this session"
            className="min-h-0 flex-1"
          />
        }
      >
        {(data) => (
          <ScrollArea key={sessionId} viewportRef={followOutputRef} className="min-h-0 flex-1">
            <div className="p-4 space-y-4">
              {projectClosedSessionTranscriptRows(data.messages).map(({ item, key }) =>
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
        )}
      </QueryState>
    </div>
  );
}
