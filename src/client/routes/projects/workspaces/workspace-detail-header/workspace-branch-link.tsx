import { GithubLogoIcon } from '@phosphor-icons/react/dist/csr/GithubLogo';
import { IconButton } from '@/client/components/icon-button';
import { trpc } from '@/client/lib/trpc';
import { encodeGitHubTreeRef } from '@/client/routes/projects/workspaces/github-branch-url';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { WorkspaceHeaderWorkspace } from './types';

export function WorkspaceBranchLink({
  workspace,
  renderAsMenuItem = false,
}: {
  workspace: WorkspaceHeaderWorkspace;
  renderAsMenuItem?: boolean;
}) {
  const { data: project } = trpc.project.getById.useQuery(
    { id: workspace.projectId },
    { enabled: Boolean(workspace.branchName) }
  );

  const branchUrl =
    workspace.branchName && project?.githubOwner && project?.githubRepo
      ? `https://github.com/${project.githubOwner}/${project.githubRepo}/tree/${encodeGitHubTreeRef(workspace.branchName)}`
      : null;

  if (!branchUrl) {
    return null;
  }

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem asChild>
        <a href={branchUrl} target="_blank" rel="noopener noreferrer">
          <GithubLogoIcon className="h-4 w-4" />
          Open branch on GitHub
        </a>
      </DropdownMenuItem>
    );
  }

  return (
    <IconButton asChild label="Open branch on GitHub" size="icon-sm">
      <a href={branchUrl} target="_blank" rel="noopener noreferrer">
        <GithubLogoIcon />
      </a>
    </IconButton>
  );
}
