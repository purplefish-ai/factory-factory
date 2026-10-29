import { Navigate, useLocation, useSearchParams } from 'react-router';
import { useAppNavigationDataContext } from '@/client/hooks/use-app-navigation-data';
import { getReviewRepository } from '@/client/hooks/use-project-review-requests';
import { getProjectSectionPath } from '@/client/lib/project-navigation';
import { resolveSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import { githubPRPreviewInputSchema } from '@/shared/github-pr-preview';
import { ReviewRouteState } from './route-state';

/** Resolve old repository links before mounting any review details or actions. */
export default function LegacyReviewsRoute() {
  const navigation = useAppNavigationDataContext();
  const [params] = useSearchParams();
  const location = useLocation();
  const repo = params.get('repo');
  if (navigation.projectsError) {
    return (
      <ReviewRouteState
        error={navigation.projectsError.message}
        onRetry={() => {
          void navigation.refetchProjects();
        }}
      />
    );
  }
  if (!navigation.projects) {
    return <ReviewRouteState message="Loading projects…" />;
  }
  if (repo !== null) {
    return <LegacyRepositoryReviews repo={repo} />;
  }
  const selected = navigation.projects.find(
    (project) => project.slug === navigation.selectedProjectSlug
  );
  const slug = selected?.slug ?? resolveSelectedProjectSlug(navigation.projects);
  return (
    <Navigate
      replace
      to={slug ? getProjectSectionPath(slug, 'reviews') + location.search : '/projects/new'}
    />
  );
}

function LegacyRepositoryReviews({ repo }: { repo: string }) {
  const navigation = useAppNavigationDataContext();
  const location = useLocation();
  const parsed = githubPRPreviewInputSchema.shape.repo.safeParse(repo);
  const repository = parsed.success ? parsed.data.toLowerCase() : null;
  const selected = navigation.projects?.find(
    (project) => project.slug === navigation.selectedProjectSlug
  );
  const activeOwner = repository
    ? [selected, ...(navigation.projects ?? [])].find(
        (project) => project && getReviewRepository(project) === repository
      )
    : undefined;
  const needsArchived = !!repository && !activeOwner;
  const archived = trpc.project.list.useQuery({ isArchived: true }, { enabled: needsArchived });
  if (!repository) {
    return <ReviewRouteState error="Invalid GitHub repository in review link" />;
  }
  if (needsArchived && archived.error) {
    return (
      <ReviewRouteState
        error={archived.error.message}
        onRetry={() => {
          void archived.refetch();
        }}
      />
    );
  }
  if (needsArchived && !archived.data) {
    return <ReviewRouteState message="Loading review project…" />;
  }
  const owner =
    activeOwner ?? archived.data?.find((project) => getReviewRepository(project) === repository);
  return owner ? (
    <Navigate replace to={getProjectSectionPath(owner.slug, 'reviews') + location.search} />
  ) : (
    <ReviewRouteState error="No configured project owns this review repository" />
  );
}
