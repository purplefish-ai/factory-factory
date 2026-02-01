import { Archive, Check, GitPullRequest, Kanban, Loader2, Plus, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatRelativeTime } from '@/lib/utils';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';
import { useProjectContext } from '../lib/providers';
import { trpc } from '../lib/trpc';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';
import { useWorkspaceListState, type WorkspaceListItem } from './use-workspace-list-state';

const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Get status dot color class for a workspace.
 * Priority: working > merged > CI failure > CI pending > CI success > uncommitted > default
 */
function getStatusDotClass(workspace: WorkspaceListItem): string {
  if (workspace.isWorking) {
    return 'bg-green-500 animate-pulse';
  }
  if (workspace.prState === 'MERGED') {
    return 'bg-purple-500';
  }
  if (workspace.prCiStatus === 'FAILURE') {
    return 'bg-red-500';
  }
  if (workspace.prCiStatus === 'PENDING') {
    return 'bg-yellow-500 animate-pulse';
  }
  if (workspace.prCiStatus === 'SUCCESS') {
    return 'bg-green-500';
  }
  if (workspace.gitStats?.hasUncommitted) {
    return 'bg-orange-500';
  }
  return 'bg-gray-400';
}

export function AppSidebar() {
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string>(() => {
    const slugFromPath = getProjectSlugFromPath(window.location.pathname);
    if (slugFromPath && slugFromPath !== 'new') {
      return slugFromPath;
    }
    return localStorage.getItem(SELECTED_PROJECT_KEY) || '';
  });
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [workspaceToArchive, setWorkspaceToArchive] = useState<string | null>(null);
  const { setProjectContext } = useProjectContext();

  const { data: projects } = trpc.project.list.useQuery({
    isArchived: false,
  });

  const selectedProjectId = projects?.find((p) => p.slug === selectedProjectSlug)?.id;

  // Fetch unified project summary state (workspaces + working status + git stats + review count)
  const { data: projectState } = trpc.workspace.getProjectSummaryState.useQuery(
    { projectId: selectedProjectId ?? '' },
    { enabled: !!selectedProjectId, refetchInterval: 2000 }
  );

  const serverWorkspaces = projectState?.workspaces;
  const reviewCount = projectState?.reviewCount ?? 0;

  const utils = trpc.useUtils();

  // Use the workspace list state management hook
  const {
    workspaceList,
    existingNames,
    isCreating,
    startCreating,
    cancelCreating,
    startArchiving,
  } = useWorkspaceListState(serverWorkspaces);

  const createWorkspace = trpc.workspace.create.useMutation();
  const archiveWorkspace = trpc.workspace.archive.useMutation({
    onSuccess: (_data, variables) => {
      utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
      // If we archived the currently viewed workspace, navigate to the workspaces list
      const archivedId = variables.id;
      const currentId = pathname.match(/\/workspaces\/([^/]+)/)?.[1];
      if (archivedId === currentId) {
        navigate(`/projects/${selectedProjectSlug}/workspaces`);
      }
    },
  });

  const handleCreateWorkspace = async () => {
    if (!selectedProjectId || isCreating) {
      return;
    }
    const name = generateUniqueWorkspaceName(existingNames);
    startCreating(name);

    try {
      // Create workspace (branchName defaults to project's default branch)
      // Don't create a session - user will choose workflow in workspace page
      const workspace = await createWorkspace.mutateAsync({
        projectId: selectedProjectId,
        name,
      });

      // Invalidate caches to trigger immediate refetch
      utils.workspace.list.invalidate({ projectId: selectedProjectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });

      // Navigate to workspace (workflow selection will be shown)
      navigate(`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`);
    } catch (error) {
      // Clear the creating state on error so the UI doesn't get stuck
      cancelCreating();
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to create workspace: ${message}`);
    }
  };

  // Get current workspace ID from URL
  const currentWorkspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1];

  useEffect(() => {
    if (selectedProjectId) {
      setProjectContext(selectedProjectId);
    }
  }, [selectedProjectId, setProjectContext]);

  useEffect(() => {
    const slugFromPath = getProjectSlugFromPath(pathname);
    if (slugFromPath && slugFromPath !== 'new') {
      setSelectedProjectSlug(slugFromPath);
      localStorage.setItem(SELECTED_PROJECT_KEY, slugFromPath);
    } else {
      const stored = localStorage.getItem(SELECTED_PROJECT_KEY);
      if (stored) {
        setSelectedProjectSlug(stored);
      }
    }
  }, [pathname]);

  // Select first project if none selected
  useEffect(() => {
    if (projects && projects.length > 0 && !selectedProjectSlug) {
      const firstSlug = projects[0].slug;
      setSelectedProjectSlug(firstSlug);
      localStorage.setItem(SELECTED_PROJECT_KEY, firstSlug);
    }
  }, [projects, selectedProjectSlug]);

  const handleProjectChange = (value: string) => {
    if (value === '__manage__') {
      navigate('/projects');
      return;
    }
    if (value === '__create__') {
      navigate('/projects/new');
      return;
    }
    setSelectedProjectSlug(value);
    localStorage.setItem(SELECTED_PROJECT_KEY, value);
    navigate(`/projects/${value}/workspaces`);
  };

  const globalNavItems = [
    { href: '/reviews', label: 'Reviews', icon: GitPullRequest },
    { href: '/admin', label: 'Admin', icon: Settings },
  ];

  return (
    <Sidebar collapsible="none">
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <Link to="/projects">
          <Logo
            showIcon={false}
            textClassName="text-lg"
            className="hover:opacity-80 transition-opacity"
          />
        </Link>

        <div className="mt-3">
          <Select value={selectedProjectSlug} onValueChange={handleProjectChange}>
            <SelectTrigger id="project-select" className="w-full">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {projects?.map((project) => (
                <SelectItem key={project.id} value={project.slug}>
                  {project.name}
                </SelectItem>
              ))}
              <SelectItem value="__create__" className="text-muted-foreground">
                + Create project
              </SelectItem>
              <SelectItem value="__manage__" className="text-muted-foreground">
                Manage projects...
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </SidebarHeader>

      <SidebarContent className="flex flex-col">
        {/* Workspaces section */}
        {selectedProjectSlug && (
          <SidebarGroup className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <SidebarGroupLabel>
              <Link
                to={`/projects/${selectedProjectSlug}/workspaces`}
                className="hover:text-foreground transition-colors"
              >
                Workspaces
              </Link>
            </SidebarGroupLabel>
            <div className="absolute right-1 top-2 flex items-center gap-0.5">
              <Link
                to={`/projects/${selectedProjectSlug}/workspaces`}
                className="p-1 rounded hover:bg-sidebar-accent transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground"
                title="View Kanban board"
              >
                <Kanban className="h-3.5 w-3.5" />
              </Link>
              <button
                type="button"
                onClick={handleCreateWorkspace}
                disabled={isCreating}
                className="p-1 rounded hover:bg-sidebar-accent transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground disabled:opacity-50"
                title="New Workspace"
              >
                {isCreating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <SidebarGroupContent className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide">
              <SidebarMenu>
                {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: conditional rendering for workspace states */}
                {workspaceList.map((workspace) => {
                  const isCreatingItem = workspace.uiState === 'creating';
                  const isArchivingItem = workspace.uiState === 'archiving';
                  const isActive = currentWorkspaceId === workspace.id;
                  const { gitStats: stats } = workspace;

                  // Creating placeholder - non-clickable
                  if (isCreatingItem) {
                    return (
                      <SidebarMenuItem key={workspace.id}>
                        <SidebarMenuButton className="h-8 px-2 cursor-default">
                          <div className="flex items-center gap-2 w-full min-w-0">
                            <Loader2 className="h-2 w-2 shrink-0 text-muted-foreground animate-spin" />
                            <span className="truncate text-sm text-muted-foreground">
                              Creating...
                            </span>
                          </div>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  }

                  return (
                    <SidebarMenuItem key={workspace.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        className={cn(
                          'h-8 px-2',
                          isArchivingItem && 'opacity-50 pointer-events-none'
                        )}
                      >
                        <Link to={`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`}>
                          <div className="flex items-center w-full min-w-0">
                            {/* Status dot */}
                            <span className="w-3 shrink-0 flex justify-center">
                              {isArchivingItem ? (
                                <Loader2 className="h-2 w-2 text-muted-foreground animate-spin" />
                              ) : (
                                <span
                                  className={cn(
                                    'h-2 w-2 rounded-full',
                                    getStatusDotClass(workspace)
                                  )}
                                />
                              )}
                            </span>

                            {/* Name (truncates) */}
                            <span className="truncate font-medium text-sm flex-1 min-w-0 ml-1">
                              {isArchivingItem ? 'Archiving...' : workspace.name}
                            </span>

                            {/* Diff stats - fixed width columns */}
                            <span className="w-14 flex text-xs tabular-nums shrink-0">
                              {stats &&
                              (stats.additions > 0 || stats.deletions > 0 || stats.total > 0) ? (
                                stats.additions > 0 || stats.deletions > 0 ? (
                                  <>
                                    <span className="w-1/2 text-right text-green-600 dark:text-green-400">
                                      +{stats.additions}
                                    </span>
                                    <span className="w-1/2 text-left pl-0.5 text-red-600 dark:text-red-400">
                                      -{stats.deletions}
                                    </span>
                                  </>
                                ) : (
                                  <span className="w-full text-center text-muted-foreground">
                                    {stats.total} files
                                  </span>
                                )
                              ) : null}
                            </span>

                            {/* PR number - fixed width */}
                            <span className="w-14 shrink-0 text-right">
                              {workspace.prNumber &&
                                workspace.prState !== 'NONE' &&
                                workspace.prUrl && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          if (workspace.prUrl) {
                                            window.open(
                                              workspace.prUrl,
                                              '_blank',
                                              'noopener,noreferrer'
                                            );
                                          }
                                        }}
                                        className={cn(
                                          'text-xs hover:opacity-80 transition-opacity',
                                          workspace.prState === 'MERGED'
                                            ? 'text-purple-500'
                                            : 'text-muted-foreground hover:text-foreground'
                                        )}
                                      >
                                        #{workspace.prNumber}
                                        <span className="inline-block w-3.5 ml-0.5">
                                          {workspace.prState === 'MERGED' && (
                                            <Check className="h-3 w-3 inline" />
                                          )}
                                        </span>
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="right">
                                      <p>
                                        PR #{workspace.prNumber}
                                        {workspace.prState === 'MERGED'
                                          ? ' · Merged'
                                          : workspace.prState === 'CLOSED'
                                            ? ' · Closed'
                                            : workspace.prCiStatus === 'SUCCESS'
                                              ? ' · CI passed'
                                              : workspace.prCiStatus === 'FAILURE'
                                                ? ' · CI failed'
                                                : workspace.prCiStatus === 'PENDING'
                                                  ? ' · CI running'
                                                  : ''}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        Click to open on GitHub
                                      </p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                            </span>

                            {/* Timestamp - fixed width */}
                            <span className="w-10 text-right text-muted-foreground text-xs shrink-0">
                              {workspace.lastActivityAt &&
                                formatRelativeTime(workspace.lastActivityAt)}
                            </span>

                            {/* Archive button (hover, or always visible in yellow for closed/merged PRs) */}
                            {!isArchivingItem && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setWorkspaceToArchive(workspace.id);
                                      setArchiveDialogOpen(true);
                                    }}
                                    className={cn(
                                      'shrink-0 ml-1 p-0.5 rounded transition-opacity',
                                      workspace.prState === 'MERGED' ||
                                        workspace.prState === 'CLOSED'
                                        ? 'opacity-100 text-yellow-500 hover:text-yellow-400 hover:bg-yellow-500/10'
                                        : 'opacity-0 group-hover/menu-item:opacity-100 text-muted-foreground hover:text-foreground hover:bg-muted'
                                    )}
                                  >
                                    <Archive className="h-3 w-3" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="right">Archive</TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
                {workspaceList.length === 0 && (
                  <div className="px-2 py-4 text-xs text-muted-foreground text-center">
                    No active workspaces
                  </div>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {globalNavItems.map((item) => {
                const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
                const showBadge = item.href === '/reviews' && reviewCount > 0;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link to={item.href}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                        {showBadge && (
                          <Badge
                            variant="secondary"
                            className="ml-auto h-5 min-w-5 px-1.5 text-xs bg-orange-500/20 text-orange-600 border-orange-500/30"
                          >
                            {reviewCount}
                          </Badge>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-4">
        <ServerPortInfo />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Phase 7: Production Ready</p>
          <ThemeToggle />
        </div>
      </SidebarFooter>

      <ConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        title="Archive Workspace"
        description="Are you sure you want to archive this workspace?"
        confirmText="Archive"
        variant="destructive"
        onConfirm={() => {
          if (workspaceToArchive) {
            // Start archiving state management (optimistic UI)
            startArchiving(workspaceToArchive);
            archiveWorkspace.mutate({ id: workspaceToArchive });
          }
          setArchiveDialogOpen(false);
        }}
        isPending={archiveWorkspace.isPending}
      />
    </Sidebar>
  );
}

/**
 * ServerPortInfo Component
 * Displays backend port information when running on non-default port
 */
function ServerPortInfo() {
  const { data: serverInfo, isLoading } = trpc.admin.getServerInfo.useQuery(undefined, {
    // Retry configuration in case endpoint isn't available yet
    retry: 1,
    retryDelay: 1000,
    // Don't show errors for this optional enhancement
    meta: { suppressErrors: true },
  });

  // Get the current frontend port from window.location
  const frontendPort = window.location.port ? Number.parseInt(window.location.port, 10) : null;
  const backendPort = serverInfo?.backendPort ?? null;

  // If we're still loading or don't have frontend port
  if (isLoading || !frontendPort) {
    return null;
  }

  // Check if we're running on non-default ports
  const defaultFrontendPort = 3000;
  const defaultBackendPort = 3001;
  const isNonDefaultFrontend = frontendPort !== defaultFrontendPort;
  const isNonDefaultBackend = backendPort !== null && backendPort !== defaultBackendPort;

  // Only show if running on non-default ports
  if (!(isNonDefaultFrontend || isNonDefaultBackend)) {
    return null;
  }

  // Determine if we're in dev or production mode
  // In production, frontend and backend are on the same port
  // In dev, they're on different ports
  const isDev = backendPort !== null && frontendPort !== backendPort;

  return (
    <div className="mb-2 space-y-0.5 text-[10px] text-muted-foreground/80">
      {isDev ? (
        <>
          <div className="flex items-center justify-between">
            <span>Frontend:</span>
            <code className="rounded bg-muted px-1 py-0.5">{frontendPort}</code>
          </div>
          <div className="flex items-center justify-between">
            <span>Backend:</span>
            {backendPort ? (
              <code className="rounded bg-muted px-1 py-0.5">{backendPort}</code>
            ) : (
              <code className="rounded bg-muted px-1 py-0.5 text-muted-foreground/50">
                (restart to detect)
              </code>
            )}
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between">
          <span>Server:</span>
          {backendPort ? (
            <code className="rounded bg-muted px-1 py-0.5">{backendPort}</code>
          ) : (
            <code className="rounded bg-muted px-1 py-0.5 text-muted-foreground/50">
              (restart to detect)
            </code>
          )}
        </div>
      )}
    </div>
  );
}
