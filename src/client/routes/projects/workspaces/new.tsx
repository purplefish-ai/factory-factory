import { Navigate, useParams } from 'react-router';
import { getProjectNewWorkspacePath } from '@/client/lib/project-navigation';

/**
 * `/projects/:slug/workspaces/new` used to be a standalone form. Workspaces are
 * now created from the board's inline form, so keep old links working by
 * opening that form instead.
 */
export default function NewWorkspaceRedirectPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  return <Navigate to={getProjectNewWorkspacePath(slug)} replace />;
}
