import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Archive,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  GripVertical,
  Kanban,
  Loader2,
  Plus,
  Settings,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
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
import { ArchiveWorkspaceDialog, RatchetToggleButton } from '@/components/workspace';
import { cn, formatRelativeTime, shouldShowRatchetAnimation } from '@/lib/utils';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';
import { useCreateWorkspace } from '../hooks/use-create-workspace';
import { useWorkspaceAttention } from '../hooks/use-workspace-attention';
import { useProjectContext } from '../lib/providers';
import { trpc } from '../lib/trpc';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';
import {
  type ServerWorkspace,
  useWorkspaceListState,
  type WorkspaceListItem,
} from './use-workspace-list-state';

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

/**
 * Get tooltip text explaining the status dot color.
 * Uses same priority as getStatusDotClass.
 */
function getStatusTooltip(workspace: WorkspaceListItem): string {
  if (workspace.isWorking) {
    return 'Claude is working';
  }
  if (workspace.prState === 'MERGED') {
    return 'PR merged';
  }
  if (workspace.prCiStatus === 'FAILURE') {
    return 'CI checks failing';
  }
  if (workspace.prCiStatus === 'PENDING') {
    return 'CI checks running';
  }
  if (workspace.prCiStatus === 'SUCCESS') {
    return 'CI checks passing';
  }
  if (workspace.gitStats?.hasUncommitted) {
    return 'Uncommitted changes';
  }
  return 'Ready';
}

type AppSidebarMockData = {
  projects: { id: string; slug: string; name: string }[];
  selectedProjectSlug?: string;
  projectState: {
    workspaces: ServerWorkspace[];
    reviewCount: number;
  };
};

export function AppSidebar({ mockData }: { mockData?: AppSidebarMockData }) {
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const isMocked = Boolean(mockData);
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string>(() => {
    if (mockData?.selectedProjectSlug) {
      return mockData.selectedProjectSlug;
    }
    const slugFromPath = getProjectSlugFromPath(window.location.pathname);
    if (slugFromPath && slugFromPath !== 'new') {
      return slugFromPath;
    }
    return localStorage.getItem(SELECTED_PROJECT_KEY) || '';
  });
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [workspaceToArchive, setWorkspaceToArchive] = useState<string | null>(null);
  const { setProjectContext } = useProjectContext();

  const { data: projectsData } = trpc.project.list.useQuery(
    { isArchived: false },
    { enabled: !isMocked }
  );
  const projects = mockData?.projects ?? projectsData;

  const selectedProjectId = projects?.find((p) => p.slug === selectedProjectSlug)?.id;

  // Fetch unified project summary state (workspaces + working status + git stats + review count)
  const { data: projectStateData } = trpc.workspace.getProjectSummaryState.useQuery(
    { projectId: selectedProjectId ?? '' },
    { enabled: !!selectedProjectId && !isMocked, refetchInterval: isMocked ? false : 2000 }
  );
  const projectState = mockData?.projectState ?? projectStateData;

  const serverWorkspaces = projectState?.workspaces;
  const reviewCount = projectState?.reviewCount ?? 0;

  // Fetch workspace order for the selected project
  const { data: workspaceOrder } = trpc.userSettings.getWorkspaceOrder.useQuery(
    { projectId: selectedProjectId ?? '' },
    { enabled: !!selectedProjectId && !isMocked }
  );

  const utils = trpc.useUtils();

  // Sync PR statuses from GitHub once when project changes
  const syncAllPRStatuses = trpc.workspace.syncAllPRStatuses.useMutation({
    onSuccess: () => {
      utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
    },
  });
  const lastSyncedProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (isMocked) {
      return;
    }
    if (selectedProjectId && selectedProjectId !== lastSyncedProjectRef.current) {
      lastSyncedProjectRef.current = selectedProjectId;
      syncAllPRStatuses.mutate({ projectId: selectedProjectId });
    }
  }, [isMocked, selectedProjectId, syncAllPRStatuses]);

  // Track workspaces that need user attention (for red glow)
  const { needsAttention } = useWorkspaceAttention();

  // Use the workspace list state management hook
  const {
    workspaceList,
    existingNames,
    isCreating,
    startCreating,
    cancelCreating,
    startArchiving,
    cancelArchiving,
  } = useWorkspaceListState(serverWorkspaces, {
    customOrder: isMocked ? undefined : workspaceOrder,
  });

  // Mutation to update workspace order with optimistic updates
  const updateWorkspaceOrder = trpc.userSettings.updateWorkspaceOrder.useMutation({
    onMutate: async ({ projectId, workspaceIds }) => {
      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await utils.userSettings.getWorkspaceOrder.cancel({ projectId });

      // Snapshot the previous value
      const previousOrder = utils.userSettings.getWorkspaceOrder.getData({ projectId });

      // Optimistically update to the new value
      utils.userSettings.getWorkspaceOrder.setData({ projectId }, workspaceIds);

      // Return context with the previous value for rollback
      return { previousOrder };
    },
    onError: (_error, { projectId }, context) => {
      // Roll back to the previous value on error
      if (context?.previousOrder !== undefined) {
        utils.userSettings.getWorkspaceOrder.setData({ projectId }, context.previousOrder);
      }
      // Refetch to ensure we're in sync with server after error
      utils.userSettings.getWorkspaceOrder.invalidate({ projectId });
    },
  });

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px of movement before starting drag
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Handle drag end - persist new order
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (!over || active.id === over.id || !selectedProjectId) {
        return;
      }

      // Get current workspace IDs (excluding creating placeholder)
      const currentIds = workspaceList.filter((w) => w.uiState !== 'creating').map((w) => w.id);

      const oldIndex = currentIds.indexOf(active.id as string);
      const newIndex = currentIds.indexOf(over.id as string);

      if (oldIndex === -1 || newIndex === -1) {
        return;
      }

      // Reorder the array
      const newOrder = [...currentIds];
      newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, active.id as string);

      // Persist the new order
      updateWorkspaceOrder.mutate({
        projectId: selectedProjectId,
        workspaceIds: newOrder,
      });
    },
    [workspaceList, selectedProjectId, updateWorkspaceOrder]
  );

  // Use shared workspace creation hook
  const { handleCreate: createWorkspace, isCreating: isCreatingWorkspace } = useCreateWorkspace(
    selectedProjectId,
    selectedProjectSlug
  );

  const handleCreateWorkspace = () => {
    if (!selectedProjectId || isCreating || isCreatingWorkspace) {
      return;
    }
    // Generate unique name once and use it for both optimistic UI and actual creation
    // Use existingNames from useWorkspaceListState
    const name = generateUniqueWorkspaceName(existingNames);
    startCreating(name);

    // Use shared creation logic with the same name (handles success navigation and error toasts)
    createWorkspace(name);
  };

  // Clean up optimistic placeholder if creation fails
  // (on success, the workspace appears in server list and placeholder auto-clears)
  useEffect(() => {
    if (!isCreatingWorkspace && isCreating) {
      cancelCreating();
    }
  }, [isCreatingWorkspace, isCreating, cancelCreating]);

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
    onError: (error, variables) => {
      cancelArchiving(variables.id);
      toast.error(error.message);
    },
  });

  const handleArchiveRequest = (workspace: WorkspaceListItem) => {
    setWorkspaceToArchive(workspace.id);
    setArchiveDialogOpen(true);
  };

  const workspacePendingArchive = workspaceToArchive
    ? serverWorkspaces?.find((workspace) => workspace.id === workspaceToArchive)
    : null;
  const archiveHasUncommitted = workspacePendingArchive?.gitStats?.hasUncommitted === true;

  // Get current workspace ID from URL
  const currentWorkspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1];
  // Check if we're on the kanban view (workspaces list page without a specific workspace)
  const isKanbanView = pathname.endsWith('/workspaces') || pathname.endsWith('/workspaces/');

  useEffect(() => {
    if (selectedProjectId) {
      setProjectContext(selectedProjectId);
    }
  }, [selectedProjectId, setProjectContext]);

  useEffect(() => {
    if (isMocked) {
      return;
    }
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
  }, [isMocked, pathname]);

  // Select first project if none selected
  useEffect(() => {
    if (isMocked) {
      return;
    }
    if (projects && projects.length > 0 && !selectedProjectSlug) {
      const firstSlug = projects[0].slug;
      setSelectedProjectSlug(firstSlug);
      localStorage.setItem(SELECTED_PROJECT_KEY, firstSlug);
    }
  }, [isMocked, projects, selectedProjectSlug]);

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
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={workspaceList.filter((w) => w.uiState !== 'creating').map((w) => w.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <SidebarMenu className="gap-2 p-1">
                    {workspaceList.map((workspace) => {
                      const isCreatingItem = workspace.uiState === 'creating';

                      // Creating placeholder - non-clickable, not sortable
                      if (isCreatingItem) {
                        return (
                          <SidebarMenuItem key={workspace.id}>
                            <SidebarMenuButton size="lg" className="px-2 cursor-default">
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
                        <SortableWorkspaceItem
                          key={workspace.id}
                          workspace={workspace}
                          isActive={currentWorkspaceId === workspace.id}
                          selectedProjectId={selectedProjectId}
                          selectedProjectSlug={selectedProjectSlug}
                          onArchiveRequest={handleArchiveRequest}
                          disableRatchetAnimation={isKanbanView}
                          needsAttention={needsAttention}
                        />
                      );
                    })}
                    {workspaceList.length === 0 && (
                      <div className="px-2 py-4 text-xs text-muted-foreground text-center">
                        No active workspaces
                      </div>
                    )}
                  </SidebarMenu>
                </SortableContext>
              </DndContext>
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

      <SidebarFooter className="border-t border-sidebar-border px-4 py-2">
        {!isMocked && <ServerPortInfo />}
        <div className="flex items-center justify-between">
          <a
            href="https://github.com/purplefish-ai/factory-factory"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
          >
            GitHub
            <ExternalLink className="h-3 w-3" />
          </a>
          <ThemeToggle />
        </div>
      </SidebarFooter>

      <ArchiveWorkspaceDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        hasUncommitted={archiveHasUncommitted}
        isPending={archiveWorkspace.isPending}
        onConfirm={(commitUncommitted) => {
          if (workspaceToArchive) {
            // Start archiving state management (optimistic UI)
            startArchiving(workspaceToArchive);
            archiveWorkspace.mutate({
              id: workspaceToArchive,
              commitUncommitted,
            });
          }
        }}
      />
    </Sidebar>
  );
}

/**
 * Sortable workspace item component for drag and drop reordering
 */
function SortableWorkspaceItem({
  workspace,
  isActive,
  selectedProjectId,
  selectedProjectSlug,
  onArchiveRequest,
  disableRatchetAnimation,
  needsAttention,
}: {
  workspace: WorkspaceListItem;
  isActive: boolean;
  selectedProjectId?: string;
  selectedProjectSlug: string;
  onArchiveRequest: (workspace: WorkspaceListItem) => void;
  disableRatchetAnimation?: boolean;
  needsAttention: (workspaceId: string) => boolean;
}) {
  const utils = trpc.useUtils();
  const toggleRatcheting = trpc.workspace.toggleRatcheting.useMutation({
    onSuccess: () => {
      if (selectedProjectId) {
        utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
        utils.workspace.listWithKanbanState.invalidate({ projectId: selectedProjectId });
      }
      utils.workspace.get.invalidate({ id: workspace.id });
    },
  });

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isArchivingItem = workspace.uiState === 'archiving';
  const { gitStats: stats } = workspace;
  const ratchetEnabled = workspace.ratchetEnabled ?? true;
  const { showAttentionGlow } = getSidebarAttentionState(
    workspace,
    Boolean(disableRatchetAnimation),
    needsAttention
  );

  return (
    <SidebarMenuItem ref={setNodeRef} style={style}>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        className={cn(
          'h-auto px-2 py-2.5',
          isArchivingItem && 'opacity-50 pointer-events-none',
          isDragging && 'opacity-50 bg-sidebar-accent',
          showAttentionGlow && 'waiting-pulse'
        )}
      >
        <Link to={`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`}>
          <div className="flex w-full min-w-0 items-start gap-2">
            {/* Drag handle */}
            <button
              type="button"
              className="w-4 shrink-0 flex justify-center mt-2 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground bg-transparent border-none p-0"
              aria-label="Drag to reorder"
              {...attributes}
              {...listeners}
              onClick={(e) => {
                // Prevent click from propagating to the Link and triggering navigation
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <GripVertical className="h-3 w-3" />
            </button>

            {/* Status dot + ratchet toggle */}
            <div className="w-5 shrink-0 mt-1.5 flex flex-col items-center gap-1.5">
              {isArchivingItem ? (
                <Loader2 className="h-2 w-2 text-muted-foreground animate-spin" />
              ) : (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={cn('h-2 w-2 rounded-full', getStatusDotClass(workspace))} />
                    </TooltipTrigger>
                    <TooltipContent side="right">{getStatusTooltip(workspace)}</TooltipContent>
                  </Tooltip>
                  <RatchetToggleButton
                    enabled={ratchetEnabled}
                    state={workspace.ratchetState}
                    className="h-5 w-5 shrink-0"
                    disabled={toggleRatcheting.isPending}
                    stopPropagation
                    onToggle={(enabled) => {
                      toggleRatcheting.mutate({ workspaceId: workspace.id, enabled });
                    }}
                  />
                </>
              )}
            </div>

            <div className="min-w-0 flex-1 space-y-0">
              {/* Row 1: name + timestamp + archive */}
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-sm leading-tight flex-1">
                  {isArchivingItem ? 'Archiving...' : workspace.name}
                </span>
                {workspace.lastActivityAt && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(workspace.lastActivityAt)}
                  </span>
                )}
                {/* Archive button (hover for non-merged, always visible for merged PRs) */}
                {!isArchivingItem && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onArchiveRequest(workspace);
                        }}
                        className={cn(
                          'shrink-0 h-6 w-6 flex items-center justify-center rounded transition-opacity',
                          workspace.prState === 'MERGED'
                            ? 'opacity-100 text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25'
                            : workspace.prState === 'CLOSED'
                              ? 'opacity-100 text-yellow-500 hover:text-yellow-400 hover:bg-yellow-500/10'
                              : 'opacity-0 group-hover/menu-item:opacity-100 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent'
                        )}
                      >
                        <Archive className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Archive</TooltipContent>
                  </Tooltip>
                )}
              </div>

              {/* Row 2: branch name */}
              {!isArchivingItem && workspace.branchName && (
                <div className="truncate text-[11px] leading-tight text-muted-foreground font-mono">
                  {workspace.branchName}
                </div>
              )}

              {/* Row 3: files changed + deltas + PR */}
              <WorkspaceMetaRow workspace={workspace} stats={stats} />
            </div>
          </div>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function WorkspaceMetaRow({
  workspace,
  stats,
}: {
  workspace: WorkspaceListItem;
  stats: WorkspaceListItem['gitStats'];
}) {
  const hasStats = Boolean(
    stats && (stats.additions > 0 || stats.deletions > 0 || stats.total > 0)
  );
  const showPR = Boolean(workspace.prNumber && workspace.prState !== 'NONE' && workspace.prUrl);
  if (!(hasStats || showPR)) {
    return null;
  }

  const filesText = hasStats && stats?.total ? `${stats.total} files` : '';
  const additionsText = hasStats && stats?.additions ? `+${stats.additions}` : '';
  const deletionsText = hasStats && stats?.deletions ? `-${stats.deletions}` : '';

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_40px_40px_72px] items-center gap-x-2 text-xs text-muted-foreground">
      <span className="truncate">{filesText}</span>
      <span className="w-10 text-right tabular-nums text-green-600 dark:text-green-400">
        {additionsText}
      </span>
      <span className="w-10 text-left tabular-nums text-red-600 dark:text-red-400">
        {deletionsText}
      </span>
      {showPR ? <WorkspacePrButton workspace={workspace} /> : <WorkspacePrSpacer />}
    </div>
  );
}

function WorkspacePrSpacer() {
  return <span className="w-[72px]" aria-hidden="true" />;
}

function WorkspacePrButton({ workspace }: { workspace: WorkspaceListItem }) {
  const tooltipSuffix = getPrTooltipSuffix(workspace);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (workspace.prUrl) {
              window.open(workspace.prUrl, '_blank', 'noopener,noreferrer');
            }
          }}
          className={cn(
            'flex w-[72px] items-center justify-end gap-1 text-xs hover:opacity-80 transition-opacity p-0',
            workspace.prState === 'MERGED'
              ? 'text-green-500'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <GitPullRequest className="h-3 w-3" />
          <span>#{workspace.prNumber}</span>
          {workspace.prState === 'MERGED' ? (
            <CheckCircle2 className="h-3 w-3 text-green-500" />
          ) : (
            <CheckCircle2 className="h-3 w-3 opacity-0" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>
          PR #{workspace.prNumber}
          {tooltipSuffix}
        </p>
        <p className="text-xs text-muted-foreground">Click to open on GitHub</p>
      </TooltipContent>
    </Tooltip>
  );
}

function getPrTooltipSuffix(workspace: WorkspaceListItem) {
  if (workspace.prState === 'MERGED') {
    return ' · Merged';
  }
  if (workspace.prState === 'CLOSED') {
    return ' · Closed';
  }
  if (workspace.prCiStatus === 'SUCCESS') {
    return ' · CI passed';
  }
  if (workspace.prCiStatus === 'FAILURE') {
    return ' · CI failed';
  }
  if (workspace.prCiStatus === 'PENDING') {
    return ' · CI running';
  }
  return '';
}

function getSidebarAttentionState(
  workspace: WorkspaceListItem,
  disableRatchetAnimation: boolean,
  needsAttention: (workspaceId: string) => boolean
) {
  const isDone = workspace.cachedKanbanColumn === 'DONE';
  const isRatchetActive =
    !(disableRatchetAnimation || isDone) &&
    shouldShowRatchetAnimation(workspace.ratchetState, workspace.ratchetLastPushAt);

  return {
    showAttentionGlow: needsAttention(workspace.id) && !isRatchetActive,
  };
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
