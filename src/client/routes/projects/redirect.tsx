import { Navigate, useParams } from 'react-router';

export default function ProjectRedirectPage() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/projects/${slug}/workspaces`} replace />;
}
