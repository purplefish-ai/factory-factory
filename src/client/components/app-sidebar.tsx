import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { DotOutlineIcon } from '@phosphor-icons/react/dist/csr/DotOutline';
import { GearIcon } from '@phosphor-icons/react/dist/csr/Gear';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { KanbanIcon } from '@phosphor-icons/react/dist/csr/Kanban';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import {
  lazy,
  memo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Loading } from '@/client/components/loading';
import { ProjectIssuesState } from '@/client/components/project-issues-state';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { ErrorBoundary } from '@/client/error-boundary';
import { WorkspaceCreationImageDropZone } from '@/client/features/kanban/workspace-creation-image-drop-zone';
import {
  getProjectSlugFromPath,
  type useAppNavigationData,
} from '@/client/hooks/use-app-navigation-data';
import { type ProjectIssuesStatus, useProjectIssues } from '@/client/hooks/use-project-issues';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import {
  getProjectSection,
  getProjectSectionPath,
  isProjectBoardPath,
  type ProjectSection,
} from '@/client/lib/project-navigation';
import { getWorkspaceSelectedPR } from '@/client/lib/workspace-selected-pr';
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
import {
  clampSidebarWidth,
  getPersistedSidebarWidth,
  persistSidebarWidth,
} from './app-sidebar-resize';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';
import { WorkspaceItemContent } from './workspace-item-content';
import { groupWorkspacesForSidebar } from './workspace-sidebar-grouping';

type NavigationData = ReturnType<typeof useAppNavigationData>;

// The creation form pulls in launch controls, draft storage and the composer;
// load it on the first "+" click or image drop instead of at startup.
const InlineWorkspaceForm = lazy(() =>
  import('@/client/features/kanban/inline-workspace-form').then((module) => ({
    default: module.InlineWorkspaceForm,
  }))
);

const IssueLaunchSheet = lazy(() =>
  import('@/client/features/kanban/issue-launch-sheet').then((module) => ({
    default: module.IssueLaunchSheet,
  }))
);

// =============================================================================
// Workspace item component
// =============================================================================

// Memoized: a snapshot for one workspace keeps the other rows' objects, so only
// the changed row re-renders.
const SidebarWorkspaceItem = memo(function SidebarWorkspaceItem({
  workspace,
  projectSlug,
  isActive,
  unreadCount,
}: {
  unreadCount?: number;
  workspace: ServerWorkspace;
  projectSlug: string;
  isActive: boolean;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        className={cn(
          'h-auto py-1.5 px-2',
          workspace.pendingRequestType && 'border-warning/30 bg-warning/5'
        )}
      >
        <Link to={`/projects/${projectSlug}/workspaces/${workspace.id}`}>
          <WorkspaceItemContent
            workspace={workspace}
            unreadCount={unreadCount}
            onOpenPr={() => {
              const pr = getWorkspaceSelectedPR(workspace);
              if (pr) {
                window.open(pr.url, '_blank', 'noopener,noreferrer');
              }
            }}
            onOpenIssue={() => {
              const issueUrl = workspace.githubIssueUrl ?? workspace.linearIssueUrl;
              if (!issueUrl) {
                return;
              }
              window.open(issueUrl, '_blank', 'noopener,noreferrer');
            }}
          />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});

// =============================================================================
// Issue item component
// =============================================================================

function SidebarIssueItem({ issue, onLaunch }: { issue: NormalizedIssue; onLaunch: () => void }) {
  return (
    <SidebarMenuItem>
      <div className="flex items-center">
        <SidebarMenuButton
          onClick={onLaunch}
          className="h-auto py-1.5 px-2"
          aria-label={`Start ${issue.title}`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <DotOutlineIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm">{issue.title}</span>
            <span className="text-xs font-medium text-muted-foreground shrink-0 ml-auto">
              {issue.displayId}
            </span>
          </div>
        </SidebarMenuButton>
        <a
          href={issue.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${issue.displayId} externally`}
          className="p-2"
        >
          <ArrowSquareOutIcon className="h-3 w-3" />
        </a>
      </div>
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
  unreadMailCounts,
}: {
  unreadMailCounts?: Record<string, number>;
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
                unreadCount={unreadMailCounts?.[ws.id]}
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

function IssueGroup({
  issues,
  status,
  error,
  projectSlug,
  onRetry,
  isRetrying,
  onLaunch,
}: {
  issues: NormalizedIssue[] | undefined;
  status: ProjectIssuesStatus | undefined;
  error?: string | null;
  projectSlug: string;
  onRetry: () => void;
  isRetrying?: boolean;
  onLaunch: (issue: NormalizedIssue) => void;
}) {
  if (!issues?.length) {
    return null;
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Todo</SidebarGroupLabel>
      <SidebarGroupContent>
        {status === 'error' && (
          <ProjectIssuesState
            status={status}
            error={error}
            projectSlug={projectSlug}
            onRetry={onRetry}
            isRetrying={isRetrying}
          />
        )}
        <SidebarMenu>
          {issues.map((issue) => (
            <SidebarIssueItem key={issue.id} issue={issue} onLaunch={() => onLaunch(issue)} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// =============================================================================
// Sidebar content (shared between desktop and mobile)
// =============================================================================

function AgentNavigationBadge({
  summary,
  descriptionId,
}: {
  summary: NavigationData['agentsSummary'];
  descriptionId: string;
}) {
  if (!summary) {
    return null;
  }
  const description = `${summary.totalCount} ${summary.totalCount === 1 ? 'agent' : 'agents'}${summary.failedCount > 0 ? `, ${summary.failedCount} with a failed last completed run` : ''}`;
  return (
    <>
      <Badge
        data-agent-count
        aria-hidden="true"
        variant="secondary"
        className={cn(
          'ml-auto h-5 min-w-5 gap-1 px-1.5 text-xs',
          summary.failedCount > 0 && 'bg-destructive/10 text-destructive border-destructive/30'
        )}
      >
        {summary.failedCount > 0 ? <WarningIcon className="h-3 w-3" /> : null}
        {summary.totalCount}
      </Badge>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </>
  );
}

function ProjectFooterLinks({
  navData,
  workingCount,
  waitingCount,
  onNavigate,
}: {
  navData: NavigationData;
  workingCount: number;
  waitingCount: number;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const projectSlug =
    getProjectSlugFromPath(pathname) ??
    (navData.selectedProjectId ? navData.selectedProjectSlug : '');
  const activeSection = getProjectSection(pathname);
  const descriptionId = useId();
  const boardDescriptionId = useId();
  const summary = projectSlug ? navData.agentsSummary : undefined;

  // Board is active only on the board itself; on workspace detail routes the
  // workspace row carries the active state instead.
  const isActive = (section: ProjectSection) =>
    section === 'workspaces' ? isProjectBoardPath(pathname) : activeSection === section;
  const badges: Partial<Record<ProjectSection, ReactNode>> = {
    workspaces: projectSlug ? (
      <span id={boardDescriptionId} className="ml-auto flex shrink-0 gap-1">
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] tabular-nums">
          Working {workingCount}
        </Badge>
        <Badge variant="warning" className="h-5 px-1.5 text-[10px] tabular-nums">
          Waiting {waitingCount}
        </Badge>
      </span>
    ) : null,
    agents: <AgentNavigationBadge summary={summary} descriptionId={descriptionId} />,
    reviews:
      projectSlug && navData.reviewCount > 0 ? (
        <Badge variant="warning" className="ml-auto h-5 min-w-5 px-1.5 text-xs">
          {navData.reviewCount}
        </Badge>
      ) : null,
  };

  const descriptions: Partial<Record<ProjectSection, string>> = {
    workspaces: boardDescriptionId,
    agents: summary ? descriptionId : undefined,
  };

  return (
    [
      { section: 'workspaces', label: 'Board', Icon: KanbanIcon },
      { section: 'agents', label: 'Agents', Icon: RobotIcon },
      { section: 'reviews', label: 'Reviews', Icon: GitPullRequestIcon },
    ] as const
  ).map(({ section, label, Icon }) => {
    const active = isActive(section);
    const content = (
      <>
        <Icon className="h-4 w-4" />
        <span>{label}</span>
        {badges[section]}
      </>
    );
    return (
      <SidebarMenuItem key={section}>
        <SidebarMenuButton asChild={!!projectSlug} disabled={!projectSlug} isActive={active}>
          {projectSlug ? (
            <Link
              to={getProjectSectionPath(projectSlug, section)}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              aria-label={section === 'agents' || section === 'workspaces' ? label : undefined}
              aria-describedby={descriptions[section]}
            >
              {content}
            </Link>
          ) : (
            content
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  });
}

function SidebarInner({
  navData,
  issues,
  issuesStatus,
  issuesError,
  isFetchingIssues,
  refetchIssues,
  waiting,
  working,
  done,
  selectedProjectId,
  existingWorkspaceNames,
  showNewWorkspaceForm,
  onShowNewWorkspaceFormChange,
  canCreateWorkspace,
  onNavigate,
  showCloseButton,
}: {
  navData: NavigationData;
  issues: NormalizedIssue[] | undefined;
  issuesStatus: ProjectIssuesStatus | undefined;
  issuesError?: string | null;
  isFetchingIssues?: boolean;
  refetchIssues: () => void;
  waiting: ServerWorkspace[];
  working: ServerWorkspace[];
  done: ServerWorkspace[];
  selectedProjectId: string | undefined;
  existingWorkspaceNames: string[];
  showNewWorkspaceForm: boolean;
  onShowNewWorkspaceFormChange: (show: boolean) => void;
  canCreateWorkspace: boolean;
  onNavigate?: () => void;
  showCloseButton: boolean;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [launchIssue, setLaunchIssue] = useState<NormalizedIssue | null>(null);

  return (
    <WorkspaceCreationImageDropZone
      projectId={selectedProjectId}
      disabled={!canCreateWorkspace}
      className="flex flex-col"
      onDropAccepted={() => onShowNewWorkspaceFormChange(true)}
    >
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
            <XIcon className="h-5 w-5" />
          </Button>
        </header>
      )}

      <SidebarContent className={showCloseButton ? undefined : 'pt-2'}>
        <SidebarGroup className="pb-0">
          <SidebarGroupContent>
            {showNewWorkspaceForm && selectedProjectId ? (
              <div className="px-1">
                <ErrorBoundary variant="compact" title="Couldn't load the new workspace form">
                  <Suspense
                    fallback={<Loading size="compact" message="Loading new workspace form…" />}
                  >
                    <InlineWorkspaceForm
                      projectId={selectedProjectId}
                      existingNames={existingWorkspaceNames}
                      onCancel={() => onShowNewWorkspaceFormChange(false)}
                      onCreated={(workspaceId) => {
                        onShowNewWorkspaceFormChange(false);
                        if (navData.selectedProjectSlug) {
                          void navigate(
                            `/projects/${navData.selectedProjectSlug}/workspaces/${workspaceId}`
                          );
                        }
                        onNavigate?.();
                      }}
                    />
                  </Suspense>
                </ErrorBoundary>
              </div>
            ) : (
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => onShowNewWorkspaceFormChange(true)}
                    disabled={!canCreateWorkspace}
                    className="h-9"
                  >
                    <PlusIcon className="h-4 w-4" />
                    <span>New workspace</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        <IssueGroup
          issues={issues}
          status={issuesStatus}
          error={issuesError}
          projectSlug={navData.selectedProjectSlug}
          onRetry={refetchIssues}
          isRetrying={isFetchingIssues}
          onLaunch={setLaunchIssue}
        />
        <WorkspaceGroup
          label="Working"
          workspaces={working}
          projectSlug={navData.selectedProjectSlug}
          currentWorkspaceId={navData.currentWorkspaceId}
          unreadMailCounts={navData.unreadMailCounts}
          emptyText="No active workspaces"
        />
        <WorkspaceGroup
          label="Waiting"
          workspaces={waiting}
          projectSlug={navData.selectedProjectSlug}
          currentWorkspaceId={navData.currentWorkspaceId}
          unreadMailCounts={navData.unreadMailCounts}
          emptyText="No waiting workspaces"
        />
        <WorkspaceGroup
          label="Done"
          workspaces={done}
          projectSlug={navData.selectedProjectSlug}
          currentWorkspaceId={navData.currentWorkspaceId}
          unreadMailCounts={navData.unreadMailCounts}
          emptyText="No completed workspaces"
        />
      </SidebarContent>

      {launchIssue && selectedProjectId && (
        <ErrorBoundary variant="compact" title="Couldn't load the issue launch form">
          <Suspense fallback={<Loading size="compact" message="Loading issue launch form…" />}>
            <IssueLaunchSheet
              issue={launchIssue}
              projectId={selectedProjectId}
              open
              onOpenChange={(open) => {
                if (!open) {
                  setLaunchIssue(null);
                }
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      <SidebarSeparator />

      <SidebarFooter>
        <SidebarMenu>
          <ProjectFooterLinks
            navData={navData}
            workingCount={working.length}
            waitingCount={waiting.length}
            onNavigate={onNavigate}
          />
          <SidebarMenuItem>
            <div className="flex items-center gap-1">
              <SidebarMenuButton
                asChild
                isActive={pathname === '/admin' || pathname?.startsWith('/admin/')}
                className="flex-1"
              >
                <Link to="/admin" onClick={onNavigate}>
                  <GearIcon className="h-4 w-4" />
                  <span>Settings</span>
                </Link>
              </SidebarMenuButton>
              <ThemeToggle />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>

        <div className="pb-2" />

        <SidebarSeparator />

        <div className="flex justify-center px-3 pb-2 pt-1">
          <Logo iconClassName="size-8" textClassName="text-base" />
        </div>
      </SidebarFooter>
    </WorkspaceCreationImageDropZone>
  );
}

// =============================================================================
// Main sidebar component
// =============================================================================

export function AppSidebar({ navData }: { navData: NavigationData }) {
  const { pathname } = useLocation();
  const prevPathnameRef = useRef(pathname);
  const prevSelectedProjectIdRef = useRef(navData.selectedProjectId);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const { open, openMobile, setOpenMobile, isMobile } = useSidebar();
  const [showNewWorkspaceForm, setShowNewWorkspaceForm] = useState(false);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(getPersistedSidebarWidth);

  // Auto-close mobile sidebar on route navigation
  useEffect(() => {
    if (pathname !== prevPathnameRef.current) {
      setOpenMobile(false);
    }
    prevPathnameRef.current = pathname;
  }, [pathname, setOpenMobile]);

  useEffect(() => {
    if (prevSelectedProjectIdRef.current !== navData.selectedProjectId) {
      prevSelectedProjectIdRef.current = navData.selectedProjectId;
      setShowNewWorkspaceForm(false);
    }
  }, [navData.selectedProjectId]);

  useEffect(() => {
    persistSidebarWidth(sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    if (!open && resizeCleanupRef.current) {
      resizeCleanupRef.current();
    }
  }, [open]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  // Fetch issues for the Todo section
  const {
    issues,
    status: issuesStatus,
    error: issuesError,
    isFetching: isFetchingIssues,
    refetch: refetchIssues,
  } = useProjectIssues(navData.selectedProjectId, navData.issueProvider, {
    workspaceIssueLinks: navData.serverWorkspaces,
  });

  // Group workspaces by kanban column, sorted by createdAt descending (newest first)
  const { waiting, working, done } = useMemo(() => {
    return groupWorkspacesForSidebar(navData.serverWorkspaces ?? []);
  }, [navData.serverWorkspaces]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !open) {
      return;
    }

    event.preventDefault();
    resizeCleanupRef.current?.();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handleElement = event.currentTarget;
    const controller = new AbortController();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    const cleanup = () => {
      controller.abort();
      setIsResizingSidebar(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizeCleanupRef.current = null;
      if (handleElement.hasPointerCapture(pointerId)) {
        handleElement.releasePointerCapture(pointerId);
      }
    };

    resizeCleanupRef.current = cleanup;
    setIsResizingSidebar(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handleElement.setPointerCapture(pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      const deltaX = moveEvent.clientX - startX;
      setSidebarWidth(clampSidebarWidth(startWidth + deltaX));
    };

    const handlePointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) {
        return;
      }
      cleanup();
    };

    window.addEventListener('pointermove', handlePointerMove, { signal: controller.signal });
    window.addEventListener('pointerup', handlePointerEnd, { signal: controller.signal });
    window.addEventListener('pointercancel', handlePointerEnd, { signal: controller.signal });
  };

  const sharedProps = {
    navData,
    issues,
    issuesStatus,
    issuesError,
    isFetchingIssues,
    refetchIssues: () => {
      void refetchIssues();
    },
    waiting,
    working,
    done,
    selectedProjectId: navData.selectedProjectId,
    existingWorkspaceNames: navData.serverWorkspaces?.map((workspace) => workspace.name) ?? [],
    showNewWorkspaceForm,
    onShowNewWorkspaceFormChange: setShowNewWorkspaceForm,
    canCreateWorkspace: Boolean(navData.selectedProjectId && navData.selectedProjectSlug),
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
        'shrink-0 overflow-hidden transition-[width] duration-150 ease-out motion-reduce:transition-none',
        isResizingSidebar && 'duration-0'
      )}
      style={{ width: open ? `${sidebarWidth}px` : '0px' }}
    >
      <div
        className="relative flex h-full flex-col border-r bg-sidebar text-sidebar-foreground"
        style={{ width: `${sidebarWidth}px` }}
      >
        <SidebarInner {...sharedProps} showCloseButton={false} />
        {open && (
          <button
            type="button"
            aria-label="Resize sidebar"
            className="absolute inset-y-0 right-0 z-30 w-3 cursor-col-resize touch-none bg-transparent hover:bg-sidebar-border/40"
            onPointerDown={handleResizePointerDown}
          />
        )}
      </div>
    </div>
  );
}
