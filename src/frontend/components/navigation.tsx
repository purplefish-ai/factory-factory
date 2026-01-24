'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { trpc } from '../lib/trpc';

// Key for storing selected project in localStorage
const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

const icons: Record<string, React.ReactNode> = {
  home: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
      />
    </svg>
  ),
  folder: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      />
    </svg>
  ),
  list: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
      />
    </svg>
  ),
  cpu: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
      />
    </svg>
  ),
  mail: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
      />
    </svg>
  ),
  terminal: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  ),
  settings: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  ),
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

  const { data: unreadCount } = trpc.mail.getUnreadCount.useQuery(
    { projectId: selectedProjectId },
    {
      refetchInterval: 5000,
      enabled: !!selectedProjectId,
    }
  );

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
      <nav className="w-64 bg-gray-900 text-white flex flex-col">
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-xl font-bold">FactoryFactory</h1>
          <p className="text-xs text-gray-400 mt-1">Loading...</p>
        </div>
      </nav>
    );
  }

  return (
    <nav className="w-64 bg-gray-900 text-white flex flex-col">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-xl font-bold">FactoryFactory</h1>
        <p className="text-xs text-gray-400 mt-1">Autonomous Dev System</p>

        {/* Project Selector */}
        {projects && projects.length > 0 && (
          <div className="mt-3">
            <label htmlFor="project-select" className="text-xs text-gray-400 block mb-1">
              Project
            </label>
            <select
              id="project-select"
              value={selectedProjectSlug}
              onChange={(e) => handleProjectChange(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.slug}>
                  {project.name}
                </option>
              ))}
            </select>
            <Link
              href="/projects"
              className="text-xs text-blue-400 hover:text-blue-300 mt-1 inline-block"
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
              <Link
                href={item.href}
                className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-800 transition-colors ${
                  isActive ? 'bg-gray-800 border-l-4 border-blue-500' : ''
                }`}
              >
                {icons[item.icon]}
                <span>{item.label}</span>
                {item.icon === 'mail' && unreadCount && unreadCount.count > 0 && (
                  <span className="ml-auto bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                    {unreadCount.count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}

        {/* Separator */}
        {projectNavItems.length > 0 && <li className="my-2 mx-4 border-t border-gray-700" />}

        {/* Global navigation */}
        {globalNavItems.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-800 transition-colors ${
                  isActive ? 'bg-gray-800 border-l-4 border-blue-500' : ''
                }`}
              >
                {icons[item.icon]}
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="p-4 border-t border-gray-700 text-xs text-gray-400">
        <p>Phase 7: Production Ready</p>
      </div>
    </nav>
  );
}
