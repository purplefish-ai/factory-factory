import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { StatusCallout } from '@/client/components/status-callout';
import { StatusChip } from '@/client/components/status-indicators';
import { invalidateRunRecoveryQueries } from '@/client/lib/agent-query-cache';
import { runInBackground } from '@/client/lib/background-task';
import { formatDateTime } from '@/client/lib/date-time';
import { getProjectSectionPath } from '@/client/lib/project-navigation';
import { trpcErrorCode } from '@/client/lib/query-client';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  abandonOutcome,
  ACTION_LABELS,
  FIRST_MESSAGE,
  ACTION_SUMMARIES,
  type ChildHold,
  childHoldTitle,
  CHILD_STATE_LABELS,
  describeRecoveryBlock,
  OUTCOME_MESSAGES,
  type RecoveryAction,
  recoveryAvailability,
  type RecoveryInspection,
  type RecoveryOutcome,
  UNAVAILABLE_TARGET,
  UNPROVEN_ABANDON_OUTCOME,
} from './event-run-recovery-copy';
import type { EventRun } from './types';

/**
 * Runs a person may need to decide on: one needing attention (including one
 * already marked resolved, which keeps its slot), or one still open after its
 * first turn ended, which its own unproven work or child workspaces can hold.
 */
export function canRecoverRun(run: EventRun) {
  return (
    run.status === 'RUNNING' &&
    (run.launchPhase === 'NEEDS_ATTENTION' || run.initialOutcome !== null)
  );
}

type Problem =
  | { kind: 'changed' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'failed'; message: string };
type View =
  | { kind: 'closed' }
  | { kind: 'inspect' }
  | {
      kind: 'confirm';
      action: RecoveryAction;
      /** The inspection the person chose from; its context is sent unchanged. */
      inspection: RecoveryInspection;
      problem: Problem | null;
    };
type Scope = { projectId: string; agentId: string; runId: string };

/** A conflict or block means the inspection is out of date: only Reload is offered. */
function isStale(problem: Problem | null) {
  return problem?.kind === 'changed' || problem?.kind === 'blocked';
}

const recoveryQueryKey = (scope: Scope) => ['automation', 'runRecovery', scope] as const;

/**
 * The inspected context, unchanged, with the chosen action. Only Abandon anyway
 * carries the opt-in to an unproven stop.
 */
function recoveryRequest(agentId: string, action: RecoveryAction, inspection: RecoveryInspection) {
  return action === 'ABANDON_UNPROVEN'
    ? {
        agentId,
        ...inspection.context,
        action: 'ABANDON' as const,
        acceptUnprovenStop: true as const,
      }
    : { agentId, ...inspection.context, action };
}

function agentState(inspection: RecoveryInspection) {
  if (inspection.proofAvailable) {
    return 'Stopped.';
  }
  return inspection.blocked
    ? 'Not confirmed stopped.'
    : 'Not confirmed stopped. Each action stops it first.';
}

function actionProblem(error: unknown): Problem {
  if (trpcErrorCode(error) === 'CONFLICT') {
    return { kind: 'changed' };
  }
  return {
    kind: 'failed',
    message: error instanceof Error ? error.message : "Couldn't reach the app.",
  };
}

/**
 * The target, then its inspection, read together and only on request. Neither
 * refreshes on its own: a stale context must surface as a conflict, not be
 * replaced behind the person's back.
 */
function useRecoveryRead(scope: Scope, enabled: boolean) {
  const utils = trpc.useUtils();
  return useQuery({
    queryKey: recoveryQueryKey(scope),
    enabled,
    queryFn: async ({ signal }) => {
      const target = await utils.client.automation.recoveryTarget.query(scope, { signal });
      if (target.status === 'UNAVAILABLE') {
        return { status: 'UNAVAILABLE' as const, reason: target.reason };
      }
      const inspection = await utils.client.automation.inspectRun.query(
        { agentId: scope.agentId, ...target.context },
        { signal }
      );
      return { status: 'INSPECTED' as const, inspection };
    },
  });
}

export interface EventRunRecoveryProps {
  run: EventRun;
  projectId: string;
  agentId: string;
  projectSlug: string;
  archived: boolean;
}

/** Inspect a run that needs a decision, then Resolve, Abandon or Retry it. */
export function EventRunRecovery({
  run,
  projectId,
  agentId,
  projectSlug,
  archived,
}: EventRunRecoveryProps) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const scope = { projectId, agentId, runId: run.id };
  const queryKey = recoveryQueryKey(scope);
  const [view, setView] = useState<View>({ kind: 'closed' });
  const [outcome, setOutcome] = useState<RecoveryOutcome | null>(null);
  const read = useRecoveryRead(scope, view.kind !== 'closed');
  const resolve = trpc.automation.resolveAmbiguousRun.useMutation({
    meta: { errorToast: false },
  });
  const submitting = useRef(false);

  const close = () => setView({ kind: 'closed' });
  /** Every opening reads the run afresh; the last read stays on screen while the dialog closes. */
  const open = () => {
    queryClient.removeQueries({ queryKey });
    setOutcome(null);
    setView({ kind: 'inspect' });
  };
  const reload = () => {
    setView({ kind: 'inspect' });
    runInBackground(queryClient.resetQueries({ queryKey }), "Couldn't check this run.");
  };
  const submit = async () => {
    if (view.kind !== 'confirm' || isStale(view.problem) || submitting.current || archived) {
      return;
    }
    submitting.current = true;
    const { action, inspection } = view;
    try {
      const result = await resolve.mutateAsync(recoveryRequest(agentId, action, inspection));
      if (result.status === 'BLOCKED') {
        setView({ ...view, problem: { kind: 'blocked', reason: result.reason } });
        return;
      }
      runInBackground(
        invalidateRunRecoveryQueries(utils, projectId, agentId),
        "Couldn't refresh runs."
      );
      // Abandon anyway may still prove the stop; only the server's answer says it didn't.
      setOutcome(
        result.status === 'ABANDONED' && result.unproven ? 'ABANDONED_UNPROVEN' : result.status
      );
      close();
    } catch (error) {
      setView({ ...view, problem: actionProblem(error) });
    } finally {
      submitting.current = false;
    }
  };

  const message = outcome ? OUTCOME_MESSAGES[outcome] : null;
  // Stays mounted while a dialog is open or a result is shown, even once the run has moved on.
  if (!(canRecoverRun(run) || message || view.kind !== 'closed')) {
    return null;
  }
  return (
    <div className="space-y-2">
      {message && (
        <StatusCallout tone="success" role="status" size="sm" title={message.title}>
          {message.body}
        </StatusCallout>
      )}
      {canRecoverRun(run) && (
        <Button variant="outline" size="sm" disabled={archived} onClick={open}>
          Inspect
        </Button>
      )}
      <Dialog
        open={view.kind === 'inspect'}
        onOpenChange={(open) => {
          if (!open) {
            close();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Recover run</DialogTitle>
            <DialogDescription>
              Check what this run is waiting on, then choose what to do. Nothing changes until you
              confirm an action.
            </DialogDescription>
          </DialogHeader>
          <RecoveryReadState
            read={read}
            projectSlug={projectSlug}
            archived={archived}
            onReload={reload}
            onChoose={(action, inspection) =>
              setView({ kind: 'confirm', action, inspection, problem: null })
            }
          />
        </DialogContent>
      </Dialog>
      {view.kind === 'confirm' && (
        <RecoveryConfirm
          view={view}
          run={run}
          pending={resolve.isPending}
          onConfirm={() => void submit()}
          onReload={reload}
          onCancel={() => (isStale(view.problem) ? close() : setView({ kind: 'inspect' }))}
        />
      )}
    </div>
  );
}

function RecoveryReadState({
  read,
  projectSlug,
  archived,
  onReload,
  onChoose,
}: {
  read: ReturnType<typeof useRecoveryRead>;
  projectSlug: string;
  archived: boolean;
  onReload: () => void;
  onChoose: (action: RecoveryAction, inspection: RecoveryInspection) => void;
}) {
  if (read.error) {
    if (trpcErrorCode(read.error) === 'CONFLICT') {
      return (
        <StatusCallout
          tone="warning"
          role="alert"
          title="This run changed"
          action={
            <Button variant="outline" size="sm" onClick={onReload}>
              Reload
            </Button>
          }
        >
          It changed while it was being checked. Reload to see its current state.
        </StatusCallout>
      );
    }
    return (
      <QueryErrorState
        title="Couldn't check this run"
        error={read.error}
        onRetry={onReload}
        isRetrying={read.isFetching}
        className="p-0"
      />
    );
  }
  if (!read.data) {
    return <Loading size="compact" message="Checking this run…" />;
  }
  if (read.data.status === 'UNAVAILABLE') {
    return <StatusCallout tone="info">{UNAVAILABLE_TARGET[read.data.reason]}</StatusCallout>;
  }
  const { inspection } = read.data;
  const availability = recoveryAvailability(inspection);
  const blocked = inspection.blocked;
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">First message</dt>
        <dd>{FIRST_MESSAGE[inspection.run.deliveryState]}</dd>
        <dt className="text-muted-foreground">Agent</dt>
        <dd>{agentState(inspection)}</dd>
      </dl>
      {inspection.childHold && (
        <ChildHoldNotice hold={inspection.childHold} projectSlug={projectSlug} />
      )}
      {blocked && (
        <StatusCallout
          tone="warning"
          title={
            inspection.unprovenAbandonAvailable
              ? "Resolve, Retry and Abandon aren't available"
              : 'No recovery action is available'
          }
        >
          {describeRecoveryBlock(blocked)}
        </StatusCallout>
      )}
      {blocked && inspection.unprovenAbandonAvailable && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            variant="outline"
            size="sm"
            disabled={archived}
            onClick={() => onChoose('ABANDON_UNPROVEN', inspection)}
          >
            {ACTION_LABELS.ABANDON_UNPROVEN}
          </Button>
          <span className="text-muted-foreground">{ACTION_SUMMARIES.ABANDON_UNPROVEN}</span>
        </div>
      )}
      {archived && (
        <StatusCallout tone="info">
          This project is archived, so its runs can't change.
        </StatusCallout>
      )}
      {!blocked && (
        <ul className="space-y-2">
          {availability.map(({ action, reason }) => (
            <li key={action} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {reason === null ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={archived}
                    onClick={() => onChoose(action, inspection)}
                  >
                    {ACTION_LABELS[action]}
                  </Button>
                  <span className="text-muted-foreground">{ACTION_SUMMARIES[action]}</span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {ACTION_LABELS[action]} isn't available: {reason}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChildHoldNotice({ hold, projectSlug }: { hold: ChildHold; projectSlug: string }) {
  const unlisted = hold.heldCount - hold.children.length;
  return (
    <StatusCallout tone="waiting" title={childHoldTitle(hold.heldCount)}>
      <ul className="my-1 space-y-1">
        {hold.children.map((child) => (
          <li key={child.workspaceId} className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusChip tone={child.state === 'WORKING' ? 'working' : 'neutral'} size="sm">
              {CHILD_STATE_LABELS[child.state]}
            </StatusChip>
            <Link
              to={`${getProjectSectionPath(projectSlug, 'workspaces')}/${encodeURIComponent(child.workspaceId)}`}
              className="min-w-0 truncate font-mono text-xs underline underline-offset-4"
            >
              {child.workspaceId}
            </Link>
          </li>
        ))}
        {unlisted > 0 && <li>And {unlisted} more.</li>}
      </ul>
      Only Abandon is available until they finish.
      {hold.deadlineAt &&
        ` If they haven't finished by ${formatDateTime(hold.deadlineAt)}, the run ends on its own with its own outcome.`}
    </StatusCallout>
  );
}

function RecoveryConfirm({
  view,
  run,
  pending,
  onConfirm,
  onReload,
  onCancel,
}: {
  view: Extract<View, { kind: 'confirm' }>;
  run: EventRun;
  pending: boolean;
  onConfirm: () => void;
  onReload: () => void;
  onCancel: () => void;
}) {
  const { action, inspection, problem } = view;
  const stale = isStale(problem);
  const copy = CONFIRM_COPY[action];
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      title={copy.title}
      description={copy.description}
      confirmText={stale ? 'Reload' : copy.confirmText}
      pendingText={copy.pendingText}
      variant={action.startsWith('ABANDON') && !stale ? 'destructive' : 'default'}
      isPending={pending}
      onConfirm={stale ? onReload : onConfirm}
    >
      <div className="space-y-2 text-sm text-muted-foreground">
        <ActionConsequences action={action} inspection={inspection} run={run} />
        {problem?.kind === 'changed' && (
          <StatusCallout tone="warning" role="alert" title="This run changed">
            It changed after you inspected it, so {ACTION_LABELS[action]} wasn't applied and the
            run's status didn't change. Reload to see its current state and choose again.
          </StatusCallout>
        )}
        {problem?.kind === 'blocked' && (
          <StatusCallout
            tone="warning"
            role="alert"
            title={`${ACTION_LABELS[action]} wasn't applied`}
          >
            {describeRecoveryBlock(problem.reason)} The run's status didn't change. Reload to see
            what is available now.
          </StatusCallout>
        )}
        {problem?.kind === 'failed' && (
          <StatusCallout tone="danger" role="alert">
            {problem.message}
          </StatusCallout>
        )}
      </div>
    </ConfirmDialog>
  );
}

const CONFIRM_COPY: Record<
  RecoveryAction,
  { title: string; description: string; confirmText: string; pendingText: string }
> = {
  RESOLVE: {
    title: 'Resolve this run?',
    description:
      "Resolve stops this run's agent if it is still running and records that its work has stopped. Nothing is sent to the agent.",
    confirmText: 'Resolve run',
    pendingText: 'Resolving…',
  },
  RETRY: {
    title: 'Retry this run?',
    description:
      "Retry stops this run's agent if it is still running, then sends the first message again in the same workspace and session.",
    confirmText: 'Retry run',
    pendingText: 'Retrying…',
  },
  ABANDON: {
    title: 'Abandon this run?',
    description:
      "Abandon stops this run's agent if it is still running, ends the run and frees its run slot.",
    confirmText: 'Abandon run',
    pendingText: 'Abandoning…',
  },
  ABANDON_UNPROVEN: {
    title: 'Abandon this run anyway?',
    description:
      "Factory Factory can't confirm this run's agent has stopped. Abandoning ends the run anyway and frees its run slot, so this automation can start its next run.",
    confirmText: 'Abandon anyway',
    pendingText: 'Abandoning…',
  },
};

function ActionConsequences({
  action,
  inspection,
  run,
}: {
  action: RecoveryAction;
  inspection: RecoveryInspection;
  run: EventRun;
}) {
  if (action === 'RESOLVE') {
    return (
      <p>
        The run stays open as Needs attention and keeps its run slot, so this automation can't start
        another run until you retry or abandon it.
      </p>
    );
  }
  if (action === 'RETRY') {
    return (
      <>
        <StatusCallout tone="warning" title="Earlier effects may already have happened">
          {inspection.delivery === 'UNSENT'
            ? "The first message wasn't sent, but setup may already have changed the workspace."
            : 'The first message may already have reached the agent, which may have changed files, pushed commits or posted comments.'}{' '}
          Check the workspace before retrying.
        </StatusCallout>
        <p>The run keeps its run slot and its attempt count.</p>
      </>
    );
  }
  return (
    <>
      {action === 'ABANDON_UNPROVEN' && (
        <StatusCallout tone="warning" title="Its agent may still be running">
          If it is, it keeps working in its workspace until you stop it there. Check the workspace
          after abandoning. Factory Factory stops it first if it can still reach it, and never sends
          the first message again.
        </StatusCallout>
      )}
      <p>
        {action === 'ABANDON_UNPROVEN' ? UNPROVEN_ABANDON_OUTCOME : abandonOutcome(inspection, run)}
      </p>
      <p>
        Abandon doesn't stop this run's child workspaces; any that are still working keep going as
        ordinary workspaces.
      </p>
    </>
  );
}
