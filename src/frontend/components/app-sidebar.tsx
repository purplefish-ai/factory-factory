import {
  Archive,
  CheckCircle2,
  Circle,
  GitBranch,
  GitPullRequest,
  Kanban,
  Loader2,
  Plus,
  Settings,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';
import { useProjectContext } from '../lib/providers';
import { trpc } from '../lib/trpc';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';

const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? match[1] : null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sidebar has many interactive states (create, archive, working indicators)
export function AppSidebar() {
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string>('');
  const [hasCheckedProjects, setHasCheckedProjects] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [workspaceToArchive, setWorkspaceToArchive] = useState<string | null>(null);
  const [archivingWorkspace, setArchivingWorkspace] = useState<{
    id: string;
    name: string;
    branchName?: string | null;
  } | null>(null);
  const { setProjectContext } = useProjectContext();

  const { data: projects, isLoading: projectsLoading } = trpc.project.list.useQuery({
    isArchived: false,
  });

  const selectedProjectId = projects?.find((p) => p.slug === selectedProjectSlug)?.id;

  // Fetch unified project summary state (workspaces + working status + git stats + review count)
  // Poll every 10s (git operations are expensive); staleTime prevents refetch on window focus
  const { data: projectState } = trpc.workspace.getProjectSummaryState.useQuery(
    { projectId: selectedProjectId ?? '' },
    { enabled: !!selectedProjectId, refetchInterval: 10_000, staleTime: 8000 }
  );

  const workspaces = projectState?.workspaces;
  const reviewCount = projectState?.reviewCount ?? 0;

  const utils = trpc.useUtils();

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
  // ID of workspace currently being archived - use archivingWorkspace state as source of truth
  // (not isPending, which clears before cache updates)
  const archivingWorkspaceId = archivingWorkspace?.id ?? null;
  // Track pending workspace: name during creation, id+name after creation until it appears in list
  const [pendingWorkspace, setPendingWorkspace] = useState<{
    name: string;
    id?: string;
  } | null>(null);

  const existingWorkspaceNames = useMemo(() => {
    const names = workspaces?.map((w) => w.name) ?? [];
    // Include pending name to prevent duplicates on rapid clicks
    if (pendingWorkspace?.name) {
      names.push(pendingWorkspace.name);
    }
    return names;
  }, [workspaces, pendingWorkspace?.name]);

  const handleCreateWorkspace = async () => {
    if (!selectedProjectId) {
      return;
    }
    const name = generateUniqueWorkspaceName(existingWorkspaceNames);
    setPendingWorkspace({ name });

    // Create workspace (branchName defaults to project's default branch)
    // Don't create a session - user will choose workflow in workspace page
    const workspace = await createWorkspace.mutateAsync({
      projectId: selectedProjectId,
      name,
    });

    // Update pending workspace with ID so we can show it as selected
    setPendingWorkspace({ name, id: workspace.id });

    // Invalidate caches to trigger immediate refetch
    utils.workspace.list.invalidate({ projectId: selectedProjectId });
    utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });

    // Navigate to workspace (workflow selection will be shown)
    navigate(`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`);
  };

  // Get current workspace ID from URL
  const currentWorkspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1];
  const isCreatingWorkspace = createWorkspace.isPending;

  // Check if the pending workspace has appeared in the list yet
  const pendingWorkspaceInList = pendingWorkspace?.id
    ? workspaces?.some((w) => w.id === pendingWorkspace.id)
    : workspaces?.some((w) => w.name === pendingWorkspace?.name);

  // Clear pending workspace once it appears in the list
  useEffect(() => {
    if (pendingWorkspace && pendingWorkspaceInList) {
      setPendingWorkspace(null);
    }
  }, [pendingWorkspace, pendingWorkspaceInList]);

  // Clear archiving workspace state after it's removed from the list and mutation is complete
  const archivingWorkspaceInList = archivingWorkspace
    ? workspaces?.some((w) => w.id === archivingWorkspace.id)
    : false;

  useEffect(() => {
    if (!archivingWorkspace || archiveWorkspace.isPending || archivingWorkspaceInList) {
      return;
    }
    // Small delay for visual feedback before clearing
    const timer = setTimeout(() => {
      setArchivingWorkspace(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [archivingWorkspace, archiveWorkspace.isPending, archivingWorkspaceInList]);

  // Show "Creating..." placeholder only during the mutation (before we have an ID)
  const showCreatingPlaceholder = isCreatingWorkspace && !pendingWorkspace?.id;

  // Show optimistic workspace entry after creation but before it appears in the list
  const showOptimisticWorkspace = pendingWorkspace?.id && !pendingWorkspaceInList;

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

  useEffect(() => {
    if (!projectsLoading && projects) {
      setHasCheckedProjects(true);

      if (projects.length === 0) {
        if (!pathname.startsWith('/projects/new')) {
          navigate('/projects/new');
        }
      } else if (!selectedProjectSlug) {
        const firstSlug = projects[0].slug;
        setSelectedProjectSlug(firstSlug);
        localStorage.setItem(SELECTED_PROJECT_KEY, firstSlug);
      }
    }
  }, [projectsLoading, projects, selectedProjectSlug, pathname, navigate]);

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

  // Show loading skeleton while checking for projects
  if (!hasCheckedProjects) {
    return (
      <Sidebar collapsible="none">
        <SidebarHeader className="border-b border-sidebar-border p-4">
          <Logo iconClassName="size-6" textClassName="text-sm" />
          {/* Project selector skeleton */}
          <div className="mt-3">
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        </SidebarHeader>
        <SidebarContent className="flex flex-col">
          {/* Workspaces section skeleton */}
          <SidebarGroup className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <SidebarGroupLabel>
              <Skeleton className="h-4 w-20" />
            </SidebarGroupLabel>
            <SidebarGroupContent className="flex-1 min-h-0">
              <SidebarMenu>
                {/* Workspace item skeletons */}
                {[1, 2, 3].map((i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuButton className="h-auto py-2 cursor-default">
                      <div className="flex flex-col gap-1.5 w-full">
                        <div className="flex items-center gap-1.5">
                          <Skeleton className="h-3 w-3 shrink-0" />
                          <Skeleton className="h-4 flex-1" />
                        </div>
                        <Skeleton className="h-3 w-24" />
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          {/* Navigation items skeleton */}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {[1, 2].map((i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuButton className="cursor-default">
                      <Skeleton className="h-4 w-4" />
                      <Skeleton className="h-4 w-16" />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </SidebarFooter>
      </Sidebar>
    );
  }

  // Hide sidebar when no projects exist - show onboarding flow
  if (projects && projects.length === 0) {
    return null;
  }

  return (
    <Sidebar collapsible="none">
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <Link to="/projects">
          <Logo
            iconClassName="size-6"
            textClassName="text-sm"
            className="hover:opacity-80 transition-opacity"
          />
        </Link>

        {projects && projects.length > 0 && (
          <div className="mt-3">
            <Select value={selectedProjectSlug} onValueChange={handleProjectChange}>
              <SelectTrigger id="project-select" className="w-full">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
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
        )}
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
                disabled={isCreatingWorkspace}
                className="p-1 rounded hover:bg-sidebar-accent transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground disabled:opacity-50"
                title="New Workspace"
              >
                {isCreatingWorkspace ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <SidebarGroupContent className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide">
              <SidebarMenu>
                {showCreatingPlaceholder && (
                  <SidebarMenuItem>
                    <SidebarMenuButton className="h-auto py-2 cursor-default">
                      <div className="flex flex-col gap-0.5 w-0 flex-1 overflow-hidden">
                        <div className="flex items-center gap-1.5">
                          <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground animate-spin" />
                          <span className="truncate font-medium text-sm text-muted-foreground">
                            Creating workspace...
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Skeleton className="h-3 w-24" />
                        </div>
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {/* Optimistic workspace entry - shows immediately after creation before polling picks it up */}
                {showOptimisticWorkspace && pendingWorkspace.id && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={currentWorkspaceId === pendingWorkspace.id}
                      className="h-auto py-2"
                    >
                      <Link
                        to={`/projects/${selectedProjectSlug}/workspaces/${pendingWorkspace.id}`}
                      >
                        <div className="flex flex-col gap-0.5 w-0 flex-1 overflow-hidden">
                          <div className="flex items-center gap-1.5">
                            <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground animate-spin" />
                            <span className="truncate font-medium text-sm">
                              {pendingWorkspace.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="truncate">Initializing...</span>
                          </div>
                        </div>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {/* Optimistic archiving entry - shows after workspace is removed from list but before mutation completes */}
                {archivingWorkspace && !workspaces?.some((w) => w.id === archivingWorkspace.id) && (
                  <SidebarMenuItem>
                    <SidebarMenuButton className="h-auto py-2 opacity-50 pointer-events-none">
                      <div className="flex flex-col gap-0.5 w-0 flex-1 overflow-hidden">
                        <div className="flex items-center gap-1.5">
                          <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground animate-spin" />
                          <span className="truncate font-medium text-sm">Archiving...</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="truncate">{archivingWorkspace.name}</span>
                        </div>
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: conditional rendering for PR/CI status badges */}
                {workspaces?.map((workspace) => {
                  const isActive = currentWorkspaceId === workspace.id;
                  const isArchiving = archivingWorkspaceId === workspace.id;
                  const { isWorking, gitStats: stats } = workspace;
                  const hasChanges =
                    stats && (stats.total > 0 || stats.additions > 0 || stats.deletions > 0);
                  return (
                    <SidebarMenuItem key={workspace.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        className={`h-auto py-2 ${isArchiving ? 'opacity-50 pointer-events-none' : ''}`}
                      >
                        <Link to={`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`}>
                          <div className="flex flex-col gap-0.5 w-0 flex-1 overflow-hidden">
                            <div className="flex items-center gap-1.5">
                              {isArchiving || !workspace.branchName ? (
                                <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground animate-spin" />
                              ) : (
                                <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                              )}
                              <span className="truncate font-medium text-sm">
                                {isArchiving
                                  ? 'Archiving...'
                                  : workspace.branchName || workspace.name}
                              </span>
                              <span className="ml-auto shrink-0 flex items-center gap-1.5">
                                {hasChanges && (
                                  <span className="shrink-0 flex items-center gap-1 text-xs font-mono px-1 py-px rounded border border-border/60 bg-muted/80">
                                    {stats.additions > 0 || stats.deletions > 0 ? (
                                      <>
                                        <span className="text-green-600 dark:text-green-400">
                                          +{stats.additions}
                                        </span>
                                        <span className="text-red-600 dark:text-red-400">
                                          -{stats.deletions}
                                        </span>
                                      </>
                                    ) : (
                                      <span className="text-yellow-600 dark:text-yellow-500">
                                        {stats.total} {stats.total === 1 ? 'file' : 'files'}
                                      </span>
                                    )}
                                  </span>
                                )}
                                {stats?.hasUncommitted && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="h-2 w-2 rounded-full bg-orange-500 shrink-0" />
                                    </TooltipTrigger>
                                    <TooltipContent side="right">
                                      <p>Uncommitted changes</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
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
                                          className={`shrink-0 flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full transition-colors ${
                                            workspace.prState === 'MERGED'
                                              ? 'bg-purple-500/25 text-purple-700 dark:text-purple-300 hover:bg-purple-500/35'
                                              : workspace.prState === 'CLOSED'
                                                ? 'bg-gray-500/20 text-gray-500 dark:text-gray-400 hover:bg-gray-500/30'
                                                : 'bg-purple-500/15 text-purple-600 dark:text-purple-400 hover:bg-purple-500/25'
                                          }`}
                                        >
                                          <GitPullRequest className="h-3 w-3" />
                                          <span>#{workspace.prNumber}</span>
                                          {workspace.prState === 'MERGED' ? (
                                            <CheckCircle2 className="h-3 w-3 text-purple-500" />
                                          ) : workspace.prState === 'CLOSED' ? (
                                            <XCircle className="h-3 w-3 text-gray-400" />
                                          ) : (
                                            <>
                                              {workspace.prCiStatus === 'SUCCESS' && (
                                                <CheckCircle2 className="h-3 w-3 text-green-500" />
                                              )}
                                              {workspace.prCiStatus === 'FAILURE' && (
                                                <XCircle className="h-3 w-3 text-red-500" />
                                              )}
                                              {workspace.prCiStatus === 'PENDING' && (
                                                <Circle className="h-3 w-3 text-yellow-500 animate-pulse" />
                                              )}
                                            </>
                                          )}
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
                                {!isArchiving && (
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
                                        className="shrink-0 p-0.5 rounded opacity-0 group-hover/menu-item:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-muted"
                                      >
                                        <Archive className="h-3 w-3" />
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="right">Archive</TooltipContent>
                                  </Tooltip>
                                )}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="truncate">{workspace.name}</span>
                              {isWorking && (
                                <>
                                  <span>·</span>
                                  <Loader2 className="h-3 w-3 animate-spin text-green-500 shrink-0" />
                                </>
                              )}
                            </div>
                          </div>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
                {workspaces?.length === 0 && (
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
            // Capture workspace info for optimistic UI before archiving
            const workspace = workspaces?.find((w) => w.id === workspaceToArchive);
            if (workspace) {
              setArchivingWorkspace({
                id: workspace.id,
                name: workspace.name,
                branchName: workspace.branchName,
              });
            }
            archiveWorkspace.mutate({ id: workspaceToArchive });
          }
          setArchiveDialogOpen(false);
        }}
        isPending={archiveWorkspace.isPending}
      />
    </Sidebar>
  );
}
