import { Github } from 'lucide-react';
import { trpc } from '@/client/lib/trpc';
import { encodeGitHubTreeRef } from '@/client/routes/projects/workspaces/github-branch-url';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
          <Github className="h-4 w-4" />
          Open branch on GitHub
        </a>
      </DropdownMenuItem>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <a
            href={branchUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open branch on GitHub"
          >
            <Github className="h-4 w-4" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open branch on GitHub</TooltipContent>
    </Tooltip>
  );
}
