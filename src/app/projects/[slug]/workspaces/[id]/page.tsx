'use client';

import type { ClaudeSession, SessionStatus } from '@prisma-gen/browser';
import { Archive, ArrowLeft, ExternalLink, GitBranch, Play, Plus, Square } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '../../../../../frontend/lib/trpc';

const statusVariants: Record<string, 'default' | 'secondary' | 'outline'> = {
  ACTIVE: 'default',
  COMPLETED: 'secondary',
  ARCHIVED: 'outline',
};

const sessionStatusVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  IDLE: 'outline',
  RUNNING: 'default',
  PAUSED: 'secondary',
  COMPLETED: 'secondary',
  FAILED: 'destructive',
};

export default function WorkspaceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const id = params.id as string;

  const [isCreateSessionOpen, setIsCreateSessionOpen] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [sessionWorkflow, setSessionWorkflow] = useState('explore');
  const [sessionModel, setSessionModel] = useState('sonnet');

  const utils = trpc.useUtils();

  const {
    data: workspace,
    isLoading,
    error,
  } = trpc.workspace.get.useQuery({ id }, { refetchInterval: 5000 });

  const { data: claudeSessions } = trpc.session.listClaudeSessions.useQuery(
    { workspaceId: id },
    { refetchInterval: 5000 }
  );

  const archiveWorkspace = trpc.workspace.archive.useMutation({
    onSuccess: () => {
      router.push(`/projects/${slug}/workspaces`);
    },
  });

  const createSession = trpc.session.createClaudeSession.useMutation({
    onSuccess: () => {
      setIsCreateSessionOpen(false);
      setSessionName('');
      setSessionWorkflow('explore');
      setSessionModel('sonnet');
      utils.session.listClaudeSessions.invalidate({ workspaceId: id });
    },
  });

  const updateSession = trpc.session.updateClaudeSession.useMutation({
    onSuccess: () => {
      utils.session.listClaudeSessions.invalidate({ workspaceId: id });
    },
  });

  const handleCreateSession = () => {
    createSession.mutate({
      workspaceId: id,
      name: sessionName || undefined,
      workflow: sessionWorkflow,
      model: sessionModel,
    });
  };

  const handleStartSession = (sessionId: string) => {
    updateSession.mutate({ id: sessionId, status: 'RUNNING' as SessionStatus });
  };

  const handleStopSession = (sessionId: string) => {
    updateSession.mutate({ id: sessionId, status: 'IDLE' as SessionStatus });
  };

  if (isLoading) {
    return <Loading message="Loading workspace..." />;
  }

  if (error || !workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">Workspace not found</p>
        <Button variant="outline" asChild>
          <Link href={`/projects/${slug}/workspaces`}>Back to workspaces</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/projects/${slug}/workspaces`}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{workspace.name}</h1>
            <div className="flex items-center gap-3 mt-2">
              <Badge variant={statusVariants[workspace.status] || 'default'}>
                {workspace.status}
              </Badge>
              <span className="text-sm text-muted-foreground">
                Created {new Date(workspace.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
        {workspace.status !== 'ARCHIVED' && (
          <Button
            variant="outline"
            onClick={() => archiveWorkspace.mutate({ id })}
            disabled={archiveWorkspace.isPending}
          >
            <Archive className="h-4 w-4 mr-2" />
            {archiveWorkspace.isPending ? 'Archiving...' : 'Archive'}
          </Button>
        )}
      </div>

      {workspace.description && (
        <Card>
          <CardHeader>
            <CardTitle>Description</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm font-sans">{workspace.description}</pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            {workspace.branchName && (
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Branch:</span>
                <span className="font-mono">{workspace.branchName}</span>
              </div>
            )}
            {workspace.worktreePath && (
              <div>
                <span className="text-muted-foreground">Worktree Path:</span>
                <span className="font-mono ml-2">{workspace.worktreePath}</span>
              </div>
            )}
            {workspace.prUrl && (
              <div className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">PR:</span>
                <a
                  href={workspace.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  View Pull Request
                </a>
              </div>
            )}
            {workspace.githubIssueUrl && (
              <div className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">GitHub Issue:</span>
                <a
                  href={workspace.githubIssueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  #{workspace.githubIssueNumber}
                </a>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Claude Sessions ({claudeSessions?.length ?? 0})</CardTitle>
          <Dialog open={isCreateSessionOpen} onOpenChange={setIsCreateSessionOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-2" />
                New Session
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Claude Session</DialogTitle>
                <DialogDescription>
                  Create a new Claude session for this workspace.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="session-name">Name (optional)</Label>
                  <Input
                    id="session-name"
                    value={sessionName}
                    onChange={(e) => setSessionName(e.target.value)}
                    placeholder="E.g., Exploration Session"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="session-workflow">Workflow</Label>
                  <Select value={sessionWorkflow} onValueChange={setSessionWorkflow}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="explore">Explore</SelectItem>
                      <SelectItem value="implement">Implement</SelectItem>
                      <SelectItem value="test">Test</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="session-model">Model</Label>
                  <Select value={sessionModel} onValueChange={setSessionModel}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sonnet">Sonnet</SelectItem>
                      <SelectItem value="opus">Opus</SelectItem>
                      <SelectItem value="haiku">Haiku</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateSessionOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateSession} disabled={createSession.isPending}>
                  {createSession.isPending ? 'Creating...' : 'Create Session'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {!claudeSessions || claudeSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Claude sessions yet</p>
          ) : (
            <div className="space-y-3">
              {claudeSessions.map((session: ClaudeSession) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium">
                      {session.name || `Session ${session.id.slice(0, 8)}`}
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <Badge
                        variant={sessionStatusVariants[session.status] || 'default'}
                        className="text-xs"
                      >
                        {session.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        Workflow: {session.workflow}
                      </span>
                      <span className="text-xs text-muted-foreground">Model: {session.model}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {session.status === 'IDLE' || session.status === 'PAUSED' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStartSession(session.id)}
                        disabled={updateSession.isPending}
                      >
                        <Play className="h-4 w-4 mr-1" />
                        Start
                      </Button>
                    ) : session.status === 'RUNNING' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStopSession(session.id)}
                        disabled={updateSession.isPending}
                      >
                        <Square className="h-4 w-4 mr-1" />
                        Stop
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
