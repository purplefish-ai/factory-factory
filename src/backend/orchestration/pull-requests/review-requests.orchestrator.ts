import type { githubCLIService } from '@/backend/services/github';
import type { workspaceQueryService } from '@/backend/services/workspace';

export async function listVisibleReviewRequests(
  services: {
    githubCLIService: Pick<typeof githubCLIService, 'listReviewRequests'>;
    workspaceQueryService: Pick<typeof workspaceQueryService, 'filterReviewRequests'>;
  },
  repository?: string,
  options?: { forceRefresh?: boolean }
) {
  const prs = await services.githubCLIService.listReviewRequests(repository, options);
  const scoped = repository
    ? prs.filter((pr) => pr.repository.nameWithOwner.toLowerCase() === repository.toLowerCase())
    : prs;
  return services.workspaceQueryService.filterReviewRequests(scoped);
}
