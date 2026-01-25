'use client';

import { FolderKanban, ListTodo, Mail, Settings, Terminal } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { setProjectContext, trpc } from '../lib/trpc';
import { Logo } from './logo';

const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? match[1] : null;
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

  useEffect(() => {
    if (selectedProjectId) {
      setProjectContext(selectedProjectId);
    }
  }, [selectedProjectId]);

  const { data: unreadCount } = trpc.mail.getUnreadCount.useQuery(undefined, {
    refetchInterval: 5000,
    enabled: !!selectedProjectId,
  });

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
    router.push(`/projects/${value}/epics`);
  };

  const projectNavItems = selectedProjectSlug
    ? [
        {
          href: `/projects/${selectedProjectSlug}/epics`,
          label: 'Top Tasks',
          icon: FolderKanban,
        },
        {
          href: `/projects/${selectedProjectSlug}/tasks`,
          label: 'Subtasks',
          icon: ListTodo,
        },
        {
          href: `/projects/${selectedProjectSlug}/mail`,
          label: 'Mail',
          icon: Mail,
          badge: unreadCount?.count,
        },
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
        <Logo iconClassName="size-6" textClassName="text-sm" />

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

      <SidebarContent>
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
                      {item.badge != null && item.badge > 0 && (
                        <SidebarMenuBadge>
                          <Badge variant="destructive" className="rounded-full px-1.5 py-0 text-xs">
                            {item.badge}
                          </Badge>
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
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
        <p className="text-xs text-muted-foreground">Phase 7: Production Ready</p>
      </SidebarFooter>
    </Sidebar>
  );
}
