import { useCallback } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { githubPRPreviewInputSchema } from '@/shared/github-pr-preview';

/** Matches the server's review-request cache, so a poll rarely finds it fresh twice. */
export const REVIEW_REQUESTS_POLL_MS = 2 * 60_000;

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
  const projectId = project?.id ?? '';
  const query = trpc.prReview.listReviewRequests.useQuery(
    { projectId },
    {
      enabled: !!repository,
      staleTime: REVIEW_REQUESTS_POLL_MS,
      refetchInterval: REVIEW_REQUESTS_POLL_MS,
    }
  );
  const utils = trpc.useUtils();
  // Explicit refreshes bypass the server cache and gh health cache, then fill the shared key.
  const refresh = useCallback(async () => {
    try {
      const result = await utils.client.prReview.listReviewRequests.query({
        projectId,
        forceRefresh: true,
      });
      utils.prReview.listReviewRequests.setData({ projectId }, result);
    } catch {
      toast.error("Couldn't refresh reviews.");
    }
  }, [projectId, utils]);
  // Project metadata can change while this project-keyed response is cached.
  const health = query.data?.health;
  const unavailable =
    query.error || query.data?.error || (health && !(health.isInstalled && health.isAuthenticated));
  const prs =
    repository && !unavailable
      ? (query.data?.prs.filter((pr) => pr.repository.nameWithOwner.toLowerCase() === repository) ??
        [])
      : [];
  return { ...query, prs, repository, refresh };
}
