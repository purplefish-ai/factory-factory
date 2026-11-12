import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { Link } from 'react-router';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { QueryErrorState, QueryRefreshError } from '@/client/components/query-error-state';
import { EventRunItem } from '@/client/features/agents';
import { getProjectAgentPath } from '@/client/lib/project-navigation';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';

/**
 * The retained event run that created a workspace. Only event-run workspaces
 * read it; the panel polls it while the right panel only decides whether the
 * Runs tab exists, from the same cache entry.
 */
export function useWorkspaceAutomationOrigin({
  workspaceId,
  projectId,
  enabled,
  poll = false,
}: {
  workspaceId: string;
  projectId: string | undefined;
  enabled: boolean;
  poll?: boolean;
}) {
  return trpc.automation.workspaceOrigin.useQuery(
    { projectId: projectId ?? '', workspaceId },
    {
      enabled: enabled && !!projectId,
      refetchInterval: poll ? POLL_INTERVAL_MS.activity : undefined,
    }
  );
}

/**
 * Whether a workspace has a Runs tab, and whether that tab is for an event run.
 * Only event-run workspaces read their origin. Until that read settles they
 * keep the tab (showing its loading or error state); a settled origin without
 * a retained run removes it, as deleting a scheduled automation does.
 */
export function useRunsOrigin(
  workspaceId: string,
  workspace:
    | { projectId?: string; periodicTaskId?: string | null; creationSource?: string | null }
    | undefined
) {
  const projectId = workspace?.projectId;
  const isEventRun = workspace?.creationSource === 'EVENT_AGENT' && !workspace.periodicTaskId;
  const origin = useWorkspaceAutomationOrigin({ workspaceId, projectId, enabled: isEventRun });
  const hasEventOrigin =
    isEventRun && !!projectId && (origin.data === undefined || !!origin.data?.run);
  return { hasEventOrigin, hasRuns: !!workspace?.periodicTaskId || hasEventOrigin };
}

/** The Runs tab of an event-run workspace: its automation and the run that started it. */
export function AutomationOriginPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const origin = useWorkspaceAutomationOrigin({
    workspaceId,
    projectId,
    enabled: true,
    poll: true,
  });
  const run = origin.data?.run ?? null;
  const ownerProjectId = origin.data?.origin.projectId ?? projectId;
  const agent = trpc.automation.get.useQuery(
    { projectId: ownerProjectId, agentId: run?.agentId ?? '' },
    { enabled: !!run, refetchInterval: POLL_INTERVAL_MS.activity }
  );
  const project = trpc.project.getById.useQuery({ id: ownerProjectId });

  if (origin.data === undefined) {
    return origin.error ? (
      <QueryErrorState
        title="Couldn't load automation"
        error={origin.error}
        onRetry={() => void origin.refetch()}
        isRetrying={origin.isFetching}
        className="p-4"
      />
    ) : (
      <Loading size="compact" message="Loading automation…" />
    );
  }
  if (!run) {
    return (
      <EmptyState
        size="compact"
        title="No automation run linked"
        description="The run that started this workspace is no longer kept."
      />
    );
  }
  const slug = project.data?.slug;
  return (
    <div className="h-full overflow-y-auto">
      {origin.error ? (
        <QueryRefreshError
          title="Couldn't refresh automation"
          error={origin.error}
          onRetry={() => void origin.refetch()}
          isRetrying={origin.isFetching}
        />
      ) : null}
      <div className="space-y-2 border-b bg-muted/30 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <RobotIcon className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 break-words text-sm font-medium">
            {agent.data?.name ?? 'Automation'}
          </span>
          <Badge variant="secondary">Event-triggered</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          This workspace was started by the run below.
        </p>
        {agent.error ? (
          <QueryRefreshError
            title="Couldn't load automation details"
            error={agent.error}
            onRetry={() => void agent.refetch()}
            isRetrying={agent.isFetching}
            className="rounded-md border"
          />
        ) : null}
        {project.error ? (
          <QueryRefreshError
            title="Couldn't load automation project"
            error={project.error}
            onRetry={() => void project.refetch()}
            isRetrying={project.isFetching}
            className="rounded-md border"
          />
        ) : null}
        {slug && (
          <Link
            to={getProjectAgentPath(slug, run.agentId, 'event')}
            className="inline-block text-xs text-primary underline underline-offset-4"
          >
            Manage automation
          </Link>
        )}
      </div>
      <section aria-label="This workspace's run" className="p-3">
        <div className="rounded-lg border">
          <EventRunItem run={run} projectSlug={slug ?? ''} showWorkspaceLink={false} />
        </div>
      </section>
    </div>
  );
}
