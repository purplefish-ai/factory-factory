import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useEventRunPages } from '@/client/lib/agent-query-cache';
import { formatDateTime } from '@/client/lib/date-time';
import { getProjectSectionPath } from '@/client/lib/project-navigation';
import { Badge } from '@/components/ui/badge';
import {
  EventHistoryDetails,
  EventHistoryFrame,
  EventReason,
  EventTime,
} from './event-history-frame';
import type { EventRun } from './types';

type BadgeVariant = 'outline' | 'info' | 'warning' | 'success' | 'secondary' | 'destructive';

/** The run's state in words. RUNNING covers setup, the agent working and runs held for a person. */
function runStatus(run: EventRun): { label: string; variant: BadgeVariant } {
  switch (run.status) {
    case 'QUEUED':
      return { label: 'Queued', variant: 'outline' };
    case 'RUNNING':
      if (run.launchPhase === 'NEEDS_ATTENTION' && run.reasonCode !== 'EXPLICITLY_RESOLVED') {
        return { label: 'Needs attention', variant: 'warning' };
      }
      return run.launchPhase === 'ACTIVE' || run.launchPhase === 'NEEDS_ATTENTION'
        ? { label: 'Running', variant: 'info' }
        : { label: 'Starting', variant: 'info' };
    case 'PR_CREATED':
      return { label: 'PR created', variant: 'success' };
    case 'COMPLETED':
      return { label: 'Completed', variant: 'secondary' };
    case 'FAILED':
      return { label: 'Failed', variant: 'destructive' };
    case 'CANCELLED':
      return { label: 'Cancelled', variant: 'secondary' };
  }
}

const isActive = (run: EventRun) => run.status === 'QUEUED' || run.status === 'RUNNING';

/**
 * LIVE is the only state that proves a workspace row exists (archived rows
 * included); a run can be linked before its own workspace field is set.
 */
function liveWorkspaceId(run: EventRun) {
  return run.workspaceState === 'LIVE' ? (run.workspaceId ?? run.reservedWorkspaceId) : null;
}

function missingWorkspaceLabel(run: EventRun) {
  if (isActive(run)) {
    return 'No workspace yet';
  }
  if (run.workspaceState === 'DELETED') {
    return 'Workspace deleted';
  }
  return run.workspaceState === 'UNRESERVED' ? 'No workspace was created' : 'Workspace unavailable';
}

const DELIVERY_LABELS: Record<NonNullable<EventRun['delivery']>['state'], string> = {
  PENDING: 'Not sent',
  SENDING: 'Sending',
  ACCEPTED: 'Accepted by the agent',
  FINISHED: 'Finished',
  AMBIGUOUS: 'Unknown whether it was sent',
};

function runDetails(run: EventRun) {
  const rows: Array<readonly [string, ReactNode]> = [['Run ID', run.id]];
  if (run.reasonCode) {
    rows.push(['Reason code', run.reasonCode]);
  }
  rows.push(['Event', run.eventId ?? 'Event record no longer kept']);
  rows.push(['Attempts', `${run.attemptCount} (generation ${run.attemptGeneration})`]);
  if (run.delivery) {
    rows.push(['First message', DELIVERY_LABELS[run.delivery.state]]);
  }
  if (run.initialOutcome) {
    rows.push([
      'First turn',
      `${run.initialOutcome.result.toLowerCase()} (${run.initialOutcome.stopReason})`,
    ]);
  }
  if (run.setupDeadlineAt && isActive(run)) {
    rows.push(['Setup deadline', formatDateTime(run.setupDeadlineAt, { precision: 'second' })]);
  }
  if (run.turnDeadlineAt && isActive(run)) {
    rows.push(['Turn deadline', formatDateTime(run.turnDeadlineAt, { precision: 'second' })]);
  }
  return rows;
}

export interface EventRunItemProps {
  run: EventRun;
  projectSlug: string;
  /** Off where the run's own workspace is already open. */
  showWorkspaceLink?: boolean;
  actions?: ReactNode;
}

/** One event run: status, why, its workspace and retained PR links. */
export function EventRunItem({
  run,
  projectSlug,
  showWorkspaceLink = true,
  actions,
}: EventRunItemProps) {
  const status = runStatus(run);
  const workspaceId = liveWorkspaceId(run);
  const pullRequests = run.result?.pullRequests ?? [];
  return (
    <article data-run-id={run.id} className="min-w-0 space-y-2 p-4 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={status.variant}>{status.label}</Badge>
        {run.startedAt ? (
          <EventTime value={run.startedAt} prefix="Started" />
        ) : (
          <EventTime value={run.createdAt} prefix="Queued" />
        )}
        {run.completedAt && !isActive(run) && (
          <EventTime value={run.completedAt} prefix="Finished" />
        )}
      </div>
      <EventReason
        code={run.reasonCode}
        fallback={run.status === 'QUEUED' ? 'Waiting for a free run slot.' : undefined}
      />
      {run.status === 'QUEUED' && run.expiresAt && (
        <p>
          <EventTime value={run.expiresAt} prefix="Cancelled if it hasn't started by" />
        </p>
      )}
      {run.nextAttemptAt && isActive(run) && (
        <p>
          <EventTime value={run.nextAttemptAt} prefix="Next attempt" />
        </p>
      )}
      {run.result?.summary && (
        <p className="whitespace-pre-wrap break-words">{run.result.summary}</p>
      )}
      {run.context.state === 'EXPIRED' && (
        <p className="text-muted-foreground">
          <EventTime value={run.context.expiredAt} prefix="Run details expired" />. Status and links
          are kept.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {showWorkspaceLink &&
          (workspaceId ? (
            <Link
              to={`${getProjectSectionPath(projectSlug, 'workspaces')}/${encodeURIComponent(workspaceId)}`}
              className="font-medium text-primary underline underline-offset-4"
            >
              Open workspace <span className="sr-only">for run {run.id}</span>
            </Link>
          ) : (
            <span className="text-muted-foreground">{missingWorkspaceLabel(run)}</span>
          ))}
        {pullRequests.map((pr) => (
          <a
            key={pr.url}
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            PR #{pr.number}
            <ArrowSquareOutIcon className="size-3" />
            <span className="sr-only"> (opens in new tab)</span>
          </a>
        ))}
      </div>
      {actions}
      <EventHistoryDetails rows={runDetails(run)} />
    </article>
  );
}

export interface EventRunHistoryProps {
  projectId: string;
  agentId: string;
  projectSlug: string;
  /** Per-run controls, such as recovery for a run that needs attention. */
  renderRunActions?: (run: EventRun) => ReactNode;
}

/** The Runs view of an event-triggered automation. */
export function EventRunHistory({
  projectId,
  agentId,
  projectSlug,
  renderRunActions,
}: EventRunHistoryProps) {
  const query = useEventRunPages({ projectId, agentId });
  const runs = query.data?.pages.flatMap((page) => page.items);
  return (
    <EventHistoryFrame
      title="Run history"
      noun="runs"
      emptyDescription="Runs appear here when a matching event starts one."
      query={query}
      count={runs?.length}
    >
      {runs?.map((run) => (
        <EventRunItem
          key={run.id}
          run={run}
          projectSlug={projectSlug}
          actions={renderRunActions?.(run)}
        />
      ))}
    </EventHistoryFrame>
  );
}
