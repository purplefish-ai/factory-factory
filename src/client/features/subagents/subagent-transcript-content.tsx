import { RobotIcon, SpinnerGapIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { VirtualizedMessageList } from '@/client/features/chat';
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
  viewportRef?: RefObject<HTMLDivElement | null>;
}

function LoadingState() {
  return (
    <div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
      <SpinnerGapIcon className="h-4 w-4 animate-spin" />
      Loading transcript…
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <RobotIcon className="h-7 w-7 opacity-40" />
      <p className="text-sm">No transcript messages yet.</p>
    </div>
  );
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
      <div className="w-full max-w-xl rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <div className="flex items-start gap-3">
          <WarningCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h2 className="text-sm font-medium">Transcript unavailable</h2>
              <p className="mt-1 break-words text-xs text-muted-foreground">{message}</p>
            </div>
            {preview && (
              <div className="rounded-md border bg-background/80 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Last result
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">{preview}</p>
              </div>
            )}
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadyState({
  workspaceId,
  state,
  viewportRef,
}: {
  workspaceId: string;
  state: Extract<SubagentTranscriptState, { kind: 'ready' }>;
  viewportRef?: RefObject<HTMLDivElement | null>;
}) {
  const localViewportRef = useRef<HTMLDivElement>(null);
  const resolvedViewportRef = viewportRef ?? localViewportRef;
  const [isNearBottom, setIsNearBottom] = useState(false);
  const updateBottomProximity = useCallback(() => {
    const viewport = resolvedViewportRef.current;
    if (!viewport) {
      return;
    }
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setIsNearBottom(distanceFromBottom <= 48);
  }, [resolvedViewportRef]);
  useLayoutEffect(updateBottomProximity, [updateBottomProximity]);
  const groupedMessages = groupAdjacentToolCalls(state.messages);
  return (
    <div
      ref={resolvedViewportRef}
      role="log"
      aria-label="Sub-agent transcript"
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-4xl space-y-4 px-3 pt-3 sm:px-4 sm:pt-4">
        {state.error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
          >
            <div className="flex items-start gap-2">
              <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Transcript update failed</p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {state.error.message}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={state.error.onRetry}
                >
                  Retry
                </Button>
              </div>
            </div>
          </div>
        )}
        {state.hasOlder && !state.error && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={state.loadingOlder}
              onClick={state.onLoadOlder}
            >
              {state.loadingOlder ? 'Loading older…' : 'Load older'}
            </Button>
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-4xl">
        <VirtualizedMessageList
          workspaceId={workspaceId}
          messages={groupedMessages}
          running={false}
          startingSession={false}
          loadingSession={false}
          scrollContainerRef={resolvedViewportRef}
          onScroll={updateBottomProximity}
          isNearBottom={isNearBottom}
          preserveScrollAnchorOnPrepend
        />
      </div>
    </div>
  );
}

export function SubagentTranscriptContent({
  workspaceId,
  selection,
  state,
  viewportRef,
}: SubagentTranscriptContentProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1">
        {state.kind === 'loading' && <LoadingState />}
        {state.kind === 'empty' && <EmptyState />}
        {state.kind === 'unavailable' && (
          <UnavailableState selection={selection} message={state.message} onRetry={state.onRetry} />
        )}
        {state.kind === 'ready' && (
          <ReadyState workspaceId={workspaceId} state={state} viewportRef={viewportRef} />
        )}
      </div>
    </div>
  );
}
