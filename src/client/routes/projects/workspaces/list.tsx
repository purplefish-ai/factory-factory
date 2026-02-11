import type { WorkspaceStatus } from '@prisma-gen/browser';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Loading } from '@/frontend/components/loading';
import { useCreateWorkspace } from '@/frontend/hooks/use-create-workspace';
import { trpc } from '@/frontend/lib/trpc';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';
import {
  ResumeBranchDialog,
  type ViewMode,
  WorkspacesBoardView,
  WorkspacesTableView,
} from './components';
import { rememberResumeWorkspace } from './resume-workspace-storage';

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

export default function WorkspacesListPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [resumeOpen, setResumeOpen] = useState(false);

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });
  const {
    handleCreate: createWorkspace,
    isCreating,
    existingNames,
  } = useCreateWorkspace(project?.id, slug);

  // Swallow the re-thrown error — toast is already shown by the hook
  const handleCreate = () => {
    createWorkspace().catch(() => {
      // Error already handled (toast shown) by the hook
    });
  };
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
    { enabled: !!project?.id && viewMode === 'list', refetchInterval: 60_000, staleTime: 50_000 }
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
        type: 'RESUME_BRANCH',
        projectId: project.id,
        branchName: branch.name,
        name: workspaceName,
      });

      rememberResumeWorkspace(workspace.id);
      utils.workspace.list.invalidate({ projectId: project.id });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: project.id });
      setResumeOpen(false);
      await navigate(`/projects/${slug}/workspaces/${workspace.id}`);
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
