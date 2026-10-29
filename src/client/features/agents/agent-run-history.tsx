import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { Link } from 'react-router';
import { getProjectSectionPath } from '@/client/lib/project-navigation';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AgentRun } from './types';

export interface AgentRunHistoryProps {
  runs?: AgentRun[];
  projectSlug: string;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}
const STATUS_LABELS: Record<AgentRun['status'], string> = {
  RUNNING: 'Running',
  PR_CREATED: 'PR created',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
};

const MISSING_WORKSPACE_LABELS: Record<AgentRun['status'], string> = {
  RUNNING: 'No workspace yet',
  FAILED: 'No workspace linked',
  PR_CREATED: 'Workspace unavailable',
  SKIPPED: 'Workspace unavailable',
};

export function AgentRunHistory({
  runs,
  projectSlug,
  isLoading,
  error,
  onRetry,
}: AgentRunHistoryProps) {
  return (
    <section aria-label="Run history" className="min-w-0 space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Run history</h3>
        <p className="mt-1 text-xs text-muted-foreground">Up to 50 recent runs</p>
      </div>
      {error && (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">Could not load run history: {error}</p>
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry run history
            </Button>
          )}
        </div>
      )}
      {isLoading && !runs && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading run history…
        </p>
      )}
      {!(error || isLoading) && runs?.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No runs yet. Future runs will appear here.
        </p>
      )}
      {runs && runs.length > 0 && (
        <div className="divide-y rounded-lg border">
          {runs.map((run) => (
            <article key={run.id} className="min-w-0 space-y-2 p-4 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={run.status === 'FAILED' ? 'destructive' : 'secondary'}>
                  {STATUS_LABELS[run.status]}
                </Badge>
                <time
                  dateTime={new Date(run.startedAt).toISOString()}
                  className="text-muted-foreground"
                >
                  {new Date(run.startedAt).toLocaleString()}
                </time>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {run.workspaceId ? (
                  <Link
                    to={`${getProjectSectionPath(projectSlug, 'workspaces')}/${encodeURIComponent(run.workspaceId)}`}
                    className="font-medium text-primary underline underline-offset-4"
                  >
                    Open workspace <span className="sr-only">for run {run.id}</span>
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {MISSING_WORKSPACE_LABELS[run.status]}
                  </span>
                )}
                {run.prUrl && (
                  <a
                    href={run.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {run.prNumber ? `PR #${run.prNumber}` : 'Pull request'}
                    <ArrowSquareOutIcon className="size-3" />
                    <span className="sr-only"> (opens in new tab)</span>
                  </a>
                )}
              </div>
              {run.errorMessage && (
                <p className="whitespace-pre-wrap break-words text-destructive">
                  {run.errorMessage}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/** Shared live history for the management page and a workspace's origin panel. */
export function AgentRunHistoryQuery({
  periodicTaskId,
  projectSlug,
}: {
  periodicTaskId: string;
  projectSlug: string;
}) {
  const history = trpc.periodicTask.listExecutions.useQuery(
    { periodicTaskId, limit: 50 },
    { refetchInterval: 10_000 }
  );
  return (
    <AgentRunHistory
      projectSlug={projectSlug}
      runs={history.data}
      isLoading={history.isLoading}
      error={history.error?.message}
      onRetry={() => {
        void history.refetch();
      }}
    />
  );
}
