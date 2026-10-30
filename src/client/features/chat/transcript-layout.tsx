import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { useMemo } from 'react';
import type { GroupedMessageItem } from '@/lib/chat-protocol';
import { isStreamEventMessage, isToolSequence } from '@/lib/chat-protocol';
import { PR_EVENT_MESSAGE_ID_PREFIX } from '@/shared/pr-monitoring';
import { GroupedMessageItemRenderer } from './agent-activity';
import { CompactingIndicator } from './compacting-indicator';
import { SessionActivityIndicator } from './session-activity-indicator';
import { TodoPanel } from './todo-panel';
import type { TranscriptDisplayProps } from './transcript-display.types';
import { useTodoTracker } from './use-todo-tracker';

function lastThinkingId(messages: GroupedMessageItem[]) {
  let lastThinkingMessageId: string | null = null;
  for (const item of messages) {
    if (isToolSequence(item) || !item.message || !isStreamEventMessage(item.message)) {
      continue;
    }
    const event = item.message.event;
    if (event?.type === 'content_block_start' && event.content_block.type === 'thinking') {
      lastThinkingMessageId = item.id;
    }
  }
  return lastThinkingMessageId;
}

export function useTranscriptLayout(props: TranscriptDisplayProps, hasHeader: boolean) {
  return useMemo(() => {
    const messages: GroupedMessageItem[] = [];
    let queuedPRUpdate: GroupedMessageItem | undefined;
    for (const item of props.messages) {
      if (props.loadingSession && !props.queuedMessageIds?.has(item.id)) {
        continue;
      }
      const queuedPR =
        !isToolSequence(item) &&
        props.queuedMessageIds?.has(item.id) &&
        (item.message?.type === 'pr_update' || item.id.startsWith(PR_EVENT_MESSAGE_ID_PREFIX));
      if (queuedPR) {
        queuedPRUpdate ??= item;
      } else {
        messages.push(item);
      }
    }
    const lastThinkingMessageId = lastThinkingId(messages);
    const keys = messages.length ? messages.map((item) => item.id) : ['transcript:status'];
    if (hasHeader) {
      keys.unshift('transcript:header');
    }
    return {
      messages,
      queuedPRUpdate,
      lastThinkingMessageId,
      keys,
      headerOffset: hasHeader ? 1 : 0,
    };
  }, [props.messages, props.loadingSession, props.queuedMessageIds, hasHeader]);
}

function getStartupLabel(props: TranscriptDisplayProps) {
  if (props.initBanner?.kind === 'info') {
    return props.initBanner.message;
  }
  return props.loadingSession ? 'Loading session...' : (props.startingLabel ?? 'Starting agent...');
}

export function TranscriptTail({
  props,
  queuedPRUpdate,
}: {
  props: TranscriptDisplayProps;
  queuedPRUpdate?: GroupedMessageItem;
}) {
  const { work, running, loadingSession, initBanner } = props;
  const todoState = useTodoTracker(props.messages, props.acpPlan);
  const background = Boolean(
    work && (work.backgroundTasks.length || work.runningSubagents || work.activeGoals)
  );
  const initializing = initBanner?.kind === 'info';
  const starting = props.startingSession && !running && !loadingSession && !initializing;
  const idleEmpty =
    todoState.todos.length === 0 &&
    props.messages.length === 0 &&
    !running &&
    !background &&
    !initializing &&
    !starting &&
    !props.subagentTimelineError &&
    !loadingSession;
  return (
    <>
      {idleEmpty && (
        <div className="py-12 text-center text-muted-foreground">
          <p className="text-lg font-medium">Ready to start</p>
          <p className="text-sm">Send a message to start the agent and begin your conversation.</p>
        </div>
      )}
      {props.subagentTimelineError && (
        <div role="status" className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
          <span className="min-w-0">{props.subagentTimelineError.message}</span>
          <button
            type="button"
            onClick={props.subagentTimelineError.onRetry}
            className="shrink-0 rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      )}
      {!loadingSession && <TodoPanel todoState={todoState} />}
      <CompactingIndicator isCompacting={props.isCompacting ?? false} className="mb-4" />
      {(initializing || loadingSession || starting) && (
        <div className="flex items-center gap-2 text-muted-foreground py-4">
          <SpinnerGapIcon className="h-4 w-4 animate-spin" />
          <span className="text-sm">{getStartupLabel(props)}</span>
        </div>
      )}
      {(running || background) && (
        <SessionActivityIndicator
          work={work}
          latestThinking={props.latestThinking}
          onOpenAgents={props.onOpenAgents}
        />
      )}
      {queuedPRUpdate && (
        <GroupedMessageItemRenderer
          item={queuedPRUpdate}
          isQueued
          onOpenAgents={props.onOpenAgents}
        />
      )}
    </>
  );
}

export type TranscriptLayout = ReturnType<typeof useTranscriptLayout>;
