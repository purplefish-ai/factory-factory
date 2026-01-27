'use client';

import { GitBranch, Kanban, Plus, Settings, Terminal } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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
import { setProjectContext, trpc } from '../lib/trpc';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';

const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? match[1] : null;
}

function generateWorkspaceName(): string {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'short' }).toLowerCase();
  const day = now.getDate();
  const hour = now.getHours();
  const min = now.getMinutes().toString().padStart(2, '0');
  return `workspace-${month}${day}-${hour}${min}`;
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string>('');
  const [hasCheckedProjects, setHasCheckedProjects] = useState(false);

  const { data: projects, isLoading: projectsLoading } = trpc.project.list.useQuery({
    isArchived: false,
  });

  const selectedProjectId = projects?.find((p) => p.slug === selectedProjectSlug)?.id;

  // Fetch workspaces for the selected project
  const { data: workspaces } = trpc.workspace.list.useQuery(
    { projectId: selectedProjectId ?? '', status: 'ACTIVE' },
    { enabled: !!selectedProjectId, refetchInterval: 5000 }
  );

  // Fetch working status for all workspaces
  const workspaceIds = workspaces?.map((w) => w.id) ?? [];
  const { data: workingStatus } = trpc.session.getWorkspacesWorkingStatus.useQuery(
    { workspaceIds },
    { enabled: workspaceIds.length > 0, refetchInterval: 1000 }
  );

  const utils = trpc.useUtils();

  const createWorkspace = trpc.workspace.create.useMutation();

  const handleCreateWorkspace = async () => {
    if (!selectedProjectId) {
      return;
    }
    const name = generateWorkspaceName();

    // Create workspace (branchName defaults to project's default branch)
    // Don't create a session - user will choose workflow in workspace page
    const workspace = await createWorkspace.mutateAsync({
      projectId: selectedProjectId,
      name,
    });

    // Invalidate workspace list cache
    utils.workspace.list.invalidate({ projectId: selectedProjectId });

    // Navigate to workspace (workflow selection will be shown)
    router.push(`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`);
  };

  // Get current workspace ID from URL
  const currentWorkspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1];
  const isCreatingWorkspace = createWorkspace.isPending;

  useEffect(() => {
    if (selectedProjectId) {
      setProjectContext(selectedProjectId);
    }
  }, [selectedProjectId]);

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
          router.push('/projects/new');
        }
      } else if (!selectedProjectSlug) {
        const firstSlug = projects[0].slug;
        setSelectedProjectSlug(firstSlug);
        localStorage.setItem(SELECTED_PROJECT_KEY, firstSlug);
      }
    }
  }, [projectsLoading, projects, selectedProjectSlug, pathname, router]);

  const handleProjectChange = (value: string) => {
    if (value === '__manage__') {
      router.push('/projects');
      return;
    }
    if (value === '__create__') {
      router.push('/projects/new');
      return;
    }
    setSelectedProjectSlug(value);
    localStorage.setItem(SELECTED_PROJECT_KEY, value);
    router.push(`/projects/${value}/workspaces`);
  };

  const projectNavItems = selectedProjectSlug
    ? [
        {
          href: `/projects/${selectedProjectSlug}/logs`,
          label: 'Logs',
          icon: Terminal,
        },
      ]
    : [];

  const globalNavItems = [{ href: '/admin', label: 'Admin', icon: Settings }];

  // Show loading skeleton while checking for projects
  if (!hasCheckedProjects) {
    return (
      <Sidebar collapsible="none">
        <SidebarHeader className="border-b border-sidebar-border p-4">
          <Logo iconClassName="size-6" textClassName="text-sm" />
          <p className="text-xs text-muted-foreground mt-1">Loading...</p>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <div className="space-y-2 p-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
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
        {selectedProjectSlug ? (
          <Link href={`/projects/${selectedProjectSlug}/workspaces`}>
            <Logo
              iconClassName="size-6"
              textClassName="text-sm"
              className="hover:opacity-80 transition-opacity"
            />
          </Link>
        ) : (
          <Logo iconClassName="size-6" textClassName="text-sm" />
        )}

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
                href={`/projects/${selectedProjectSlug}/workspaces`}
                className="hover:text-foreground transition-colors"
              >
                Workspaces
              </Link>
            </SidebarGroupLabel>
            <div className="absolute right-1 top-2 flex items-center gap-0.5">
              <Link
                href={`/projects/${selectedProjectSlug}/workspaces`}
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
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <SidebarGroupContent className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
              <SidebarMenu>
                {workspaces?.map((workspace) => {
                  const isActive = currentWorkspaceId === workspace.id;
                  return (
                    <SidebarMenuItem key={workspace.id}>
                      <SidebarMenuButton asChild isActive={isActive} className="h-auto py-2">
                        <Link href={`/projects/${selectedProjectSlug}/workspaces/${workspace.id}`}>
                          <div className="flex flex-col gap-0.5 w-0 flex-1 overflow-hidden">
                            <div className="flex items-center gap-1.5">
                              {workspace.branchName && (
                                <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                              )}
                              <span className="truncate font-medium text-sm">
                                {workspace.branchName || workspace.name}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="truncate">{workspace.name}</span>
                              {workingStatus?.[workspace.id] && (
                                <>
                                  <span>·</span>
                                  <span className="text-green-500">Working...</span>
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

        {/* Other nav items */}
        {projectNavItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {projectNavItems.map((item) => {
                  const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive}>
                        <Link href={item.href}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {globalNavItems.map((item) => {
                const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.href}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
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
    </Sidebar>
  );
}
