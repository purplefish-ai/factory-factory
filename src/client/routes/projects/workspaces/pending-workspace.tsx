import { Link, Navigate } from 'react-router';
import { Loading } from '@/client/components/loading';
import { usePendingWorkspace } from '@/client/lib/pending-workspace';
import { getProjectNewWorkspacePath, getProjectSectionPath } from '@/client/lib/project-navigation';

/** A selected launch stays local until the server has persisted a real workspace. */
export function PendingWorkspace({ id, slug }: { id: string; slug: string }) {
  const workspace = usePendingWorkspace(id);
  if (workspace?.status === 'created') {
    return (
      <Navigate
        to={`${getProjectSectionPath(slug, 'workspaces')}/${encodeURIComponent(workspace.workspaceId)}`}
        replace
      />
    );
  }
  if (workspace?.status === 'creating') {
    return <Loading message={`Creating ${workspace.name}…`} />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <p role="alert" className="text-sm text-muted-foreground">
        {workspace?.message ??
          'This launch is no longer available. Check the board for your workspace.'}
      </p>
      <Link className="text-sm underline" to={getProjectNewWorkspacePath(slug)}>
        Return to workspace form
      </Link>
    </div>
  );
}
