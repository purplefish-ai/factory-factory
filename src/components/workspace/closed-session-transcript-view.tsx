import { useEffect, useRef } from 'react';
import { trpc } from '@/client/lib/trpc';
import { GroupedMessageItemRenderer } from '@/components/agent-activity';
import { ScrollArea } from '@/components/ui/scroll-area';
import { groupAdjacentToolCalls } from '@/lib/chat-protocol';

interface ClosedSessionTranscriptViewProps {
  sessionId: string;
}

export function ClosedSessionTranscriptView({ sessionId }: ClosedSessionTranscriptViewProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const { data: transcript, isLoading } = trpc.closedSessions.getTranscript.useQuery({
    id: sessionId,
  });

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

  if (!transcript) {
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

  // Group messages using the same logic as the live chat
  const groupedMessages = groupAdjacentToolCalls(transcript.messages);

  return (
    <ScrollArea ref={scrollAreaRef} className="h-full">
      <div className="p-4 space-y-4">
        {groupedMessages.map((item, index) => (
          <GroupedMessageItemRenderer
            key={`${item.id}-${index}`}
            item={item}
            // Read-only mode - no interactivity callbacks
          />
        ))}
      </div>
    </ScrollArea>
  );
}
