import {
  ArrowLeftIcon,
  CaretRightIcon,
  RobotIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import type { RefObject } from 'react';
import { GroupedMessageItemRenderer } from '@/client/features/chat';
import { Button } from '@/components/ui/button';
import type { ChatMessage } from '@/lib/chat-protocol';
import { groupAdjacentToolCalls } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
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
  onBack: () => void;
  state: SubagentTranscriptState;
  viewportRef?: RefObject<HTMLDivElement | null>;
}

function statusLabel(status: SubagentSelection['subagent']['status']): string {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function statusClassName(status: SubagentSelection['subagent']['status']): string {
  switch (status) {
    case 'starting':
      return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300';
    case 'running':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
    case 'waiting':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'completed':
      return 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300';
    case 'failed':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'cancelled':
    case 'interrupted':
      return 'border-border bg-muted text-muted-foreground';
  }
}

function subagentName(selection: SubagentSelection): string {
  return selection.subagent.name?.trim() || `Sub-agent ${selection.subagent.id.slice(0, 8)}`;
}

function TranscriptHeader({
  selection,
  onBack,
}: {
  selection: SubagentSelection;
  onBack: () => void;
}) {
  const childName = subagentName(selection);
  return (
    <header className="shrink-0 border-b bg-background px-3 py-2 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2"
          onClick={onBack}
          aria-label={`Back to ${selection.parentSessionName}`}
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          Back
        </Button>
        <nav
          aria-label="Sub-agent transcript breadcrumb"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-sm"
        >
          <span className="shrink-0 text-muted-foreground">{selection.parentSessionName}</span>
          <CaretRightIcon
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate font-medium">{childName}</span>
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Read only
          </span>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] font-medium',
              statusClassName(selection.subagent.status)
            )}
          >
            {statusLabel(selection.subagent.status)}
          </span>
        </div>
      </div>
    </header>
  );
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
  const groupedMessages = groupAdjacentToolCalls(state.messages);
  return (
    <div
      ref={viewportRef}
      role="log"
      aria-label="Sub-agent transcript"
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-4xl space-y-4 p-3 sm:p-4">
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
        {groupedMessages.map((item) => (
          <GroupedMessageItemRenderer
            key={item.id}
            item={item}
            getToolExpansionState={undefined}
            setToolExpansionState={undefined}
            toolExpansionToken={workspaceId}
          />
        ))}
      </div>
    </div>
  );
}

export function SubagentTranscriptContent({
  workspaceId,
  selection,
  onBack,
  state,
  viewportRef,
}: SubagentTranscriptContentProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <TranscriptHeader selection={selection} onBack={onBack} />
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
