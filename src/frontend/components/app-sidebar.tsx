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
import { ExternalLink, GitPullRequest, Kanban, Loader2, Plus, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  useSidebar,
} from '@/components/ui/sidebar';
import { ArchiveWorkspaceDialog } from '@/components/workspace';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';
import { useCreateWorkspace } from '../hooks/use-create-workspace';
import { useWorkspaceAttention } from '../hooks/use-workspace-attention';
import { useProjectContext } from '../lib/providers';
import { trpc } from '../lib/trpc';
import { Logo, LogoIcon } from './logo';
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

function getInitialProjectSlug(mockData?: AppSidebarMockData): string {
  if (mockData?.selectedProjectSlug) {
    return mockData.selectedProjectSlug;
  }
  const slugFromPath = getProjectSlugFromPath(window.location.pathname);
  if (slugFromPath && slugFromPath !== 'new') {
    return slugFromPath;
  }
  return localStorage.getItem(SELECTED_PROJECT_KEY) || '';
}

/**
 * Syncs PR statuses when project changes
 */
function usePRStatusSync(
  selectedProjectId: string | undefined,
  isMocked: boolean,
  utils: ReturnType<typeof trpc.useUtils>
) {
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
}

/**
 * Manages project slug selection from URL and default fallback
 */
function useProjectSlugSync(
  pathname: string,
  isMocked: boolean,
  projects: Array<{ id: string; slug: string; name: string }> | undefined,
  selectedProjectSlug: string,
  setSelectedProjectSlug: (slug: string) => void
) {
  useEffect(() => {
    if (isMocked) {
      return;
    }

    const slugFromPath = getProjectSlugFromPath(pathname);
    const hasValidSlugInPath = slugFromPath && slugFromPath !== 'new';

    if (hasValidSlugInPath) {
      setSelectedProjectSlug(slugFromPath);
      localStorage.setItem(SELECTED_PROJECT_KEY, slugFromPath);
    } else {
      const stored = localStorage.getItem(SELECTED_PROJECT_KEY);
      if (stored) {
        setSelectedProjectSlug(stored);
      }
    }
  }, [isMocked, pathname, setSelectedProjectSlug]);

  // Select first project if none selected
  useEffect(() => {
    if (isMocked || !projects || projects.length === 0 || selectedProjectSlug) {
      return;
    }

    const firstSlug = projects[0]?.slug;
    if (firstSlug) {
      setSelectedProjectSlug(firstSlug);
      localStorage.setItem(SELECTED_PROJECT_KEY, firstSlug);
    }
  }, [isMocked, projects, selectedProjectSlug, setSelectedProjectSlug]);
}

type AppSidebarMockData = {
  projects: { id: string; slug: string; name: string }[];
  selectedProjectSlug?: string;
  projectState: {
    workspaces: ServerWorkspace[];
    reviewCount: number;
  };
};

/**
 * Sidebar header with logo, project selector, and close button (mobile only).
 * Mobile: icon logo + project dropdown + close button in a single row.
 * Desktop: text logo + project dropdown stacked vertically.
 */
function AppSidebarHeader({
  isMobile,
  onClose,
  projectSelector,
}: {
  isMobile: boolean;
  onClose: () => void;
  projectSelector: React.ReactNode;
}) {
  if (isMobile) {
    return (
      <SidebarHeader className="border-b border-sidebar-border px-3 py-3">
        <div className="flex items-center gap-3">
          <Link to="/projects" className="shrink-0">
            <LogoIcon className="size-10" />
          </Link>
          <div className="flex-1 min-w-0">{projectSelector}</div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md hover:bg-sidebar-accent transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </SidebarHeader>
    );
  }

  return (
    <SidebarHeader className="border-b border-sidebar-border p-4">
      <Link to="/projects">
        <Logo
          showIcon={false}
          textClassName="text-lg"
          className="hover:opacity-80 transition-opacity"
        />
      </Link>
      <div className="mt-3">{projectSelector}</div>
    </SidebarHeader>
  );
}

/**
 * Shared project selector dropdown used in both the mobile top bar and the desktop sidebar header.
 */
function ProjectSelectorDropdown({
  selectedProjectSlug,
  onProjectChange,
  projects,
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
}) {
  return (
    <Select value={selectedProjectSlug} onValueChange={onProjectChange}>
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
  );
}

/**
 * On mobile, portals the project selector into the top bar header slot.
 * On desktop, returns null (the selector is rendered inline in AppSidebarHeader).
 */
function MobileProjectSelector({
  isMobile,
  selectedProjectSlug,
  onProjectChange,
  projects,
}: {
  isMobile: boolean;
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
}) {
  const [mobileSlot, setMobileSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (isMobile) {
      setMobileSlot(document.getElementById('mobile-project-selector-slot'));
    }
  }, [isMobile]);

  if (!(isMobile && mobileSlot)) {
    return null;
  }

  return createPortal(
    <ProjectSelectorDropdown
      selectedProjectSlug={selectedProjectSlug}
      onProjectChange={onProjectChange}
      projects={projects}
    />,
    mobileSlot
  );
}

export function AppSidebar({ mockData }: { mockData?: AppSidebarMockData }) {
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const isMocked = Boolean(mockData);
  const { isMobile, setOpenMobile } = useSidebar();
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string>(() =>
    getInitialProjectSlug(mockData)
  );
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
  usePRStatusSync(selectedProjectId, isMocked, utils);

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
      await utils.userSettings.getWorkspaceOrder.cancel({ projectId });
      const previousOrder = utils.userSettings.getWorkspaceOrder.getData({ projectId });
      utils.userSettings.getWorkspaceOrder.setData({ projectId }, workspaceIds);
      return { previousOrder };
    },
    onError: (_error, { projectId }, context) => {
      const hasPreviousOrder = context?.previousOrder !== undefined;
      if (hasPreviousOrder) {
        utils.userSettings.getWorkspaceOrder.setData({ projectId }, context.previousOrder);
      }
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
      const canReorder = over && active.id !== over.id && selectedProjectId;
      if (!canReorder) {
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

  const handleCreateWorkspace = useCallback(() => {
    const canCreate = selectedProjectId && !isCreating;
    if (!canCreate) {
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
  }, [
    selectedProjectId,
    isCreating,
    existingNames,
    startCreating,
    createWorkspace,
    cancelCreating,
  ]);

  const archiveWorkspace = trpc.workspace.archive.useMutation({
    onSuccess: (_data, variables) => {
      utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
      // Archiving visual state is cleared automatically by useWorkspaceListState
      // when the workspace disappears from serverWorkspaces after invalidation.
      // If we archived the currently viewed workspace, navigate to the workspaces list
      const currentId = pathname.match(/\/workspaces\/([^/]+)/)?.[1];
      if (variables.id === currentId) {
        navigate(`/projects/${selectedProjectSlug}/workspaces`);
      }
    },
    onError: (error, variables) => {
      cancelArchiving(variables.id);
      toast.error(error.message);
    },
  });

  const executeArchive = useCallback(
    (workspaceId: string, commitUncommitted: boolean) => {
      startArchiving(workspaceId);
      archiveWorkspace.mutate({ id: workspaceId, commitUncommitted });
    },
    [startArchiving, archiveWorkspace]
  );

  const handleArchiveRequest = useCallback(
    (workspace: WorkspaceListItem) => {
      if (workspace.prState === 'MERGED') {
        // Always commit uncommitted changes when auto-archiving merged PRs
        // so we never lose work (gitStats may be null if not yet loaded).
        executeArchive(workspace.id, true);
      } else {
        setWorkspaceToArchive(workspace.id);
        setArchiveDialogOpen(true);
      }
    },
    [executeArchive]
  );

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
    const shouldClearAttention = currentWorkspaceId && needsAttention(currentWorkspaceId);
    if (shouldClearAttention) {
      clearAttention(currentWorkspaceId);
    }
  }, [currentWorkspaceId, needsAttention, clearAttention]);

  useEffect(() => {
    if (selectedProjectId) {
      setProjectContext(selectedProjectId);
    }
  }, [selectedProjectId, setProjectContext]);

  useProjectSlugSync(pathname, isMocked, projects, selectedProjectSlug, setSelectedProjectSlug);

  // Close mobile sidebar on navigation
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers sidebar close on route change
  useEffect(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [pathname, isMobile, setOpenMobile]);

  const handleProjectChange = useCallback(
    (value: string) => {
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
    },
    [navigate]
  );

  const globalNavItems = [
    { href: '/reviews', label: 'Reviews', icon: GitPullRequest },
    { href: '/admin', label: 'Admin', icon: Settings },
  ];

  return (
    <>
      <MobileProjectSelector
        isMobile={isMobile}
        selectedProjectSlug={selectedProjectSlug}
        onProjectChange={handleProjectChange}
        projects={projects}
      />

      <Sidebar collapsible={isMobile ? 'offcanvas' : 'none'}>
        <AppSidebarHeader
          isMobile={isMobile}
          onClose={() => setOpenMobile(false)}
          projectSelector={
            <ProjectSelectorDropdown
              selectedProjectSlug={selectedProjectSlug}
              onProjectChange={handleProjectChange}
              projects={projects}
            />
          }
        />

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
                <WorkspaceList
                  workspaceList={workspaceList}
                  currentWorkspaceId={currentWorkspaceId}
                  selectedProjectId={selectedProjectId}
                  selectedProjectSlug={selectedProjectSlug}
                  isKanbanView={isKanbanView}
                  needsAttention={needsAttention}
                  clearAttention={clearAttention}
                  onArchiveRequest={handleArchiveRequest}
                  sensors={sensors}
                  onDragEnd={handleDragEnd}
                  isMobile={isMobile}
                />
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
          onConfirm={(commitUncommitted) => {
            if (workspaceToArchive) {
              executeArchive(workspaceToArchive, commitUncommitted);
            }
          }}
        />
      </Sidebar>
    </>
  );
}

/**
 * Workspace list with sorting capability
 */
function WorkspaceList({
  workspaceList,
  currentWorkspaceId,
  selectedProjectId,
  selectedProjectSlug,
  isKanbanView,
  needsAttention,
  clearAttention,
  onArchiveRequest,
  sensors,
  onDragEnd,
  isMobile,
}: {
  workspaceList: WorkspaceListItem[];
  currentWorkspaceId: string | undefined;
  selectedProjectId: string | undefined;
  selectedProjectSlug: string;
  isKanbanView: boolean;
  needsAttention: (workspaceId: string) => boolean;
  clearAttention: (workspaceId: string) => void;
  onArchiveRequest: (workspace: WorkspaceListItem) => void;
  sensors: ReturnType<typeof useSensors>;
  onDragEnd: (event: DragEndEvent) => void;
  isMobile: boolean;
}) {
  const items = workspaceList.map((workspace) => {
    if (workspace.uiState === 'creating') {
      return <CreatingWorkspaceItem key={workspace.id} />;
    }

    return (
      <SortableWorkspaceItem
        key={workspace.id}
        workspace={workspace}
        isActive={currentWorkspaceId === workspace.id}
        selectedProjectId={selectedProjectId}
        selectedProjectSlug={selectedProjectSlug}
        onArchiveRequest={onArchiveRequest}
        disableRatchetAnimation={isKanbanView}
        needsAttention={needsAttention}
        clearAttention={clearAttention}
        disabled={isMobile}
      />
    );
  });

  const menu = (
    <SidebarMenu className="gap-2 p-1">
      {items}
      {workspaceList.length === 0 && (
        <div className="px-2 py-4 text-xs text-muted-foreground text-center">
          No active workspaces
        </div>
      )}
    </SidebarMenu>
  );

  if (isMobile) {
    return menu;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext
        items={workspaceList.filter((w) => w.uiState !== 'creating').map((w) => w.id)}
        strategy={verticalListSortingStrategy}
      >
        {menu}
      </SortableContext>
    </DndContext>
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
  disabled,
}: {
  workspace: WorkspaceListItem;
  isActive: boolean;
  selectedProjectId?: string;
  selectedProjectSlug: string;
  onArchiveRequest: (workspace: WorkspaceListItem) => void;
  disableRatchetAnimation?: boolean;
  needsAttention: (workspaceId: string) => boolean;
  clearAttention: (workspaceId: string) => void;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
    disabled,
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
      hideDragHandle={disabled}
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
