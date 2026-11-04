import { Link } from 'react-router';
import type { ProjectIssuesStatus } from '@/client/hooks/use-project-issues';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from './empty-state';
import { QueryErrorState } from './query-error-state';

/** Inline issue recovery shared by Todo on the board and in the sidebar. */
export function ProjectIssuesState({
  status,
  error,
  projectSlug,
  onRetry,
  isRetrying,
  filtered = false,
}: {
  status: ProjectIssuesStatus | undefined;
  error?: string | null;
  projectSlug: string;
  onRetry: () => void;
  isRetrying?: boolean;
  filtered?: boolean;
}) {
  if (status === 'no-project') {
    return (
      <EmptyState
        size="compact"
        title="Choose a project"
        description="Select or create a project to see assigned issues."
        action={
          <Link className="text-xs underline" to="/projects/new">
            New project
          </Link>
        }
      />
    );
  }
  if (status === 'loading') {
    return (
      <div role="status" aria-label="Loading issues" className="space-y-2 p-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  const settings = projectSlug ? (
    <Link className="block text-xs text-center underline" to={`/projects/${projectSlug}/settings`}>
      Project settings
    </Link>
  ) : null;
  if (status === 'error') {
    return (
      <div>
        <QueryErrorState
          title="Couldn't load issues"
          error={error ? { message: error } : null}
          onRetry={onRetry}
          isRetrying={isRetrying}
          className="p-2"
        />
        {settings}
      </div>
    );
  }
  if (status === 'not-connected') {
    return (
      <EmptyState
        size="compact"
        title="Issue provider not connected"
        description="Connect an issue provider to see assigned issues"
        action={settings}
      />
    );
  }
  return (
    <EmptyState size="compact" title={filtered ? 'No matching issues' : 'No assigned issues'} />
  );
}
