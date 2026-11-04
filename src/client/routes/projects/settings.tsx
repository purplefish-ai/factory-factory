import { Navigate, useParams } from 'react-router';

/** Preserve bookmarked project settings URLs after moving the editors inline. */
export default function ProjectSettingsRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/admin/project?${new URLSearchParams({ project: slug ?? '' })}`} replace />;
}
