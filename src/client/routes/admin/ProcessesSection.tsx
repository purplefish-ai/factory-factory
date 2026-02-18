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
import type { AppRouter } from '@/frontend/lib/trpc';
import { trpc } from '@/frontend/lib/trpc';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatBytes, formatCpu, formatIdleTime } from '@/lib/formatters';

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

function WorkspaceCell(props: {
  process: {
    projectSlug?: string | null;
    workspaceId: string;
    workspaceName: string;
    workspaceBranch?: string | null;
  };
}) {
  const { process } = props;
  return (
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
          <span className="text-xs text-muted-foreground font-mono">{process.workspaceBranch}</span>
        )}
      </div>
    </TableCell>
  );
}

function AgentProcessCard({
  process,
  isStopping,
  onStop,
}: {
  process: ProcessesData['agent'][number];
  isStopping: boolean;
  onStop: (sessionId: string) => void;
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium truncate">{process.workspaceName}</div>
          {process.workspaceBranch && (
            <div className="text-xs text-muted-foreground font-mono truncate">
              {process.workspaceBranch}
            </div>
          )}
          <div className="mt-1 text-xs text-muted-foreground font-mono">
            {process.name || process.sessionId.slice(0, 8)}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onStop(process.sessionId)}
          disabled={isStopping || process.status === 'COMPLETED' || process.status === 'FAILED'}
          title="Stop session"
        >
          <XCircle className="w-4 h-4" />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">{process.workflow}</Badge>
        <Badge variant={getStatusBadgeVariant(process.status)}>{process.status}</Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs font-mono text-muted-foreground">
        <span>CPU: {formatCpu(process.cpuPercent)}</span>
        <span>Mem: {formatBytes(process.memoryBytes)}</span>
        <span>Idle: {formatIdleTime(process.idleTimeMs)}</span>
        <span>PID: {process.pid ?? '-'}</span>
      </div>
    </div>
  );
}

function TerminalProcessCard({ process }: { process: ProcessesData['terminal'][number] }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="font-medium truncate">{process.workspaceName}</div>
      {process.workspaceBranch && (
        <div className="text-xs text-muted-foreground font-mono truncate">
          {process.workspaceBranch}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground font-mono">
        <span>Terminal: {process.terminalId.slice(0, 12)}</span>
        <span>PID: {process.pid}</span>
        <span>
          Size: {process.cols}x{process.rows}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-mono text-muted-foreground">
        <span>CPU: {formatCpu(process.cpuPercent)}</span>
        <span>Mem: {formatBytes(process.memoryBytes)}</span>
        <span>Created: {new Date(process.createdAt).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

export function ProcessesSectionSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Active Processes
          <Skeleton className="h-5 w-16 ml-2" />
        </CardTitle>
        <CardDescription>Agent and Terminal processes currently running</CardDescription>
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
  const isMobile = useIsMobile();
  const hasAgentProcesses = processes?.agent && processes.agent.length > 0;
  const hasTerminalProcesses = processes?.terminal && processes.terminal.length > 0;
  const hasNoProcesses = !(hasAgentProcesses || hasTerminalProcesses);
  const [stoppingSessionIds, setStoppingSessionIds] = useState<Set<string>>(new Set());

  const { data: maxSessions } = trpc.session.getMaxSessionsPerWorkspace.useQuery();
  const utils = trpc.useUtils();

  const stopSession = trpc.admin.stopSession.useMutation();

  const handleStopSession = useCallback(
    async (sessionId: string) => {
      setStoppingSessionIds((prev) => new Set(prev).add(sessionId));
      try {
        const result = await stopSession.mutateAsync({ sessionId });
        if (result.wasRunning) {
          toast.success('Session stopped');
        } else {
          toast.info('Session was already stopped');
        }
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
    processes?.agent && processes.agent.length > 0
      ? Math.max(
          ...Object.values(
            processes.agent.reduce(
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
        <CardTitle className="flex flex-wrap items-center gap-2">
          Active Processes
          {processes?.summary && (
            <>
              <Badge variant="secondary" className="ml-2">
                {processes.summary.totalAgent} Agent sessions
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
        <CardDescription>Agent and Terminal processes currently running</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {hasNoProcesses && <p className="text-muted-foreground text-sm">No active processes</p>}

        {hasAgentProcesses && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Bot className="w-4 h-4" />
              Agent Sessions ({processes.agent.length})
            </h4>
            {isMobile ? (
              <div className="space-y-2">
                {processes.agent.map((process) => (
                  <AgentProcessCard
                    key={process.sessionId}
                    process={process}
                    isStopping={stoppingSessionIds.has(process.sessionId)}
                    onStop={handleStopSession}
                  />
                ))}
              </div>
            ) : (
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
                    {processes.agent.map((process) => (
                      <TableRow key={process.sessionId}>
                        <WorkspaceCell process={process} />
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
            )}
          </div>
        )}

        {hasTerminalProcesses && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Terminal className="w-4 h-4" />
              Terminal Processes ({processes.terminal.length})
            </h4>
            {isMobile ? (
              <div className="space-y-2">
                {processes.terminal.map((process) => (
                  <TerminalProcessCard key={process.terminalId} process={process} />
                ))}
              </div>
            ) : (
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
                        <WorkspaceCell process={process} />
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
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
