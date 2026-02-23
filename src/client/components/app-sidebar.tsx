import {
  CircleDot,
  GitBranch,
  GitPullRequest,
  Kanban,
  Loader2,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import type { useAppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { useCreateWorkspace } from '@/client/hooks/use-create-workspace';
import { useSidebarIssues } from '@/client/hooks/use-sidebar-issues';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import { PendingRequestBadge } from './pending-request-badge';
import { ThemeToggle } from './theme-toggle';
import { WorkspaceStatusIcon } from './workspace-status-icon';

type NavigationData = ReturnType<typeof useAppNavigationData>;

// =============================================================================
// Workspace item component
// =============================================================================

function SidebarWorkspaceItem({
  workspace,
  projectSlug,
  isActive,
}: {
  workspace: ServerWorkspace;
  projectSlug: string;
  isActive: boolean;
}) {
  const showBranch = Boolean(workspace.branchName);
  const showPR =
    workspace.prState !== 'NONE' &&
    workspace.prState != null &&
    workspace.prNumber != null &&
    workspace.prUrl != null;
  const showStats =
    workspace.gitStats && (workspace.gitStats.additions > 0 || workspace.gitStats.deletions > 0);
  const hasMetaRow = showBranch || showPR || showStats;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        className={cn(
          'h-auto py-1.5 px-2',
          workspace.pendingRequestType && 'border-amber-500/30 bg-amber-500/5'
        )}
      >
        <Link to={`/projects/${projectSlug}/workspaces/${workspace.id}`}>
          <div className="flex flex-col gap-0.5 min-w-0 w-full">
            {/* Top row: status icon + name */}
            <div className="flex items-center gap-2 min-w-0">
              <WorkspaceStatusIcon
                pendingRequestType={workspace.pendingRequestType}
                isWorking={workspace.isWorking}
              />
              <span className="truncate text-sm">{workspace.name}</span>
            </div>

            {/* Meta row: branch, LOC diff, PR link — grid for column alignment */}
            {hasMetaRow && (
              <div className="grid grid-cols-[1fr_auto_3rem] items-center gap-x-2 pl-[calc(0.5rem+8px)] text-[11px] text-muted-foreground min-w-0">
                <span className="flex items-center gap-1 min-w-0 truncate">
                  {showBranch && (
                    <>
                      <GitBranch className="h-2.5 w-2.5 shrink-0" />
                      <span className="font-mono truncate">{workspace.branchName}</span>
                    </>
                  )}
                </span>
                <span className="flex items-center gap-1 shrink-0 justify-end">
                  {showStats && workspace.gitStats && (
                    <>
                      <span className="text-green-600">+{workspace.gitStats.additions}</span>
                      <span className="text-red-600">-{workspace.gitStats.deletions}</span>
                    </>
                  )}
                </span>
                <span className="shrink-0 justify-self-end">
                  {showPR && (
                    <button
                      type="button"
                      className="flex items-center gap-0.5 hover:text-foreground"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(workspace.prUrl as string, '_blank', 'noopener,noreferrer');
                      }}
                    >
                      <GitPullRequest className="h-2.5 w-2.5" />
                      <span>#{workspace.prNumber}</span>
                    </button>
                  )}
                </span>
              </div>
            )}

            {/* Pending request badge */}
            {workspace.pendingRequestType && (
              <div className="pl-[calc(0.5rem+8px)]">
                <PendingRequestBadge type={workspace.pendingRequestType} size="xs" />
              </div>
            )}
          </div>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// =============================================================================
// Issue item component
// =============================================================================

function SidebarIssueItem({ issue }: { issue: NormalizedIssue }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild className="h-auto py-1.5 px-2">
        <a href={issue.url} target="_blank" rel="noopener noreferrer">
          <div className="flex items-center gap-2 min-w-0">
            <CircleDot className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm">{issue.title}</span>
            <span className="text-xs font-medium text-muted-foreground shrink-0 ml-auto">
              {issue.displayId}
            </span>
          </div>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// =============================================================================
// Sidebar groups
// =============================================================================

function EmptyPlaceholder({ text }: { text: string }) {
  return <p className="px-4 py-1.5 text-xs text-muted-foreground/50">{text}</p>;
}

function WorkspaceGroup({
  label,
  workspaces,
  projectSlug,
  currentWorkspaceId,
  emptyText,
}: {
  label: string;
  workspaces: ServerWorkspace[];
  projectSlug: string;
  currentWorkspaceId: string | undefined;
  emptyText: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        {workspaces.length === 0 ? (
          <EmptyPlaceholder text={emptyText} />
        ) : (
          <SidebarMenu>
            {workspaces.map((ws) => (
              <SidebarWorkspaceItem
                key={ws.id}
                workspace={ws}
                projectSlug={projectSlug}
                isActive={ws.id === currentWorkspaceId}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function IssueGroup({ issues }: { issues: NormalizedIssue[] | undefined }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Todo</SidebarGroupLabel>
      <SidebarGroupContent>
        {!issues || issues.length === 0 ? (
          <EmptyPlaceholder text="No issues" />
        ) : (
          <SidebarMenu>
            {issues.map((issue) => (
              <SidebarIssueItem key={issue.id} issue={issue} />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// =============================================================================
// Sidebar content (shared between desktop and mobile)
// =============================================================================

function SidebarInner({
  navData,
  issues,
  waiting,
  working,
  done,
  onCreateWorkspace,
  canCreateWorkspace,
  isCreatingWorkspace,
  onNavigate,
  showCloseButton,
}: {
  navData: NavigationData;
  issues: NormalizedIssue[] | undefined;
  waiting: ServerWorkspace[];
  working: ServerWorkspace[];
  done: ServerWorkspace[];
  onCreateWorkspace: () => void;
  canCreateWorkspace: boolean;
  isCreatingWorkspace: boolean;
  onNavigate?: () => void;
  showCloseButton: boolean;
}) {
  const { pathname } = useLocation();

  return (
    <>
      {showCloseButton && (
        <header className="flex shrink-0 items-center justify-between border-b px-4 min-h-12 pt-[env(safe-area-inset-top)]">
          <span className="text-sm font-semibold">Workspaces</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            aria-label="Close sidebar"
            onClick={onNavigate}
          >
            <X className="h-5 w-5" />
          </Button>
        </header>
      )}

      <SidebarContent className={showCloseButton ? undefined : 'pt-2'}>
        <SidebarGroup className="pb-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={onCreateWorkspace}
                  disabled={!canCreateWorkspace || isCreatingWorkspace}
                  className="h-9"
                >
                  {isCreatingWorkspace ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  <span>{isCreatingWorkspace ? 'Creating workspace...' : 'New Workspace'}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <WorkspaceGroup
          label="Waiting"
          workspaces={waiting}
          projectSlug={navData.selectedProjectSlug}
          currentWorkspaceId={navData.currentWorkspaceId}
          emptyText="No waiting workspaces"
        />
        <WorkspaceGroup
          label="Working"
          workspaces={working}
          projectSlug={navData.selectedProjectSlug}
          currentWorkspaceId={navData.currentWorkspaceId}
          emptyText="No active workspaces"
        />
        <IssueGroup issues={issues} />
        <WorkspaceGroup
          label="Done"
          workspaces={done}
          projectSlug={navData.selectedProjectSlug}
          currentWorkspaceId={navData.currentWorkspaceId}
          emptyText="No completed workspaces"
        />
      </SidebarContent>

      <SidebarSeparator />

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname?.startsWith(`/projects/${navData.selectedProjectSlug}/workspaces`)}
            >
              <Link to={`/projects/${navData.selectedProjectSlug}/workspaces`} onClick={onNavigate}>
                <Kanban className="h-4 w-4" />
                <span>Workspaces</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === '/reviews' || pathname?.startsWith('/reviews/')}
            >
              <Link to="/reviews" onClick={onNavigate}>
                <GitPullRequest className="h-4 w-4" />
                <span>Reviews</span>
                {navData.reviewCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-auto h-5 min-w-5 px-1.5 text-xs bg-orange-500/20 text-orange-600 border-orange-500/30"
                  >
                    {navData.reviewCount}
                  </Badge>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <div className="flex items-center gap-1">
              <SidebarMenuButton
                asChild
                isActive={pathname === '/admin' || pathname?.startsWith('/admin/')}
                className="flex-1"
              >
                <Link to="/admin" onClick={onNavigate}>
                  <Settings className="h-4 w-4" />
                  <span>Admin Dashboard</span>
                </Link>
              </SidebarMenuButton>
              <ThemeToggle />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>

        <div className="pb-2" />

        <SidebarSeparator />

        <div className="flex justify-center px-3 pb-2 pt-1">
          <Logo showIcon={false} textClassName="text-base" />
        </div>
      </SidebarFooter>
    </>
  );
}

// =============================================================================
// Main sidebar component
// =============================================================================

export function AppSidebar({ navData }: { navData: NavigationData }) {
  const { pathname } = useLocation();
  const prevPathnameRef = useRef(pathname);
  const { open, openMobile, setOpenMobile, isMobile } = useSidebar();
  const { handleCreate, isCreating: isCreatingWorkspace } = useCreateWorkspace(
    navData.selectedProjectId,
    navData.selectedProjectSlug,
    navData.serverWorkspaces?.map((workspace) => workspace.name)
  );

  // Auto-close mobile sidebar on route navigation
  useEffect(() => {
    if (pathname !== prevPathnameRef.current) {
      setOpenMobile(false);
    }
    prevPathnameRef.current = pathname;
  }, [pathname, setOpenMobile]);

  // Fetch issues for the Todo section
  const { issues } = useSidebarIssues(
    navData.selectedProjectId,
    navData.issueProvider,
    navData.serverWorkspaces
  );

  // Group workspaces by kanban column, sorted by createdAt descending (newest first)
  const { waiting, working, done } = useMemo(() => {
    const ws = navData.serverWorkspaces ?? [];
    const byNewest = (a: ServerWorkspace, b: ServerWorkspace) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return {
      waiting: ws.filter((w) => w.cachedKanbanColumn === 'WAITING').sort(byNewest),
      working: ws
        .filter(
          (w) =>
            w.cachedKanbanColumn === 'WORKING' || (w.isWorking && w.cachedKanbanColumn !== 'DONE')
        )
        .sort(byNewest),
      done: ws.filter((w) => w.cachedKanbanColumn === 'DONE').sort(byNewest),
    };
  }, [navData.serverWorkspaces]);

  const sharedProps = {
    navData,
    issues,
    waiting,
    working,
    done,
    onCreateWorkspace: handleCreate,
    canCreateWorkspace: Boolean(navData.selectedProjectId && navData.selectedProjectSlug),
    isCreatingWorkspace,
  };

  // Mobile: Sheet overlay
  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side="left"
          className="w-screen max-w-none p-0 bg-sidebar text-sidebar-foreground [&>button]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>App navigation sidebar</SheetDescription>
          </SheetHeader>
          <div className="flex h-full flex-col">
            <SidebarInner
              {...sharedProps}
              showCloseButton
              onNavigate={() => setOpenMobile(false)}
            />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: animated div that pushes content via flex layout
  return (
    <div
      className={cn(
        'shrink-0 overflow-hidden transition-[width] duration-200 ease-linear',
        open ? 'w-[22rem]' : 'w-0'
      )}
    >
      <div className="flex h-full w-[22rem] flex-col border-r bg-sidebar text-sidebar-foreground">
        <SidebarInner {...sharedProps} showCloseButton={false} />
      </div>
    </div>
  );
}
