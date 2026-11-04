import { Link, NavLink } from 'react-router';
import { cn } from '@/lib/utils';

export const SETTINGS_SECTIONS = [
  { path: '/admin', label: 'General' },
  { path: '/admin/workspace', label: 'Workspace' },
  { path: '/admin/integrations', label: 'Integrations' },
  { path: '/admin/appearance', label: 'Appearance' },
  { path: '/admin/voice', label: 'Voice' },
  { path: '/admin/system', label: 'System' },
  { path: '/admin/logs', label: 'Server logs' },
  { path: '/admin/project', label: 'Project settings' },
];

export function SettingsTabsList({ projectSettings = false }: { projectSettings?: boolean }) {
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-1 border-b pb-3">
      {SETTINGS_SECTIONS.map(({ path, label }) =>
        projectSettings && path === '/admin/project' ? (
          <Link
            key={path}
            to={path}
            aria-current="page"
            className="rounded-md bg-muted px-3 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-ring"
          >
            {label}
          </Link>
        ) : (
          <NavLink
            key={path}
            to={path}
            end
            className={({ isActive }) =>
              cn(
                'rounded-md px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-ring',
                isActive ? 'bg-muted text-foreground' : 'text-muted-foreground'
              )
            }
          >
            {label}
          </NavLink>
        )
      )}
    </nav>
  );
}
