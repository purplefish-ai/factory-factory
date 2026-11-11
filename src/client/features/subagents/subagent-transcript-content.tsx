import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { SectionLabel } from '@/client/components/section-label';
import { StatusCallout } from '@/client/components/status-callout';
import { ChatTranscript, type TranscriptScrollOptions } from '@/client/features/chat';
import { Button } from '@/components/ui/button';
import type { ChatMessage } from '@/lib/chat-protocol';
import { groupAdjacentToolCalls } from '@/lib/chat-protocol';
import type { SubagentSelection } from './types';

export type SubagentTranscriptState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'unavailable'; message: string; onRetry: () => void }
  | {
      kind: 'ready';
      messages: ChatMessage[];
      hasOlder: boolean;
      loadingOlder: boolean;
      onLoadOlder: () => void;
      error?: { message: string; onRetry: () => void };
    };

export interface SubagentTranscriptContentProps {
  workspaceId: string;
  selection: SubagentSelection;
  state: SubagentTranscriptState;
  scroll?: Pick<TranscriptScrollOptions, 'ready' | 'initialPosition' | 'onPositionChange'>;
}

function UnavailableState({
  selection,
  message,
  onRetry,
}: {
  selection: SubagentSelection;
  message: string;
  onRetry: () => void;
}) {
  const preview = selection.subagent.resultPreview ?? selection.subagent.latestActivity;
  return (
    <div className="flex h-full items-center justify-center p-4 sm:p-8">
      <StatusCallout
        tone="danger"
        title={<h2>Transcript unavailable</h2>}
        action={
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
        className="w-full max-w-xl"
      >
        <p>{message}</p>
        {preview && (
          <div className="mt-3 rounded-md border bg-background/80 p-3">
            <SectionLabel asChild>
              <p>Last result</p>
            </SectionLabel>
            <p className="mt-1 whitespace-pre-wrap break-words">{preview}</p>
          </div>
        )}
      </StatusCallout>
    </div>
  );
}

function ReadyState({
  workspaceId,
  state,
  selection,
  scroll,
}: {
  workspaceId: string;
  selection: SubagentSelection;
  state: Extract<SubagentTranscriptState, { kind: 'ready' }>;
  scroll: SubagentTranscriptContentProps['scroll'];
}) {
  const groupedMessages = groupAdjacentToolCalls(state.messages);
  return (
    <ChatTranscript
      workspaceId={workspaceId}
      label="Subagent transcript"
      messages={groupedMessages}
      running={false}
      startingSession={false}
      loadingSession={false}
      contentClassName="mx-auto max-w-4xl"
      scroll={{
        identity: `${workspaceId}/subagent/${selection.parentSessionId}/${selection.subagent.id}`,
        active: true,
        ready: true,
        initialIntent: 'reading',
        initialPosition: null,
        ...scroll,
      }}
      header={
        state.error || state.hasOlder ? (
          <div className="space-y-4 pt-3 sm:pt-4">
            {state.error && (
              <StatusCallout
                role="alert"
                tone="danger"
                title="Transcript update failed"
                action={
                  <Button type="button" variant="outline" size="sm" onClick={state.error.onRetry}>
                    Retry
                  </Button>
                }
              >
                {state.error.message}
              </StatusCallout>
            )}
            {state.hasOlder && !state.error && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  pending={state.loadingOlder}
                  pendingLabel="Loading older…"
                  onClick={state.onLoadOlder}
                >
                  Load older
                </Button>
              </div>
            )}
          </div>
        ) : undefined
      }
    />
  );
}

export function SubagentTranscriptContent({
  workspaceId,
  selection,
  state,
  scroll,
}: SubagentTranscriptContentProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {selection.subagent.model && (
        <div className="border-b px-4 py-2 text-xs text-muted-foreground">
          Model: <span className="break-all">{selection.subagent.model}</span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {state.kind === 'loading' && <Loading size="compact" message="Loading transcript…" />}
        {state.kind === 'empty' && (
          <EmptyState
            icon={RobotIcon}
            title="No transcript messages yet"
            description="Messages appear here as the subagent works."
            className="h-full"
          />
        )}
        {state.kind === 'unavailable' && (
          <UnavailableState selection={selection} message={state.message} onRetry={state.onRetry} />
        )}
        {state.kind === 'ready' && (
          <ReadyState
            workspaceId={workspaceId}
            state={state}
            selection={selection}
            scroll={scroll}
          />
        )}
      </div>
    </div>
  );
}
