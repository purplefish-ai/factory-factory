'use client';

import { FolderKanban, ListTodo, Mail, Settings, Terminal } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { setProjectContext, trpc } from '../lib/trpc';

// Key for storing selected project in localStorage
const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

const icons: Record<string, React.ReactNode> = {
  folder: <FolderKanban className="h-5 w-5" />,
  list: <ListTodo className="h-5 w-5" />,
  mail: <Mail className="h-5 w-5" />,
  terminal: <Terminal className="h-5 w-5" />,
  settings: <Settings className="h-5 w-5" />,
};

// Extract project slug from URL if on a project-scoped page
function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? match[1] : null;
}

export function Navigation() {
  const pathname = usePathname();
  const router = useRouter();
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string>('');
  const [hasCheckedProjects, setHasCheckedProjects] = useState(false);

  const { data: projects, isLoading: projectsLoading } = trpc.project.list.useQuery({
    isArchived: false,
  });

  // Get the selected project's ID for scoped queries
  const selectedProjectId = projects?.find((p) => p.slug === selectedProjectSlug)?.id;

  // Set project context for tRPC headers when selectedProjectId changes
  useEffect(() => {
    if (selectedProjectId) {
      setProjectContext(selectedProjectId);
    }
  }, [selectedProjectId]);

  const { data: unreadCount } = trpc.mail.getUnreadCount.useQuery(undefined, {
    refetchInterval: 5000,
    enabled: !!selectedProjectId,
  });

  // Get project slug from URL or localStorage
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

  // Auto-select first project if none selected
  useEffect(() => {
    if (!projectsLoading && projects) {
      setHasCheckedProjects(true);

      if (projects.length === 0) {
        // No projects exist - redirect to create one (unless already there)
        if (!pathname.startsWith('/projects/new')) {
          router.push('/projects/new');
        }
      } else if (!selectedProjectSlug) {
        // No project selected, select the first one
        const firstSlug = projects[0].slug;
        setSelectedProjectSlug(firstSlug);
        localStorage.setItem(SELECTED_PROJECT_KEY, firstSlug);
      }
    }
  }, [projectsLoading, projects, selectedProjectSlug, pathname, router]);

  const handleProjectChange = (slug: string) => {
    setSelectedProjectSlug(slug);
    localStorage.setItem(SELECTED_PROJECT_KEY, slug);
    // Navigate to the new project's epics page
    router.push(`/projects/${slug}/epics`);
  };

  // Build nav items with project-scoped URLs
  const projectNavItems = selectedProjectSlug
    ? [
        { href: `/projects/${selectedProjectSlug}/epics`, label: 'Epics', icon: 'folder' },
        { href: `/projects/${selectedProjectSlug}/tasks`, label: 'Tasks', icon: 'list' },
        { href: `/projects/${selectedProjectSlug}/mail`, label: 'Mail', icon: 'mail' },
        { href: `/projects/${selectedProjectSlug}/logs`, label: 'Logs', icon: 'terminal' },
      ]
    : [];

  const globalNavItems = [{ href: '/admin', label: 'Admin', icon: 'settings' }];

  // Don't show loading state for project guard - just render
  if (!hasCheckedProjects) {
    return (
      <nav className="w-64 bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="p-4 border-b border-sidebar-border">
          <h1 className="text-xl font-bold">FactoryFactory</h1>
          <p className="text-xs text-muted-foreground mt-1">Loading...</p>
        </div>
      </nav>
    );
  }

  return (
    <nav className="w-64 bg-sidebar text-sidebar-foreground flex flex-col">
      <div className="p-4 border-b border-sidebar-border">
        <h1 className="text-xl font-bold">FactoryFactory</h1>
        <p className="text-xs text-muted-foreground mt-1">Autonomous Dev System</p>

        {/* Project Selector */}
        {projects && projects.length > 0 && (
          <div className="mt-3">
            <label htmlFor="project-select" className="text-xs text-muted-foreground block mb-1">
              Project
            </label>
            <Select value={selectedProjectSlug} onValueChange={handleProjectChange}>
              <SelectTrigger
                id="project-select"
                className="w-full bg-sidebar-accent border-sidebar-border text-sidebar-foreground focus:ring-sidebar-ring focus:border-sidebar-ring"
              >
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent className="bg-sidebar-accent border-sidebar-border">
                {projects.map((project) => (
                  <SelectItem
                    key={project.id}
                    value={project.slug}
                    className="text-sidebar-foreground focus:bg-sidebar focus:text-sidebar-foreground"
                  >
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Link
              href="/projects"
              className="text-xs text-sidebar-primary hover:text-sidebar-primary/80 mt-1 inline-block"
            >
              Manage projects
            </Link>
          </div>
        )}
      </div>

      <ul className="flex-1 py-4">
        {/* Project-scoped navigation */}
        {projectNavItems.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Button
                variant="ghost"
                asChild
                className={`w-full justify-start gap-3 px-4 py-3 h-auto rounded-none text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground ${
                  isActive ? 'bg-sidebar-accent border-l-4 border-sidebar-primary' : ''
                }`}
              >
                <Link href={item.href}>
                  {icons[item.icon]}
                  <span>{item.label}</span>
                  {item.icon === 'mail' && unreadCount && unreadCount.count > 0 && (
                    <Badge variant="destructive" className="ml-auto rounded-full px-2 py-0.5">
                      {unreadCount.count}
                    </Badge>
                  )}
                </Link>
              </Button>
            </li>
          );
        })}

        {/* Separator */}
        {projectNavItems.length > 0 && (
          <li className="my-2 mx-4">
            <Separator className="bg-sidebar-border" />
          </li>
        )}

        {/* Global navigation */}
        {globalNavItems.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Button
                variant="ghost"
                asChild
                className={`w-full justify-start gap-3 px-4 py-3 h-auto rounded-none text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground ${
                  isActive ? 'bg-sidebar-accent border-l-4 border-sidebar-primary' : ''
                }`}
              >
                <Link href={item.href}>
                  {icons[item.icon]}
                  <span>{item.label}</span>
                </Link>
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="p-4 border-t border-sidebar-border text-xs text-muted-foreground">
        <p>Phase 7: Production Ready</p>
      </div>
    </nav>
  );
}
