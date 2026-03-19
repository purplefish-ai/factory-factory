import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import {
  HeaderLeftStartSlot,
  HeaderRightSlot,
  useAppHeader,
} from '@/client/components/app-header-context';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { WorkspaceItemContent } from '@/client/components/workspace-item-content';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const BOARD_COLUMNS = [
  { id: 'WORKING', label: 'Working' },
  { id: 'WAITING', label: 'Waiting' },
  { id: 'DONE', label: 'Done' },
] as const;

type ColumnId = (typeof BOARD_COLUMNS)[number]['id'];

interface ProjectWorkspace extends ServerWorkspace {
  projectSlug: string;
  projectName: string;
}

function AllProjectsBoardHeaderSlot({
  selectedProjectSlug,
  onProjectChange,
  projects,
  onRefresh,
  isRefreshing,
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  useAppHeader({ title: '' });

  return (
    <>
      <HeaderLeftStartSlot>
        <ProjectSelectorDropdown
          selectedProjectSlug={selectedProjectSlug}
          onProjectChange={onProjectChange}
          projects={projects}
          showLeadingSlash
          triggerId="header-project-select"
        />
      </HeaderLeftStartSlot>
      <HeaderRightSlot>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={onRefresh}
              disabled={isRefreshing}
              aria-label="Refresh workspaces"
            >
              <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh workspaces</TooltipContent>
        </Tooltip>
      </HeaderRightSlot>
    </>
  );
}

function WorkspaceCard({ workspace }: { workspace: ProjectWorkspace }) {
  return (
    <Link
      to={`/projects/${workspace.projectSlug}/workspaces/${workspace.id}`}
      className="block rounded-lg border bg-card text-card-foreground shadow-sm hover:shadow-md transition-shadow p-3"
    >
      <div className="flex items-start gap-2 mb-1.5">
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0 font-normal">
          {workspace.projectName}
        </Badge>
      </div>
      <WorkspaceItemContent
        workspace={workspace}
        onOpenPr={() => {
          if (workspace.prUrl) {
            window.open(workspace.prUrl, '_blank', 'noopener,noreferrer');
          }
        }}
        onOpenIssue={() => {
          const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
          if (issueUrl) {
            window.open(issueUrl, '_blank', 'noopener,noreferrer');
          }
        }}
      />
    </Link>
  );
}

function BoardColumn({ label, workspaces }: { label: string; workspaces: ProjectWorkspace[] }) {
  return (
    <div className="flex flex-col w-full md:flex-1 md:min-w-[280px] md:max-w-[440px] md:h-full">
      <div className="flex items-center justify-between px-2 py-3 bg-muted/50 rounded-t-lg">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{label}</h3>
          <Badge variant="secondary" className="h-5 min-w-5 justify-center text-xs">
            {workspaces.length}
          </Badge>
        </div>
      </div>
      <div className="flex flex-col gap-3 flex-1 overflow-y-auto p-3 min-h-0 rounded-lg rounded-t-none bg-muted/50">
        {workspaces.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No workspaces</p>
        ) : (
          workspaces.map((ws) => <WorkspaceCard key={ws.id} workspace={ws} />)
        )}
      </div>
    </div>
  );
}

export function AllProjectsBoardView({
  selectedProjectSlug,
  onProjectChange,
  projects,
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
}) {
  const {
    data: allProjectsState,
    isLoading,
    refetch,
    isFetching,
  } = trpc.workspace.getAllProjectsSummaryState.useQuery(
    {},
    { staleTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false }
  );

  const workspacesByColumn = useMemo<Record<ColumnId, ProjectWorkspace[]>>(() => {
    const result: Record<ColumnId, ProjectWorkspace[]> = {
      WORKING: [],
      WAITING: [],
      DONE: [],
    };

    if (!allProjectsState) {
      return result;
    }

    for (const { project, workspaces } of allProjectsState) {
      for (const workspace of workspaces) {
        const col = workspace.cachedKanbanColumn as ColumnId | null | undefined;
        if (col && col in result) {
          result[col].push({ ...workspace, projectSlug: project.slug, projectName: project.name });
        }
      }
    }

    // Sort newest first within each column
    for (const col of Object.values(result)) {
      col.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    return result;
  }, [allProjectsState]);

  if (isLoading) {
    return (
      <>
        <AllProjectsBoardHeaderSlot
          selectedProjectSlug={selectedProjectSlug}
          onProjectChange={onProjectChange}
          projects={projects}
          onRefresh={() => refetch()}
          isRefreshing={isFetching}
        />
        <div className="flex flex-row gap-4 pb-4 h-full overflow-y-hidden overflow-x-auto mx-auto w-full max-w-[1800px] p-3 md:p-6">
          {BOARD_COLUMNS.map((col) => (
            <div
              key={col.id}
              className="flex flex-col w-full md:flex-1 md:min-w-[280px] md:max-w-[440px] md:h-full"
            >
              <Skeleton className="h-10 w-full rounded-t-lg rounded-b-none" />
              <Skeleton className="flex-1 w-full rounded-b-lg rounded-t-none" />
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <AllProjectsBoardHeaderSlot
        selectedProjectSlug={selectedProjectSlug}
        onProjectChange={onProjectChange}
        projects={projects}
        onRefresh={() => refetch()}
        isRefreshing={isFetching}
      />
      <div className="flex flex-col h-full p-3 md:p-6 gap-3 md:gap-4">
        <div className="flex-1 min-h-0">
          <div className="flex flex-row gap-4 pb-4 h-full overflow-y-hidden overflow-x-auto mx-auto w-full max-w-[1800px]">
            {BOARD_COLUMNS.map((col) => (
              <BoardColumn key={col.id} label={col.label} workspaces={workspacesByColumn[col.id]} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
