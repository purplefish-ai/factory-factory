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
import { ExternalLink, GitPullRequest, Kanban, Loader2, Plus, Settings } from 'lucide-react';
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
import { ArchiveWorkspaceDialog } from '@/components/workspace';
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
import {
  ActiveWorkspaceItem,
  ArchivingWorkspaceItem,
  CreatingWorkspaceItem,
} from './workspace-sidebar-items';

const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? (match[1] as string) : null;
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
  const { needsAttention, clearAttention } = useWorkspaceAttention();

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

  // Use shared workspace creation hook, passing sidebar's existing names to avoid a redundant query
  const { handleCreate: createWorkspace } = useCreateWorkspace(
    selectedProjectId,
    selectedProjectSlug,
    existingNames
  );

  const handleCreateWorkspace = () => {
    if (!selectedProjectId || isCreating) {
      return;
    }
    // Generate unique name once and use it for both optimistic UI and actual creation
    const name = generateUniqueWorkspaceName(existingNames);
    startCreating(name);

    // Use shared creation logic with the same name (handles navigation and error toasts).
    // The optimistic placeholder auto-clears when the workspace appears in the server list
    // (managed by useWorkspaceListState). On error, the hook resets its own state and
    // cancelCreating below handles the placeholder.
    createWorkspace(name).catch(() => {
      // Error toast already shown by the hook; just remove the optimistic placeholder
      cancelCreating();
    });
  };

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

  // Clear attention glow when viewing a workspace
  useEffect(() => {
    if (currentWorkspaceId && needsAttention(currentWorkspaceId)) {
      clearAttention(currentWorkspaceId);
    }
  }, [currentWorkspaceId, needsAttention, clearAttention]);

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
      const firstSlug = projects[0]?.slug;
      if (!firstSlug) {
        return;
      }
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
                        return <CreatingWorkspaceItem key={workspace.id} />;
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
                          clearAttention={clearAttention}
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
  clearAttention,
}: {
  workspace: WorkspaceListItem;
  isActive: boolean;
  selectedProjectId?: string;
  selectedProjectSlug: string;
  onArchiveRequest: (workspace: WorkspaceListItem) => void;
  disableRatchetAnimation?: boolean;
  needsAttention: (workspaceId: string) => boolean;
  clearAttention: (workspaceId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isArchivingItem = workspace.uiState === 'archiving';

  // Archiving state: use dedicated component
  if (isArchivingItem) {
    return (
      <ArchivingWorkspaceItem
        workspace={workspace}
        selectedProjectSlug={selectedProjectSlug}
        sortableRef={setNodeRef}
        sortableStyle={style}
      />
    );
  }

  // Active workspace: use dedicated component
  return (
    <ActiveWorkspaceItem
      workspace={workspace}
      isActive={isActive}
      selectedProjectId={selectedProjectId}
      selectedProjectSlug={selectedProjectSlug}
      onArchiveRequest={onArchiveRequest}
      disableRatchetAnimation={disableRatchetAnimation}
      needsAttention={needsAttention}
      clearAttention={clearAttention}
      sortableRef={setNodeRef}
      sortableStyle={style}
      sortableAttributes={attributes}
      sortableListeners={listeners}
      isDragging={isDragging}
    />
  );
}

// Helper functions and components moved to workspace-sidebar-items.tsx

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
