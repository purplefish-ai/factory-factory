import type { CIStatus, Workspace, WorkspaceStatus } from '@prisma-gen/browser';
import { Kanban, List, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { WorkspaceStatusBadge } from '@/components/workspace/workspace-status-badge';
import { CIFailureWarning } from '@/frontend/components/ci-failure-warning';
import { KanbanBoard, KanbanControls, KanbanProvider } from '@/frontend/components/kanban';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';
import { trpc } from '../../../../frontend/lib/trpc';

const workspaceStatuses: WorkspaceStatus[] = ['NEW', 'PROVISIONING', 'READY', 'FAILED', 'ARCHIVED'];

type ViewMode = 'list' | 'board';

type WorkspaceWithSessions = Workspace & {
  claudeSessions?: unknown[];
};

function useCreateWorkspace(projectId: string | undefined, slug: string) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [isCreating, setIsCreating] = useState(false);
  const createWorkspace = trpc.workspace.create.useMutation();

  // Get existing workspace names for unique name generation
  const { data: allWorkspaces } = trpc.workspace.list.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId }
  );
  const existingNames = allWorkspaces?.map((w) => w.name) ?? [];

  const handleCreate = async () => {
    if (!projectId || isCreating) {
      return;
    }
    const name = generateUniqueWorkspaceName(existingNames);
    setIsCreating(true);

    try {
      const workspace = await createWorkspace.mutateAsync({
        projectId,
        name,
      });

      utils.workspace.list.invalidate({ projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId });
      navigate(`/projects/${slug}/workspaces/${workspace.id}`);
    } catch (error) {
      setIsCreating(false);
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to create workspace: ${message}`);
    }
  };

  return { handleCreate, isCreating };
}

function NewWorkspaceButton({
  onClick,
  isCreating,
  children = 'New Workspace',
}: {
  onClick: () => void;
  isCreating: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Button onClick={onClick} disabled={isCreating}>
      {isCreating ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Plus className="h-4 w-4 mr-2" />
      )}
      {children}
    </Button>
  );
}

export default function WorkspacesListPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('board');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });
  const { handleCreate, isCreating } = useCreateWorkspace(project?.id, slug);

  // Only fetch list data when in list view
  const { data: workspaces, isLoading } = trpc.workspace.list.useQuery(
    {
      projectId: project?.id ?? '',
      status: statusFilter !== 'all' ? (statusFilter as WorkspaceStatus) : undefined,
    },
    { enabled: !!project?.id && viewMode === 'list', refetchInterval: 15_000, staleTime: 10_000 }
  );

  if (!project) {
    return <Loading message="Loading project..." />;
  }

  if (viewMode === 'board') {
    return (
      <KanbanProvider projectId={project.id} projectSlug={slug}>
        <div className="flex flex-col h-screen p-6 gap-4">
          <PageHeader title="Workspaces">
            <KanbanControls />
            <ToggleGroup
              type="single"
              value={viewMode}
              onValueChange={(value) => value && setViewMode(value as ViewMode)}
              size="sm"
            >
              <ToggleGroupItem value="board" aria-label="Board view">
                <Kanban className="h-4 w-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List view">
                <List className="h-4 w-4" />
              </ToggleGroupItem>
            </ToggleGroup>
            <NewWorkspaceButton onClick={handleCreate} isCreating={isCreating} />
          </PageHeader>

          <div className="flex-1 min-h-0">
            <KanbanBoard />
          </div>
        </div>
      </KanbanProvider>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <PageHeader title="Workspaces">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {workspaceStatuses.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup
          type="single"
          value={viewMode}
          onValueChange={(value) => value && setViewMode(value as ViewMode)}
          size="sm"
        >
          <ToggleGroupItem value="board" aria-label="Board view">
            <Kanban className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List view">
            <List className="h-4 w-4" />
          </ToggleGroupItem>
        </ToggleGroup>
        <NewWorkspaceButton onClick={handleCreate} isCreating={isCreating} />
      </PageHeader>

      <Card>
        {isLoading ? (
          <Loading message="Loading workspaces..." />
        ) : !workspaces || workspaces.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyTitle>No workspaces found</EmptyTitle>
              <EmptyDescription>Get started by creating your first workspace.</EmptyDescription>
            </EmptyHeader>
            <NewWorkspaceButton onClick={handleCreate} isCreating={isCreating}>
              Create your first workspace
            </NewWorkspaceButton>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((workspace: WorkspaceWithSessions) => (
                <TableRow key={workspace.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/projects/${slug}/workspaces/${workspace.id}`}
                        className="font-medium hover:underline"
                      >
                        {workspace.name}
                      </Link>
                      <CIFailureWarning
                        ciStatus={workspace.prCiStatus as CIStatus}
                        prUrl={workspace.prUrl}
                        size="sm"
                      />
                    </div>
                    {workspace.description && (
                      <p className="text-sm text-muted-foreground truncate max-w-md">
                        {workspace.description.length > 100
                          ? `${workspace.description.slice(0, 100)}...`
                          : workspace.description}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <WorkspaceStatusBadge
                      status={workspace.status}
                      errorMessage={workspace.initErrorMessage}
                    />
                    {workspace.status === 'READY' && (
                      <span className="text-xs text-muted-foreground">Ready</span>
                    )}
                    {workspace.status === 'ARCHIVED' && (
                      <span className="text-xs text-muted-foreground">Archived</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {workspace.claudeSessions?.length ?? 0} sessions
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">
                    {workspace.branchName || '-'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(workspace.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link to={`/projects/${slug}/workspaces/${workspace.id}`}>View</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
