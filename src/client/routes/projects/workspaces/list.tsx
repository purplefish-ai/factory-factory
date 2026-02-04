import type { CIStatus, Workspace, WorkspaceStatus } from '@prisma-gen/browser';
import { GitBranch, Kanban, List, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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
import { rememberResumeWorkspace } from './resume-workspace-storage';

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
      // Note: We intentionally don't reset isCreating here. On success, navigate()
      // unmounts this component, making state updates unnecessary. Resetting in a
      // finally block could trigger React warnings about updating unmounted components.
      // This matches the sidebar implementation in app-sidebar.tsx.
      navigate(`/projects/${slug}/workspaces/${workspace.id}`);
    } catch (error) {
      setIsCreating(false);
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to create workspace: ${message}`);
    }
  };

  return { handleCreate, isCreating, existingNames };
}

function makeUniqueWorkspaceName(baseName: string, existingNames: string[]): string {
  const trimmedName = baseName.trim();
  if (!trimmedName) {
    return generateUniqueWorkspaceName(existingNames);
  }

  if (!existingNames.includes(trimmedName)) {
    return trimmedName;
  }

  let suffix = 1;
  let candidate = `${trimmedName}-${suffix}`;
  while (existingNames.includes(candidate)) {
    suffix += 1;
    candidate = `${trimmedName}-${suffix}`;
  }

  return candidate;
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
    <Button size="sm" onClick={onClick} disabled={isCreating}>
      {isCreating ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Plus className="h-4 w-4 mr-2" />
      )}
      {children}
    </Button>
  );
}

type BranchInfo = {
  name: string;
  displayName: string;
  refType: 'local' | 'remote';
};

// resume workspace storage helpers live in resume-workspace-storage.ts

function ResumeBranchDialog({
  open,
  onOpenChange,
  branches,
  isLoading,
  isSubmitting,
  onSelectBranch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: BranchInfo[];
  isLoading: boolean;
  isSubmitting: boolean;
  onSelectBranch: (branch: BranchInfo) => void;
}) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search branches..." />
      <CommandList>
        {isLoading && <CommandEmpty>Loading branches...</CommandEmpty>}
        {!isLoading && branches.length === 0 && <CommandEmpty>No branches found.</CommandEmpty>}
        {!isLoading && branches.length > 0 && (
          <CommandGroup heading="Branches">
            {branches.map((branch) => (
              <CommandItem
                key={branch.name}
                value={branch.displayName}
                onSelect={() => onSelectBranch(branch)}
                disabled={isSubmitting}
              >
                <span className="font-mono text-sm">{branch.displayName}</span>
                {branch.refType === 'remote' && (
                  <span className="ml-auto text-xs text-muted-foreground">remote</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function WorkspacesBoardView({
  projectId,
  slug,
  viewMode,
  onViewModeChange,
  onResumeOpen,
  onCreateWorkspace,
  isCreatingWorkspace,
  resumeDialog,
}: {
  projectId: string;
  slug: string;
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  onResumeOpen: () => void;
  onCreateWorkspace: () => void;
  isCreatingWorkspace: boolean;
  resumeDialog: React.ReactNode;
}) {
  return (
    <KanbanProvider projectId={projectId} projectSlug={slug}>
      <div className="flex flex-col h-screen p-6 gap-4">
        <PageHeader title="Workspaces">
          <KanbanControls />
          <ToggleGroup
            type="single"
            value={viewMode}
            onValueChange={(value) => value && onViewModeChange(value as ViewMode)}
            size="sm"
          >
            <ToggleGroupItem value="board" aria-label="Board view">
              <Kanban className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List view">
              <List className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" size="sm" onClick={onResumeOpen}>
            <GitBranch className="h-4 w-4 mr-2" />
            Resume branch
          </Button>
          <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace} />
        </PageHeader>

        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
        {resumeDialog}
      </div>
    </KanbanProvider>
  );
}

function WorkspacesTableView({
  workspaces,
  isLoading,
  slug,
  statusFilter,
  onStatusFilterChange,
  viewMode,
  onViewModeChange,
  onResumeOpen,
  onCreateWorkspace,
  isCreatingWorkspace,
  resumeDialog,
}: {
  workspaces?: WorkspaceWithSessions[];
  isLoading: boolean;
  slug: string;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  onResumeOpen: () => void;
  onCreateWorkspace: () => void;
  isCreatingWorkspace: boolean;
  resumeDialog: React.ReactNode;
}) {
  return (
    <div className="space-y-4 p-6">
      <PageHeader title="Workspaces">
        <Select value={statusFilter} onValueChange={onStatusFilterChange}>
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
          onValueChange={(value) => value && onViewModeChange(value as ViewMode)}
          size="sm"
        >
          <ToggleGroupItem value="board" aria-label="Board view">
            <Kanban className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List view">
            <List className="h-4 w-4" />
          </ToggleGroupItem>
        </ToggleGroup>
        <Button variant="outline" size="sm" onClick={onResumeOpen}>
          <GitBranch className="h-4 w-4 mr-2" />
          Resume branch
        </Button>
        <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace} />
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
            <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace}>
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
      {resumeDialog}
    </div>
  );
}

export default function WorkspacesListPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [resumeOpen, setResumeOpen] = useState(false);

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });
  const { handleCreate, isCreating, existingNames } = useCreateWorkspace(project?.id, slug);
  const utils = trpc.useUtils();
  const resumeWorkspace = trpc.workspace.create.useMutation();
  const { data: branchData, isLoading: branchesLoading } = trpc.project.listBranches.useQuery(
    { projectId: project?.id ?? '' },
    { enabled: resumeOpen && !!project?.id }
  );

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

  const branches = branchData?.branches ?? [];

  const handleResumeBranch = async (branch: (typeof branches)[number]) => {
    if (!project?.id || resumeWorkspace.isPending) {
      return;
    }

    const workspaceName = makeUniqueWorkspaceName(branch.displayName, existingNames);

    try {
      const workspace = await resumeWorkspace.mutateAsync({
        projectId: project.id,
        name: workspaceName,
        branchName: branch.name,
        useExistingBranch: true,
      });

      rememberResumeWorkspace(workspace.id);
      utils.workspace.list.invalidate({ projectId: project.id });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: project.id });
      setResumeOpen(false);
      navigate(`/projects/${slug}/workspaces/${workspace.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to resume branch: ${message}`);
    }
  };

  const resumeDialog = (
    <ResumeBranchDialog
      open={resumeOpen}
      onOpenChange={setResumeOpen}
      branches={branches}
      isLoading={branchesLoading}
      isSubmitting={resumeWorkspace.isPending}
      onSelectBranch={handleResumeBranch}
    />
  );

  if (viewMode === 'board') {
    return (
      <WorkspacesBoardView
        projectId={project.id}
        slug={slug}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onResumeOpen={() => setResumeOpen(true)}
        onCreateWorkspace={handleCreate}
        isCreatingWorkspace={isCreating}
        resumeDialog={resumeDialog}
      />
    );
  }

  return (
    <WorkspacesTableView
      workspaces={workspaces}
      isLoading={isLoading}
      slug={slug}
      statusFilter={statusFilter}
      onStatusFilterChange={setStatusFilter}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      onResumeOpen={() => setResumeOpen(true)}
      onCreateWorkspace={handleCreate}
      isCreatingWorkspace={isCreating}
      resumeDialog={resumeDialog}
    />
  );
}
