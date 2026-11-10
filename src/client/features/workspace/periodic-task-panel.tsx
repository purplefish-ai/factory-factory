import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { Link } from 'react-router';
import { Loading } from '@/client/components/loading';
import { QueryErrorState, QueryRefreshError } from '@/client/components/query-error-state';
import { isNotFoundError } from '@/client/components/query-state';
import { AgentRunHistoryQuery, describeAgentSchedule } from '@/client/features/agents';
import { getProjectAgentPath, getProjectSectionPath } from '@/client/lib/project-navigation';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';

interface PeriodicTaskPanelProps {
  periodicTaskId: string;
  projectId?: string;
}

type AgentReadError = { message: string; data?: { code: string } | null };

/** NOT_FOUND gets friendly copy in place of the server message. */
function agentReadError(error: AgentReadError, refresh = false) {
  if (isNotFoundError(error)) {
    return {
      title: 'Automation not found',
      error: { message: 'Its existing workspaces remain available.' },
    };
  }
  return { title: `Couldn't ${refresh ? 'refresh' : 'load'} automation`, error };
}

function managementPath(slug: string | undefined, id?: string): string {
  if (!slug) {
    return id ? `/agents/${encodeURIComponent(id)}` : '/agents';
  }
  return id ? getProjectAgentPath(slug, id) : getProjectSectionPath(slug, 'agents');
}

function ProjectLookupState({
  error,
  retry,
  isRetrying,
}: {
  error: { message: string } | null;
  retry: () => void;
  isRetrying: boolean;
}) {
  if (!error) {
    return <Loading size="compact" message="Loading automation project…" />;
  }
  return (
    <QueryErrorState
      title="Couldn't load automation project"
      error={error}
      onRetry={retry}
      isRetrying={isRetrying}
      className="p-2"
    />
  );
}

type RetryableQuery<TError> = { error: TError | null; isFetching: boolean; refetch: () => unknown };

function MissingAgentState({
  task,
  ownerSlug,
  hasKnownOwner,
  owner,
}: {
  task: RetryableQuery<AgentReadError>;
  ownerSlug?: string;
  hasKnownOwner: boolean;
  owner: RetryableQuery<{ message: string }>;
}) {
  return (
    <div className="space-y-3 p-4 text-sm">
      {task.error ? (
        <>
          <QueryErrorState
            {...agentReadError(task.error)}
            onRetry={() => void task.refetch()}
            isRetrying={task.isFetching}
            className="p-2"
          />
          {ownerSlug || !hasKnownOwner ? (
            <Link to={managementPath(ownerSlug)} className="block text-primary underline">
              Manage automations
            </Link>
          ) : (
            <ProjectLookupState
              error={owner.error}
              retry={() => void owner.refetch()}
              isRetrying={owner.isFetching}
            />
          )}
        </>
      ) : (
        <Loading size="compact" message="Loading automation…" />
      )}
    </div>
  );
}

export function PeriodicTaskPanel({ periodicTaskId, projectId }: PeriodicTaskPanelProps) {
  const task = trpc.periodicTask.get.useQuery(
    { id: periodicTaskId },
    { refetchInterval: POLL_INTERVAL_MS.activity }
  );
  const ownerProjectId = task.data?.projectId ?? projectId;
  const project = trpc.project.getById.useQuery(
    { id: ownerProjectId ?? '' },
    { enabled: !!ownerProjectId }
  );

  if (!task.data) {
    return (
      <MissingAgentState
        task={task}
        ownerSlug={project.data?.slug}
        hasKnownOwner={!!ownerProjectId}
        owner={project}
      />
    );
  }

  const agent = task.data;
  return (
    <div className="h-full overflow-y-auto">
      {task.error ? (
        <QueryRefreshError
          {...agentReadError(task.error, true)}
          onRetry={() => void task.refetch()}
          isRetrying={task.isFetching}
        />
      ) : null}
      <div className="space-y-2 border-b bg-muted/30 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <RobotIcon className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 break-words text-sm font-medium">{agent.name}</span>
          <Badge variant="secondary">{agent.isEnabled ? 'Active' : 'Paused'}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{describeAgentSchedule(agent)}</p>
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {agent.prompt}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {agent.lastRunAt && <span>Last run: {new Date(agent.lastRunAt).toLocaleString()}</span>}
          {agent.isEnabled && <span>Next run: {new Date(agent.nextRunAt).toLocaleString()}</span>}
        </div>
        <Link
          to={managementPath(project.data?.slug, periodicTaskId)}
          className="inline-block text-xs text-primary underline underline-offset-4"
        >
          Manage automation
        </Link>
      </div>
      <div className="p-3">
        {project.error && (
          <ProjectLookupState
            error={project.error}
            retry={() => {
              void project.refetch();
            }}
            isRetrying={project.isFetching}
          />
        )}
        {project.data ? (
          <AgentRunHistoryQuery periodicTaskId={periodicTaskId} projectSlug={project.data.slug} />
        ) : !project.error ? (
          <Loading size="compact" message="Loading automation project…" />
        ) : null}
      </div>
    </div>
  );
}
