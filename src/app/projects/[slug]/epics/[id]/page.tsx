'use client';

import { ArrowLeft, Terminal } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '../../../../../frontend/lib/trpc';

const stateVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PLANNING: 'secondary',
  IN_PROGRESS: 'default',
  BLOCKED: 'destructive',
  COMPLETED: 'secondary',
  CANCELLED: 'outline',
};

const taskStateVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'outline',
  ASSIGNED: 'default',
  IN_PROGRESS: 'default',
  REVIEW: 'default',
  BLOCKED: 'destructive',
  COMPLETED: 'secondary',
  FAILED: 'destructive',
};

export default function EpicDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const id = params.id as string;

  const {
    data: topLevelTask,
    isLoading,
    error,
  } = trpc.task.getById.useQuery({ id }, { refetchInterval: 5000 });

  const { data: childTasks } = trpc.task.listByParent.useQuery(
    { parentId: id },
    { refetchInterval: 5000 }
  );

  const { data: agents } = trpc.agent.listByTopLevelTask.useQuery(
    { topLevelTaskId: id },
    { refetchInterval: 2000 }
  );

  if (isLoading) {
    return <Loading message="Loading epic..." />;
  }

  if (error || !topLevelTask) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Epic not found</p>
        <Button variant="outline" asChild>
          <Link href={`/projects/${slug}/epics`}>Back to epics</Link>
        </Button>
      </div>
    );
  }

  const supervisor = agents?.find((a) => a.type === 'SUPERVISOR');
  const workers = agents?.filter((a) => a.type === 'WORKER') ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/projects/${slug}/epics`}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{topLevelTask.title}</h1>
            <div className="flex items-center gap-3 mt-2">
              <Badge variant={stateVariants[topLevelTask.state] || 'default'}>
                {topLevelTask.state}
              </Badge>
              <span className="text-sm text-muted-foreground">
                Created {new Date(topLevelTask.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {topLevelTask.description && (
        <Card>
          <CardHeader>
            <CardTitle>Description</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm font-sans">{topLevelTask.description}</pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Supervisor Agent</CardTitle>
        </CardHeader>
        <CardContent>
          {supervisor ? (
            <div className="flex items-center justify-between">
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>
                  Agent ID: <span className="font-mono">{supervisor.id}</span>
                </p>
                <p>State: {supervisor.state}</p>
              </div>
              {supervisor.tmuxSessionName && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/projects/${slug}/agents/${supervisor.id}`}>
                    <Terminal className="h-4 w-4 mr-2" />
                    View Terminal
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No supervisor assigned yet</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tasks ({childTasks?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!childTasks || childTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks created yet</p>
          ) : (
            <div className="space-y-3">
              {childTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <Link
                      href={`/projects/${slug}/tasks/${task.id}`}
                      className="font-medium hover:underline"
                    >
                      {task.title}
                    </Link>
                    <div className="flex items-center gap-3 mt-1">
                      <Badge
                        variant={taskStateVariants[task.state] || 'default'}
                        className="text-xs"
                      >
                        {task.state}
                      </Badge>
                      {task.prUrl && (
                        <a
                          href={task.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline"
                        >
                          View PR
                        </a>
                      )}
                    </div>
                  </div>
                  {task.assignedAgentId && (
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/projects/${slug}/agents/${task.assignedAgentId}`}>
                        View Worker
                      </Link>
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {workers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active Workers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {workers.map((agent) => (
                <div key={agent.id} className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm">{agent.id.slice(0, 8)}...</span>
                    <span
                      className={`w-3 h-3 rounded-full ${agent.isHealthy ? 'bg-green-500' : 'bg-destructive'}`}
                      title={agent.isHealthy ? 'Healthy' : 'Unhealthy'}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">State: {agent.state}</p>
                  <Button variant="link" size="sm" className="px-0 mt-2" asChild>
                    <Link href={`/projects/${slug}/agents/${agent.id}`}>View Details</Link>
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
