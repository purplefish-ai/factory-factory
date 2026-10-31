import { DotOutlineIcon } from '@phosphor-icons/react/dist/csr/DotOutline';
import { GearIcon } from '@phosphor-icons/react/dist/csr/Gear';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ServerWorkspace } from '@/client/components/use-workspace-list-state';
import { InlineWorkspaceForm } from '@/client/features/kanban/inline-workspace-form';
import {
  getProjectSlugFromPath,
  type useAppNavigationData,
} from '@/client/hooks/use-app-navigation-data';
import { useProjectIssues } from '@/client/hooks/use-project-issues';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { getProjectSection, getProjectSectionPath } from '@/client/lib/project-navigation';
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

// =============================================================================
// Workspace item component
// =============================================================================

// Memoized: a snapshot for one workspace keeps the other rows' objects, so only
// the changed row re-renders.
const SidebarWorkspaceItem = memo(function SidebarWorkspaceItem({
  workspace,
  projectSlug,
  isActive,
}: {
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
          workspace.pendingRequestType && 'border-amber-500/30 bg-amber-500/5'
        )}
      >
        <Link to={`/projects/${projectSlug}/workspaces/${workspace.id}`}>
          <WorkspaceItemContent
            workspace={workspace}
            onOpenPr={() => {
              window.open(workspace.prUrl as string, '_blank', 'noopener,noreferrer');
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

function SidebarIssueItem({ issue }: { issue: NormalizedIssue }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild className="h-auto py-1.5 px-2">
        <a href={issue.url} target="_blank" rel="noopener noreferrer">
          <div className="flex items-center gap-2 min-w-0">
            <DotOutlineIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
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
  onNavigate,
}: {
  navData: NavigationData;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const projectSlug =
    getProjectSlugFromPath(pathname) ??
    (navData.selectedProjectId ? navData.selectedProjectSlug : '');
  const activeSection = getProjectSection(pathname);
  const descriptionId = useId();
  const summary = projectSlug ? navData.agentsSummary : undefined;

  return (
    [
      { section: 'agents', label: 'Agents', Icon: RobotIcon },
      { section: 'reviews', label: 'Reviews', Icon: GitPullRequestIcon },
    ] as const
  ).map(({ section, label, Icon }) => {
    const content = (
      <>
        <Icon className="h-4 w-4" />
        <span>{label}</span>
        {section === 'agents' ? (
          <AgentNavigationBadge summary={summary} descriptionId={descriptionId} />
        ) : null}
        {projectSlug && section === 'reviews' && navData.reviewCount > 0 ? (
          <Badge
            variant="secondary"
            className="ml-auto h-5 min-w-5 px-1.5 text-xs bg-orange-500/20 text-orange-600 border-orange-500/30"
          >
            {navData.reviewCount}
          </Badge>
        ) : null}
      </>
    );
    return (
      <SidebarMenuItem key={section}>
        <SidebarMenuButton
          asChild={!!projectSlug}
          disabled={!projectSlug}
          isActive={activeSection === section}
        >
          {projectSlug ? (
            <Link
              to={getProjectSectionPath(projectSlug, section)}
              onClick={onNavigate}
              aria-label={section === 'agents' ? 'Agents' : undefined}
              aria-describedby={section === 'agents' && summary ? descriptionId : undefined}
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
            <XIcon className="h-5 w-5" />
          </Button>
        </header>
      )}

      <SidebarContent className={showCloseButton ? undefined : 'pt-2'}>
        <SidebarGroup className="pb-0">
          <SidebarGroupContent>
            {showNewWorkspaceForm && selectedProjectId ? (
              <div className="px-1">
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
                    <span>New Workspace</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            )}
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
          <ProjectFooterLinks navData={navData} onNavigate={onNavigate} />
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
          <Logo iconClassName="size-6" textClassName="text-base" />
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
  const { issues } = useProjectIssues(navData.selectedProjectId, navData.issueProvider, {
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
        'shrink-0 overflow-hidden transition-[width] duration-200 ease-linear',
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
