import { CaretUpDownIcon } from '@phosphor-icons/react/dist/csr/CaretUpDown';
import { memo, useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { WorkspaceItemContent } from '@/client/components/workspace-item-content';
import { useProjectWorkspaceQuery } from '@/client/hooks/use-project-workspace-query';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select';
import { groupWorkspaceSwitcherItems } from './utils';

const workspaceDropdownItemClassName =
  'h-auto items-start py-1.5 data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground [&>span:first-child]:hidden [&>span:last-child]:block [&>span:last-child]:w-full';

function openWorkspacePr(workspace: ServerWorkspace) {
  const prUrl = workspace.prUrl;
  if (!prUrl) {
    return;
  }
  window.open(prUrl, '_blank', 'noopener,noreferrer');
}

function openWorkspaceIssue(workspace: ServerWorkspace) {
  const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
  if (!issueUrl) {
    return;
  }
  window.open(issueUrl, '_blank', 'noopener,noreferrer');
}

// Radix renders closed Select items to collect their text, so every workspace
// item renders whenever the header does. Memoize so one changed workspace only
// re-renders its own item.
const WorkspaceSwitcherItem = memo(function WorkspaceSwitcherItem({
  workspace,
}: {
  workspace: ServerWorkspace;
}) {
  return (
    <SelectItem value={workspace.id} className={workspaceDropdownItemClassName}>
      <WorkspaceItemContent
        workspace={workspace}
        onOpenPr={() => openWorkspacePr(workspace)}
        onOpenIssue={() => openWorkspaceIssue(workspace)}
      />
    </SelectItem>
  );
});

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
  const navigate = useNavigate();
  const { data: projectState } = useProjectWorkspaceQuery(projectId);

  const grouped = useMemo(
    () => groupWorkspaceSwitcherItems((projectState?.workspaces ?? []) as ServerWorkspace[]),
    [projectState?.workspaces]
  );
  const queueSummaryLabel = `${grouped.working.length} working · ${grouped.waiting.length} waiting`;

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
        title={currentWorkspaceName}
        aria-label={`Open workspace menu (${queueSummaryLabel})`}
        className="h-7 min-w-0 w-auto max-w-[10rem] border-0 bg-transparent px-0.5 text-[11px] font-normal text-muted-foreground shadow-none focus:ring-0 hover:[&>.workspace-switcher-label]:underline focus-visible:[&>.workspace-switcher-label]:underline md:max-w-[24rem] md:px-1 md:text-sm [&>svg:last-of-type]:hidden"
      >
        <span className="workspace-switcher-label flex-1 min-w-0 truncate text-foreground font-semibold">
          {currentWorkspaceLabel}
        </span>
        <span className="shrink-0" aria-hidden>
          <span className="ml-1 hidden text-[10px] font-normal text-muted-foreground tabular-nums @[72rem]/header:block">
            {grouped.working.length} wk · {grouped.waiting.length} wait
          </span>
        </span>
        <span className="ml-0.5 inline-flex shrink-0 items-center text-current md:ml-2" aria-hidden>
          <CaretUpDownIcon className="h-3 w-3 shrink-0 opacity-70 md:h-3.5 md:w-3.5" />
        </span>
      </SelectTrigger>
      <SelectContent className="w-[min(95vw,34rem)]">
        <SelectItem value={currentWorkspaceId} className="hidden" aria-hidden>
          {currentWorkspaceName}
        </SelectItem>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Working · {grouped.working.length}
          </SelectLabel>
          {grouped.working.map((workspace) => (
            <WorkspaceSwitcherItem key={`working-${workspace.id}`} workspace={workspace} />
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Waiting · {grouped.waiting.length}
          </SelectLabel>
          {grouped.waiting.map((workspace) => (
            <WorkspaceSwitcherItem key={`waiting-${workspace.id}`} workspace={workspace} />
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Done · {grouped.done.length}
          </SelectLabel>
          {grouped.done.map((workspace) => (
            <WorkspaceSwitcherItem key={`done-${workspace.id}`} workspace={workspace} />
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
