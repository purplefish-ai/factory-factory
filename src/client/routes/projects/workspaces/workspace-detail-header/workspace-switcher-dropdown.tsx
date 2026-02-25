import { ChevronsUpDown } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { WorkspaceItemContent } from '@/client/components/workspace-item-content';
import { trpc } from '@/client/lib/trpc';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select';
import { groupWorkspaceSwitcherItems } from './utils';

export function WorkspaceSwitcherDropdown({
  projectSlug,
  projectId,
  currentWorkspaceId,
  currentWorkspaceLabel,
  currentWorkspaceName,
}: {
  projectSlug: string;
  projectId: string;
  currentWorkspaceId: string;
  currentWorkspaceLabel: string;
  currentWorkspaceName: string;
}) {
  const workspaceDropdownItemClassName =
    'h-auto items-start py-1.5 data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground [&>span:first-child]:hidden [&>span:last-child]:block [&>span:last-child]:w-full';

  const navigate = useNavigate();
  const { data: projectState } = trpc.workspace.getProjectSummaryState.useQuery(
    { projectId },
    {
      enabled: Boolean(projectId),
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
    }
  );

  const grouped = useMemo(
    () => groupWorkspaceSwitcherItems((projectState?.workspaces ?? []) as ServerWorkspace[]),
    [projectState?.workspaces]
  );

  const handleValueChange = (workspaceId: string) => {
    if (!workspaceId || workspaceId === currentWorkspaceId) {
      return;
    }
    void navigate(`/projects/${projectSlug}/workspaces/${workspaceId}`);
  };

  return (
    <Select value={currentWorkspaceId} onValueChange={handleValueChange}>
      <SelectTrigger
        id="workspace-detail-workspace-select"
        aria-label="Open workspace menu"
        className="h-7 w-auto max-w-[10rem] border-0 bg-transparent px-0.5 text-[11px] font-normal text-muted-foreground shadow-none focus:ring-0 hover:[&>span]:underline focus-visible:[&>span]:underline md:max-w-[18rem] md:px-1 md:text-sm lg:max-w-none [&>svg:last-of-type]:hidden"
      >
        <span className="flex-1 min-w-0 truncate text-foreground font-semibold md:overflow-visible md:text-clip">
          {currentWorkspaceLabel}
        </span>
        <span className="ml-0.5 inline-flex shrink-0 items-center text-current md:ml-2" aria-hidden>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-70 md:h-3.5 md:w-3.5" />
        </span>
      </SelectTrigger>
      <SelectContent className="w-[min(95vw,34rem)]">
        <SelectItem value={currentWorkspaceId} className="hidden" aria-hidden>
          {currentWorkspaceName}
        </SelectItem>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Waiting · {grouped.waiting.length}
          </SelectLabel>
          {grouped.waiting.map((workspace) => (
            <SelectItem
              key={`waiting-${workspace.id}`}
              value={workspace.id}
              className={workspaceDropdownItemClassName}
            >
              <WorkspaceItemContent
                workspace={workspace}
                onOpenPr={() => {
                  const prUrl = workspace.prUrl;
                  if (!prUrl) {
                    return;
                  }
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
                onOpenIssue={() => {
                  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
                  if (!issueUrl) {
                    return;
                  }
                  window.open(issueUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Working · {grouped.working.length}
          </SelectLabel>
          {grouped.working.map((workspace) => (
            <SelectItem
              key={`working-${workspace.id}`}
              value={workspace.id}
              className={workspaceDropdownItemClassName}
            >
              <WorkspaceItemContent
                workspace={workspace}
                onOpenPr={() => {
                  const prUrl = workspace.prUrl;
                  if (!prUrl) {
                    return;
                  }
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
                onOpenIssue={() => {
                  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
                  if (!issueUrl) {
                    return;
                  }
                  window.open(issueUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Todo · {grouped.todo.length}
          </SelectLabel>
          {grouped.todo.map((workspace) => (
            <SelectItem
              key={`todo-${workspace.id}`}
              value={workspace.id}
              className={workspaceDropdownItemClassName}
            >
              <WorkspaceItemContent
                workspace={workspace}
                onOpenPr={() => {
                  const prUrl = workspace.prUrl;
                  if (!prUrl) {
                    return;
                  }
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
                onOpenIssue={() => {
                  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
                  if (!issueUrl) {
                    return;
                  }
                  window.open(issueUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Done · {grouped.done.length}
          </SelectLabel>
          {grouped.done.map((workspace) => (
            <SelectItem
              key={`done-${workspace.id}`}
              value={workspace.id}
              className={workspaceDropdownItemClassName}
            >
              <WorkspaceItemContent
                workspace={workspace}
                onOpenPr={() => {
                  const prUrl = workspace.prUrl;
                  if (!prUrl) {
                    return;
                  }
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
                onOpenIssue={() => {
                  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
                  if (!issueUrl) {
                    return;
                  }
                  window.open(issueUrl, '_blank', 'noopener,noreferrer');
                }}
              />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
