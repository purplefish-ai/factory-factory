import { trpc } from '@/client/lib/trpc';
import { githubPRPreviewInputSchema } from '@/shared/github-pr-preview';

export interface ReviewProject {
  id: string;
  githubOwner: string | null;
  githubRepo: string | null;
}

export function getReviewRepository(project: ReviewProject | undefined): string | null {
  if (!(project?.githubOwner && project.githubRepo)) {
    return null;
  }
  const result = githubPRPreviewInputSchema.shape.repo.safeParse(
    `${project.githubOwner}/${project.githubRepo}`
  );
  return result.success ? result.data.toLowerCase() : null;
}

/** The page and sidebar share the same project key and freshness policy. */
export function useProjectReviewRequests(project: ReviewProject | undefined) {
  const repository = getReviewRepository(project);
  const query = trpc.prReview.listReviewRequests.useQuery(
    { projectId: project?.id ?? '' },
    { enabled: !!repository, staleTime: 30_000, refetchInterval: 30_000 }
  );
  // Project metadata can change while this project-keyed response is cached.
  const health = query.data?.health;
  const unavailable =
    query.error || query.data?.error || (health && !(health.isInstalled && health.isAuthenticated));
  const prs =
    repository && !unavailable
      ? (query.data?.prs.filter((pr) => pr.repository.nameWithOwner.toLowerCase() === repository) ??
        [])
      : [];
  return { ...query, prs, repository };
}
