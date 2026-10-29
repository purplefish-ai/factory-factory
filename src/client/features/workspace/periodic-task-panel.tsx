import { CalendarIcon } from '@phosphor-icons/react/dist/csr/Calendar';
import { Link } from 'react-router';
import { AgentRunHistoryQuery, describeAgentSchedule } from '@/client/features/agents';
import { getProjectAgentPath, getProjectSectionPath } from '@/client/lib/project-navigation';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface PeriodicTaskPanelProps {
  periodicTaskId: string;
  projectId?: string;
}

function agentReadError(
  error: { message: string; data?: { code: string } | null },
  refresh = false
): string {
  if (error.data?.code === 'NOT_FOUND') {
    return 'Agent not found. Its existing workspaces remain available.';
  }
  return `Could not ${refresh ? 'refresh' : 'load'} agent: ${error.message}`;
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
}: {
  error: { message: string } | null;
  retry: () => void;
}) {
  if (!error) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading agent project…
      </p>
    );
  }
  return (
    <div role="alert" className="space-y-2 text-xs">
      <p className="text-destructive">Could not load agent project: {error.message}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Retry project
      </Button>
    </div>
  );
}

function MissingAgentState({
  taskError,
  retryTask,
  ownerSlug,
  hasKnownOwner,
  ownerError,
  retryOwner,
}: {
  taskError: Parameters<typeof agentReadError>[0] | null;
  retryTask: () => void;
  ownerSlug?: string;
  hasKnownOwner: boolean;
  ownerError: { message: string } | null;
  retryOwner: () => void;
}) {
  return (
    <div className="space-y-3 p-4 text-sm">
      {taskError ? (
        <>
          <p role="alert" className="text-destructive">
            {agentReadError(taskError)}
          </p>
          <Button size="sm" variant="outline" onClick={retryTask}>
            Retry agent
          </Button>
          {ownerSlug || !hasKnownOwner ? (
            <Link to={managementPath(ownerSlug)} className="block text-primary underline">
              Manage Agents
            </Link>
          ) : (
            <ProjectLookupState error={ownerError} retry={retryOwner} />
          )}
        </>
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading agent…
        </p>
      )}
    </div>
  );
}

export function PeriodicTaskPanel({ periodicTaskId, projectId }: PeriodicTaskPanelProps) {
  const task = trpc.periodicTask.get.useQuery({ id: periodicTaskId }, { refetchInterval: 10_000 });
  const ownerProjectId = task.data?.projectId ?? projectId;
  const project = trpc.project.getById.useQuery(
    { id: ownerProjectId ?? '' },
    { enabled: !!ownerProjectId }
  );

  if (!task.data) {
    return (
      <MissingAgentState
        taskError={task.error}
        retryTask={() => {
          void task.refetch();
        }}
        ownerSlug={project.data?.slug}
        hasKnownOwner={!!ownerProjectId}
        ownerError={project.error}
        retryOwner={() => {
          void project.refetch();
        }}
      />
    );
  }

  const agent = task.data;
  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-2 border-b bg-muted/30 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <CalendarIcon className="size-3.5 text-muted-foreground" />
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
          Manage Agent
        </Link>
        {task.error && (
          <div className="space-y-2">
            <p role="alert" className="text-xs text-destructive">
              {agentReadError(task.error, true)}
            </p>
            <Button size="sm" variant="outline" onClick={() => void task.refetch()}>
              Retry agent
            </Button>
          </div>
        )}
      </div>
      <div className="p-3">
        {project.error && (
          <ProjectLookupState
            error={project.error}
            retry={() => {
              void project.refetch();
            }}
          />
        )}
        {project.data ? (
          <AgentRunHistoryQuery periodicTaskId={periodicTaskId} projectSlug={project.data.slug} />
        ) : !project.error ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading agent project…
          </p>
        ) : null}
      </div>
    </div>
  );
}
