import { useParams } from 'react-router';
import { ProjectHeader } from '@/client/components/project-header';
import { getReviewRepository } from '@/client/hooks/use-project-review-requests';
import { trpc } from '@/client/lib/trpc';
import { ReviewDashboard } from './reviews/review-dashboard';
import { ReviewRouteState } from './reviews/route-state';

export default function ReviewsPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const project = trpc.project.getBySlug.useQuery({ slug }, { enabled: !!slug });
  if (!project.data) {
    return (
      <ReviewRouteState
        error={project.error?.message}
        onRetry={() => {
          void project.refetch();
        }}
        message={project.isLoading ? 'Loading project…' : 'Project not found'}
      />
    );
  }
  const repository = getReviewRepository(project.data);
  return (
    <>
      <ProjectHeader project={project.data} />
      {repository ? (
        <ReviewDashboard key={`${project.data.id}:${repository}`} project={project.data} />
      ) : (
        <ReviewRouteState
          message={
            project.data.githubOwner && project.data.githubRepo
              ? 'Invalid GitHub repository'
              : 'This project has no linked GitHub repository'
          }
        />
      )}
    </>
  );
}
