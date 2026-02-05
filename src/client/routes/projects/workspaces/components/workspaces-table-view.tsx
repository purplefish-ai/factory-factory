import type { CIStatus, Workspace, WorkspaceStatus } from '@prisma-gen/browser';
import { Link } from 'react-router';
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
import { WorkspaceStatusBadge } from '@/components/workspace/workspace-status-badge';
import { CIFailureWarning } from '@/frontend/components/ci-failure-warning';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { NewWorkspaceButton } from './new-workspace-button';
import { ResumeBranchButton } from './resume-branch-button';
import type { ViewMode } from './types';
import { ViewModeToggle } from './view-mode-toggle';

const workspaceStatuses: WorkspaceStatus[] = ['NEW', 'PROVISIONING', 'READY', 'FAILED', 'ARCHIVED'];

type WorkspaceWithSessions = Workspace & {
  claudeSessions?: unknown[];
};

export function WorkspacesTableView({
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
        <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
        <ResumeBranchButton onClick={onResumeOpen} />
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
