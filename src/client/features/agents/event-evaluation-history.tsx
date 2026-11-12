import type { ReactNode } from 'react';
import { useEventEvaluationPages } from '@/client/lib/agent-query-cache';
import { formatDateTime } from '@/client/lib/date-time';
import { Badge } from '@/components/ui/badge';
import {
  EventHistoryDetails,
  EventHistoryFrame,
  EventReason,
  EventTime,
} from './event-history-frame';
import type { EventEvaluation } from './types';

const STATUS: Record<
  EventEvaluation['status'],
  { label: string; variant: 'success' | 'secondary' | 'destructive' }
> = {
  MATCHED: { label: 'Matched', variant: 'success' },
  SKIPPED: { label: 'Skipped', variant: 'secondary' },
  ERROR: { label: 'Error', variant: 'destructive' },
};

function evaluationDetails(evaluation: EventEvaluation) {
  const rows: Array<readonly [string, ReactNode]> = [
    ['Event ID', evaluation.eventId],
    ['Trigger ID', evaluation.triggerId],
  ];
  if (evaluation.runId) {
    rows.push(['Run ID', evaluation.runId]);
  }
  if (evaluation.reasonCode) {
    rows.push(['Reason code', evaluation.reasonCode]);
  }
  rows.push(
    [
      'Revisions',
      `automation ${evaluation.definitionRevision}, trigger ${evaluation.triggerRevision}, activation ${evaluation.activationGeneration}`,
    ],
    ['Attempts', String(evaluation.attemptCount)],
    ['Kept until', formatDateTime(evaluation.expiresAt)]
  );
  return rows;
}

function EventEvaluationItem({
  evaluation,
  triggerLabel,
}: {
  evaluation: EventEvaluation;
  triggerLabel?: string;
}) {
  const status = STATUS[evaluation.status];
  // The history API returns a fixed placeholder `explanation`, not the stored
  // one, so the reason code is the only source of why.
  return (
    <article data-evaluation-id={evaluation.id} className="min-w-0 space-y-2 p-4 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={status.variant}>{status.label}</Badge>
        <EventTime value={evaluation.createdAt} prefix="Decided" />
        <span className="min-w-0 break-words">
          Trigger: {triggerLabel ?? <span className="break-all">{evaluation.triggerId}</span>}
        </span>
      </div>
      <EventReason code={evaluation.reasonCode} fallback="No reason was recorded." />
      {evaluation.runId && <p>Started a run</p>}
      {evaluation.nextAttemptAt && (
        <p>
          <EventTime value={evaluation.nextAttemptAt} prefix="Next attempt" />
        </p>
      )}
      <EventHistoryDetails rows={evaluationDetails(evaluation)} />
    </article>
  );
}

export interface EventEvaluationHistoryProps {
  projectId: string;
  agentId: string;
  /** Trigger descriptions by trigger ID, so a row can name its trigger. */
  triggerLabels?: Readonly<Record<string, string>>;
}

/** The Events view: why each event matched or was skipped. */
export function EventEvaluationHistory({
  projectId,
  agentId,
  triggerLabels,
}: EventEvaluationHistoryProps) {
  const query = useEventEvaluationPages({ projectId, agentId });
  const evaluations = query.data?.pages.flatMap((page) => page.items);
  return (
    <EventHistoryFrame
      title="Event history"
      noun="events"
      emptyDescription="Events appear here once a trigger decides whether to run them."
      query={query}
      count={evaluations?.length}
    >
      {evaluations?.map((evaluation) => (
        <EventEvaluationItem
          key={evaluation.id}
          evaluation={evaluation}
          triggerLabel={triggerLabels?.[evaluation.triggerId]}
        />
      ))}
    </EventHistoryFrame>
  );
}
