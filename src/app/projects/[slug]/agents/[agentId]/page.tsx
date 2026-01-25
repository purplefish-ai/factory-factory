'use client';

import { ArrowLeft, ExternalLink, GitBranch } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AgentActivity } from '@/components/agent-activity';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '@/frontend/lib/trpc';

const executionStateVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> =
  {
    IDLE: 'outline',
    ACTIVE: 'default',
    PAUSED: 'secondary',
    CRASHED: 'destructive',
  };

const agentTypeLabels: Record<string, string> = {
  ORCHESTRATOR: 'Orchestrator',
  SUPERVISOR: 'Supervisor',
  WORKER: 'Worker',
};

// Type for the agent with relations that the accessor includes
interface AgentTask {
  id: string;
  title: string;
  state: string;
  branchName?: string | null;
  prUrl?: string | null;
}

interface AgentWithRelations {
  id: string;
  type: string;
  executionState: string;
  desiredExecutionState: string;
  currentTaskId: string | null;
  sessionId: string | null;
  tmuxSessionName: string | null;
  cliProcessStatus: string | null;
  isHealthy: boolean;
  minutesSinceHeartbeat: number;
  currentTask?: AgentTask | null;
  assignedTasks?: AgentTask[];
}

interface StateCardProps {
  agent: AgentWithRelations;
}

function StateCard({ agent }: StateCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">State</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Execution</span>
          <span className="font-medium">{agent.executionState}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Desired</span>
          <span className="font-medium">{agent.desiredExecutionState}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Heartbeat</span>
          <span className="font-medium">{agent.minutesSinceHeartbeat}m ago</span>
        </div>
      </CardContent>
    </Card>
  );
}

function SessionCard({ agent }: StateCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Session</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Session ID</span>
          <span className="font-mono text-xs truncate max-w-[150px]">
            {agent.sessionId || 'None'}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">tmux</span>
          <span className="font-mono text-xs truncate max-w-[150px]">
            {agent.tmuxSessionName || 'None'}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">CLI Process</span>
          <span className="font-medium">{agent.cliProcessStatus || 'Unknown'}</span>
        </div>
      </CardContent>
    </Card>
  );
}

interface TasksCardProps {
  tasks: AgentTask[];
  slug: string;
}

function TasksCard({ tasks, slug }: TasksCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Tasks</CardTitle>
      </CardHeader>
      <CardContent>
        {tasks.length > 0 ? (
          <ul className="space-y-1">
            {tasks.slice(0, 3).map((task) => (
              <li key={task.id} className="text-sm truncate">
                <Link
                  href={`/projects/${slug}/tasks/${task.id}`}
                  className="text-primary hover:underline"
                >
                  {task.title}
                </Link>
                <Badge variant="outline" className="ml-2 text-xs">
                  {task.state}
                </Badge>
              </li>
            ))}
            {tasks.length > 3 && (
              <li className="text-xs text-muted-foreground">+{tasks.length - 3} more</li>
            )}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No tasks assigned</p>
        )}
      </CardContent>
    </Card>
  );
}

interface AgentHeaderProps {
  agent: AgentWithRelations;
  slug: string;
  taskId?: string;
  taskTitle?: string;
}

function AgentHeader({ agent, slug, taskId, taskTitle }: AgentHeaderProps) {
  const currentTask = agent.currentTask;

  return (
    <div className="flex-shrink-0 border-b p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/projects/${slug}/epics`}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight">
                {agentTypeLabels[agent.type] || agent.type}
              </h1>
              <Badge variant={executionStateVariants[agent.executionState] || 'default'}>
                {agent.executionState}
              </Badge>
              <span
                className={`w-2 h-2 rounded-full ${agent.isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
                title={agent.isHealthy ? 'Healthy' : 'Unhealthy'}
              />
            </div>
            <p className="text-sm text-muted-foreground font-mono mt-1">{agent.id}</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {currentTask?.branchName && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <GitBranch className="h-4 w-4" />
              <span className="font-mono">{currentTask.branchName}</span>
            </div>
          )}
          {currentTask?.prUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={currentTask.prUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-1" />
                View PR
              </a>
            </Button>
          )}
        </div>
      </div>

      {taskId && taskTitle && (
        <div className="mt-3 ml-14">
          <Link
            href={`/projects/${slug}/tasks/${taskId}`}
            className="text-sm text-primary hover:underline"
          >
            Task: {taskTitle}
          </Link>
        </div>
      )}
    </div>
  );
}

export default function AgentDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const agentId = params.agentId as string;

  const {
    data: agentData,
    isLoading,
    error,
  } = trpc.agent.getById.useQuery({ id: agentId }, { refetchInterval: 5000 });

  if (isLoading) {
    return <Loading message="Loading agent..." />;
  }

  if (error || !agentData) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Agent not found</p>
        <Button variant="outline" asChild>
          <Link href={`/projects/${slug}/epics`}>Back to epics</Link>
        </Button>
      </div>
    );
  }

  const agent = agentData as unknown as AgentWithRelations;
  const currentTask = agent.currentTask;
  const assignedTasks = agent.assignedTasks || [];
  const taskId = agent.currentTaskId || assignedTasks[0]?.id;
  const taskTitle = currentTask?.title || assignedTasks[0]?.title;

  return (
    <div className="flex flex-col h-full">
      <AgentHeader agent={agent} slug={slug} taskId={taskId} taskTitle={taskTitle} />

      <div className="flex-shrink-0 p-4 grid grid-cols-1 md:grid-cols-3 gap-4 border-b">
        <StateCard agent={agent} />
        <SessionCard agent={agent} />
        <TasksCard tasks={assignedTasks} slug={slug} />
      </div>

      <div className="flex-1 min-h-0">
        <AgentActivity agentId={agentId} projectSlug={slug} showStats={true} showStatusBar={true} />
      </div>
    </div>
  );
}
