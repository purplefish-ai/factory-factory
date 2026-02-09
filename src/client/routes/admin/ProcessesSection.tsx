import type { inferRouterOutputs } from '@trpc/server';
import { Bot, Terminal, XCircle } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes, formatCpu, formatIdleTime } from '@/lib/formatters';
import type { AppRouter } from '../../../frontend/lib/trpc';
import { trpc } from '../../../frontend/lib/trpc';

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type ProcessesData = RouterOutputs['admin']['getActiveProcesses'];

function getStatusBadgeVariant(
  status: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status.toUpperCase()) {
    case 'RUNNING':
      return 'default';
    case 'IDLE':
    case 'COMPLETED':
      return 'secondary';
    case 'FAILED':
      return 'destructive';
    default:
      return 'outline';
  }
}

export function ProcessesSectionSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Active Processes
          <Skeleton className="h-5 w-16 ml-2" />
        </CardTitle>
        <CardDescription>Claude and Terminal processes currently running</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-5 w-48" />
          <div className="border rounded-md p-4 space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export interface ProcessesSectionProps {
  processes?: ProcessesData;
}

export function ProcessesSection({ processes }: ProcessesSectionProps) {
  const hasClaudeProcesses = processes?.claude && processes.claude.length > 0;
  const hasTerminalProcesses = processes?.terminal && processes.terminal.length > 0;
  const hasNoProcesses = !(hasClaudeProcesses || hasTerminalProcesses);
  const [stoppingSessionIds, setStoppingSessionIds] = useState<Set<string>>(new Set());

  const { data: maxSessions } = trpc.session.getMaxSessionsPerWorkspace.useQuery();
  const utils = trpc.useUtils();

  const stopSession = trpc.admin.stopClaudeSession.useMutation();

  const handleStopSession = useCallback(
    async (sessionId: string) => {
      setStoppingSessionIds((prev) => new Set(prev).add(sessionId));
      try {
        await stopSession.mutateAsync({ sessionId });
        toast.success('Session stopped successfully');
        utils.admin.getActiveProcesses.invalidate();
      } catch (error) {
        toast.error(
          `Failed to stop session: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setStoppingSessionIds((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
      }
    },
    [stopSession, utils]
  );

  // Calculate the highest session count per workspace
  const maxSessionsPerWorkspace =
    processes?.claude && processes.claude.length > 0
      ? Math.max(
          ...Object.values(
            processes.claude.reduce(
              (acc, process) => {
                acc[process.workspaceId] = (acc[process.workspaceId] || 0) + 1;
                return acc;
              },
              {} as Record<string, number>
            )
          )
        )
      : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Active Processes
          {processes?.summary && (
            <>
              <Badge variant="secondary" className="ml-2">
                {processes.summary.totalClaude} Claude sessions
              </Badge>
              {maxSessions !== undefined && maxSessionsPerWorkspace > 0 && (
                <Badge
                  variant={maxSessionsPerWorkspace >= maxSessions * 0.8 ? 'destructive' : 'outline'}
                  title={`Highest session count across all workspaces. Limit is ${maxSessions} per workspace.`}
                >
                  Max per workspace: {maxSessionsPerWorkspace}/{maxSessions}
                </Badge>
              )}
            </>
          )}
        </CardTitle>
        <CardDescription>Claude and Terminal processes currently running</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {hasNoProcesses && <p className="text-muted-foreground text-sm">No active processes</p>}

        {hasClaudeProcesses && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Bot className="w-4 h-4" />
              Claude Processes ({processes.claude.length})
            </h4>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Session</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>PID</TableHead>
                    <TableHead>Resources</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {processes.claude.map((process) => (
                    <TableRow key={process.sessionId}>
                      <TableCell>
                        <div className="flex flex-col">
                          {process.projectSlug ? (
                            <Link
                              to={`/projects/${process.projectSlug}/workspaces/${process.workspaceId}`}
                              className="font-medium hover:underline"
                            >
                              {process.workspaceName}
                            </Link>
                          ) : (
                            <span className="font-medium">{process.workspaceName}</span>
                          )}
                          {process.workspaceBranch && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {process.workspaceBranch}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-xs font-mono text-muted-foreground">
                            {process.name || process.sessionId.slice(0, 8)}
                          </span>
                          <span className="text-xs text-muted-foreground">{process.model}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{process.workflow}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{process.pid ?? '-'}</TableCell>
                      <TableCell>
                        <div className="flex flex-col text-xs font-mono">
                          <span>CPU: {formatCpu(process.cpuPercent)}</span>
                          <span>Mem: {formatBytes(process.memoryBytes)}</span>
                          <span className="text-muted-foreground">
                            Idle: {formatIdleTime(process.idleTimeMs)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant={getStatusBadgeVariant(process.status)}>
                            {process.status}
                          </Badge>
                          {process.memoryStatus &&
                            process.memoryStatus !== process.status.toLowerCase() && (
                              <span className="text-xs text-muted-foreground">
                                ({process.memoryStatus})
                              </span>
                            )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleStopSession(process.sessionId)}
                          disabled={
                            stoppingSessionIds.has(process.sessionId) ||
                            process.status === 'COMPLETED' ||
                            process.status === 'FAILED'
                          }
                          title="Stop session"
                        >
                          <XCircle className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {hasTerminalProcesses && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Terminal className="w-4 h-4" />
              Terminal Processes ({processes.terminal.length})
            </h4>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Terminal ID</TableHead>
                    <TableHead>PID</TableHead>
                    <TableHead>Resources</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {processes.terminal.map((process) => (
                    <TableRow key={process.terminalId}>
                      <TableCell>
                        <div className="flex flex-col">
                          {process.projectSlug ? (
                            <Link
                              to={`/projects/${process.projectSlug}/workspaces/${process.workspaceId}`}
                              className="font-medium hover:underline"
                            >
                              {process.workspaceName}
                            </Link>
                          ) : (
                            <span className="font-medium">{process.workspaceName}</span>
                          )}
                          {process.workspaceBranch && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {process.workspaceBranch}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs font-mono text-muted-foreground">
                          {process.terminalId.slice(0, 12)}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{process.pid}</TableCell>
                      <TableCell>
                        <div className="flex flex-col text-xs font-mono">
                          <span>CPU: {formatCpu(process.cpuPercent)}</span>
                          <span>Mem: {formatBytes(process.memoryBytes)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {process.cols}x{process.rows}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(process.createdAt).toLocaleTimeString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
