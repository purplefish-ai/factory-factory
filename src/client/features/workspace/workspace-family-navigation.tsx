import { ArrowBendUpLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowBendUpLeft';
import { TreeStructureIcon } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Link } from 'react-router';
import { IconButton } from '@/client/components/icon-button';
import { useWorkspaceDetailQuery } from '@/client/hooks/use-workspace-detail-query';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { KanbanColumn, WorkspaceStatus } from '@/shared/core';
import type { WorkspaceParent } from '@/shared/workspace-summary';

type FamilyWorkspace = {
  id: string;
  name: string;
  projectId: string;
  status: WorkspaceStatus;
  kanbanColumn: KanbanColumn | null;
  parentWorkspace?: WorkspaceParent | null;
  childWorkspaceCount?: number;
};

export function WorkspaceParentLink({
  parent,
  projectId,
  breadcrumb = false,
}: {
  parent: WorkspaceParent;
  projectId: string;
  breadcrumb?: boolean;
}) {
  return (
    <Link
      to={`/projects/${parent.projectSlug}/workspaces/${parent.id}`}
      aria-label={`Parent workspace: ${parent.name}`}
      title={`${parent.projectName} / ${parent.name}`}
      className={cn(
        'pointer-events-auto relative z-10 inline-flex min-w-0 items-center gap-1 text-info hover:underline focus-visible:underline',
        breadcrumb ? 'max-w-[25%] text-2xs md:text-xs' : 'max-w-full text-2xs'
      )}
    >
      <ArrowBendUpLeftIcon className="h-3 w-3 shrink-0" aria-hidden />
      <span className={cn('truncate', breadcrumb && 'hidden md:inline')}>
        {!breadcrumb && 'From: '}
        {parent.projectId !== projectId && `${parent.projectName} / `}
        {parent.name}
      </span>
    </Link>
  );
}

function familyStatus(workspace: Pick<FamilyWorkspace, 'status' | 'kanbanColumn'>) {
  if (workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING') {
    return 'Archived';
  }
  if (!workspace.kanbanColumn) {
    return 'Unavailable';
  }
  return { WORKING: 'Working', WAITING: 'Waiting', DONE: 'Done' }[workspace.kanbanColumn];
}

function FamilyMember({
  workspace,
  projectSlug,
  projectName,
  currentId,
  parent = false,
}: {
  workspace: Pick<FamilyWorkspace, 'id' | 'name' | 'status' | 'kanbanColumn'>;
  projectSlug: string;
  projectName?: string;
  currentId: string;
  parent?: boolean;
}) {
  return (
    <DropdownMenuItem asChild>
      <Link
        to={`/projects/${projectSlug}/workspaces/${workspace.id}`}
        aria-current={workspace.id === currentId ? 'page' : undefined}
        className="flex min-w-0 gap-2"
      >
        <TreeStructureIcon
          className={cn('h-3.5 w-3.5 shrink-0 text-info', !parent && 'ml-3')}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {workspace.name}
            {workspace.id === currentId && <span className="sr-only"> (current workspace)</span>}
          </span>
          <span className="block truncate text-2xs text-muted-foreground">
            {parent ? 'Parent workspace' : 'Child workspace'}
            {projectName && ` · ${projectName}`}
          </span>
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">{familyStatus(workspace)}</span>
      </Link>
    </DropdownMenuItem>
  );
}

function FamilyLoading({ label }: { label: string }) {
  return (
    <p
      className="inline-flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
      role="status"
    >
      <Spinner className="size-3" aria-hidden="true" />
      {label}
    </p>
  );
}

/** A menu row that retries a failed family query without closing the menu. */
function FamilyRetryItem({ label, query }: { label: string; query: { refetch: () => unknown } }) {
  return (
    <DropdownMenuItem
      className="text-xs"
      onSelect={(event) => {
        event.preventDefault();
        void query.refetch();
      }}
    >
      <WarningCircleIcon className="size-3.5 text-destructive" aria-hidden="true" />
      {label}. Retry
    </DropdownMenuItem>
  );
}

function FamilyChildren({
  workspace,
  projectSlug,
  rootId,
}: {
  workspace: FamilyWorkspace;
  projectSlug: string;
  rootId: string;
}) {
  const children = trpc.workspace.listChildren.useQuery(
    { parentWorkspaceId: rootId },
    { refetchInterval: POLL_INTERVAL_MS.workspaceContext }
  );
  // The list polls, so a failed poll keeps the children already shown.
  if (!children.data) {
    return children.error ? (
      <FamilyRetryItem label="Couldn't load children" query={children} />
    ) : (
      <FamilyLoading label="Loading children…" />
    );
  }
  const includeCurrent =
    workspace.parentWorkspace && !children.data.some((child) => child.id === workspace.id);
  return (
    <>
      {children.error ? (
        <FamilyRetryItem label="Couldn't refresh children" query={children} />
      ) : null}
      {children.data.map((child) => (
        <FamilyMember
          key={child.id}
          workspace={child}
          projectSlug={child.projectSlug}
          projectName={child.projectName}
          currentId={workspace.id}
        />
      ))}
      {includeCurrent && (
        <FamilyMember workspace={workspace} projectSlug={projectSlug} currentId={workspace.id} />
      )}
      {!(children.data.length || workspace.parentWorkspace) && (
        <p className="px-2 py-1 text-xs text-muted-foreground">No active children</p>
      )}
    </>
  );
}

function FamilyMenuContent({
  workspace,
  projectSlug,
}: {
  workspace: FamilyWorkspace;
  projectSlug: string;
}) {
  const parent = workspace.parentWorkspace;
  const rootId = parent?.id ?? workspace.id;
  // A parent in another project has no live stream, so the menu keeps polling it.
  const root = useWorkspaceDetailQuery(rootId, {
    enabled: Boolean(parent),
    refetchInterval: POLL_INTERVAL_MS.workspaceContext,
    staleTime: 5000,
  });
  const rootWorkspace = parent ? root.data : workspace;
  return (
    <>
      <DropdownMenuLabel>Workspace family</DropdownMenuLabel>
      {rootWorkspace && (
        <FamilyMember
          workspace={rootWorkspace}
          projectSlug={parent?.projectSlug ?? projectSlug}
          projectName={parent?.projectName}
          currentId={workspace.id}
          parent
        />
      )}
      {parent && !root.data && !root.error && <FamilyLoading label="Loading parent…" />}
      {parent && root.error && (
        <FamilyRetryItem
          label={root.data ? "Couldn't refresh parent" : "Couldn't load parent"}
          query={root}
        />
      )}
      <DropdownMenuSeparator />
      <FamilyChildren workspace={workspace} projectSlug={projectSlug} rootId={rootId} />
    </>
  );
}

export function WorkspaceFamilyMenu({
  workspace,
  projectSlug,
  compact = false,
  iconOnly = false,
}: {
  workspace: FamilyWorkspace;
  projectSlug: string;
  compact?: boolean;
  iconOnly?: boolean;
}) {
  if (!(workspace.parentWorkspace || workspace.childWorkspaceCount)) {
    return null;
  }
  const label = workspace.parentWorkspace
    ? 'Family'
    : `${workspace.childWorkspaceCount} ${workspace.childWorkspaceCount === 1 ? 'child' : 'children'}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {iconOnly ? (
          <IconButton
            label="Navigate workspace family"
            tooltip="Navigate parent and child workspaces"
            size="icon-sm"
            className="pointer-events-auto relative z-10 shrink-0 text-info"
          >
            <TreeStructureIcon aria-hidden />
          </IconButton>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            aria-label="Navigate workspace family"
            title="Navigate parent and child workspaces"
            className={cn(
              'pointer-events-auto relative z-10 shrink-0 px-1.5 text-info',
              compact && 'text-[11px]'
            )}
          >
            <TreeStructureIcon aria-hidden />
            {label}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[min(24rem,calc(100vw-2rem))] max-h-80 overflow-y-auto"
      >
        <FamilyMenuContent workspace={workspace} projectSlug={projectSlug} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
