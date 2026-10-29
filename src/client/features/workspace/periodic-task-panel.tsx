import { CalendarIcon } from '@phosphor-icons/react/dist/csr/Calendar';
import { Link } from 'react-router';
import { AgentRunHistoryQuery, describeAgentSchedule } from '@/client/features/agents';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface PeriodicTaskPanelProps {
  periodicTaskId: string;
}

export function PeriodicTaskPanel({ periodicTaskId }: PeriodicTaskPanelProps) {
  const task = trpc.periodicTask.get.useQuery({ id: periodicTaskId }, { refetchInterval: 10_000 });
  const project = trpc.project.getById.useQuery(
    { id: task.data?.projectId ?? '' },
    { enabled: !!task.data }
  );

  if (!task.data) {
    return (
      <div className="space-y-3 p-4 text-sm">
        {task.error ? (
          <>
            <p role="alert" className="text-destructive">
              {task.error.data?.code === 'NOT_FOUND'
                ? 'Agent not found. Its existing workspaces remain available.'
                : `Could not load agent: ${task.error.message}`}
            </p>
            <Button size="sm" variant="outline" onClick={() => void task.refetch()}>
              Retry agent
            </Button>
            <Link to="/agents" className="block text-primary underline">
              Manage Agents
            </Link>
          </>
        ) : (
          <p role="status" className="text-muted-foreground">
            Loading agent…
          </p>
        )}
      </div>
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
          to={`/agents/${periodicTaskId}`}
          className="inline-block text-xs text-primary underline underline-offset-4"
        >
          Manage Agent
        </Link>
        {task.error && (
          <p role="alert" className="text-xs text-destructive">
            Could not refresh agent: {task.error.message}
          </p>
        )}
      </div>
      <div className="p-3">
        {project.error && (
          <div role="alert" className="space-y-2 text-xs">
            <p className="text-destructive">
              Could not load agent project: {project.error.message}
            </p>
            <Button size="sm" variant="outline" onClick={() => void project.refetch()}>
              Retry project
            </Button>
          </div>
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
