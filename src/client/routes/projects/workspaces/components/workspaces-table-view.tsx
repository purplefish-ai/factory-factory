import type { Workspace } from '@prisma-gen/browser';
import { GitBranch } from 'lucide-react';
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
import { PendingRequestBadge } from '@/frontend/components/pending-request-badge';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatStatusLabel } from '@/lib/formatters';
import type { CIStatus, WorkspaceStatus } from '@/shared/core';
import { NewWorkspaceButton } from './new-workspace-button';
import { ResumeBranchButton } from './resume-branch-button';
import type { ViewMode } from './types';
import { ViewModeToggle } from './view-mode-toggle';

const workspaceStatuses: WorkspaceStatus[] = ['NEW', 'PROVISIONING', 'READY', 'FAILED', 'ARCHIVED'];

type WorkspaceWithSessions = Workspace & {
  agentSessions?: unknown[];
  isWorking?: boolean;
  pendingRequestType?: 'plan_approval' | 'user_question' | 'permission_request' | null;
};

function MobileWorkspaceCard({
  workspace,
  slug,
}: {
  workspace: WorkspaceWithSessions;
  slug: string;
}) {
  return (
    <Link to={`/projects/${slug}/workspaces/${workspace.id}`} className="block">
      <Card className="p-3 hover:border-primary/50 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm truncate">{workspace.name}</span>
              <CIFailureWarning
                ciStatus={workspace.prCiStatus as CIStatus}
                prUrl={workspace.prUrl}
                size="sm"
              />
            </div>
            {workspace.branchName && (
              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground font-mono truncate">
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="truncate">{workspace.branchName}</span>
              </div>
            )}
            {workspace.pendingRequestType && (
              <div className="mt-1">
                <PendingRequestBadge type={workspace.pendingRequestType} size="xs" />
              </div>
            )}
          </div>
          <WorkspaceStatusBadge
            status={workspace.status}
            errorMessage={workspace.initErrorMessage}
          />
        </div>
      </Card>
    </Link>
  );
}

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
  const isMobile = useIsMobile();

  return (
    <div className="space-y-4 p-3 md:p-6">
      <PageHeader title="Workspaces">
        <Select value={statusFilter} onValueChange={onStatusFilterChange}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {workspaceStatuses.map((status) => (
              <SelectItem key={status} value={status}>
                {formatStatusLabel(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
        <ResumeBranchButton onClick={onResumeOpen} />
        <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace} />
      </PageHeader>

      {isLoading ? (
        <Card>
          <Loading message="Loading workspaces..." />
        </Card>
      ) : !workspaces || workspaces.length === 0 ? (
        <Card>
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyTitle>No workspaces found</EmptyTitle>
              <EmptyDescription>Get started by creating your first workspace.</EmptyDescription>
            </EmptyHeader>
            <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace}>
              Create your first workspace
            </NewWorkspaceButton>
          </Empty>
        </Card>
      ) : isMobile ? (
        <div className="flex flex-col gap-2">
          {workspaces.map((workspace: WorkspaceWithSessions) => (
            <MobileWorkspaceCard key={workspace.id} workspace={workspace} slug={slug} />
          ))}
        </div>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Awaiting You</TableHead>
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
                    {workspace.agentSessions?.length ?? 0} sessions
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">
                    {workspace.branchName || '-'}
                  </TableCell>
                  <TableCell>
                    {workspace.pendingRequestType ? (
                      <PendingRequestBadge type={workspace.pendingRequestType} size="xs" />
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
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
        </Card>
      )}
      {resumeDialog}
    </div>
  );
}
