import type { githubCLIService } from '@/backend/services/github';
import type { workspaceQueryService } from '@/backend/services/workspace';

export async function listVisibleReviewRequests(services: {
  githubCLIService: Pick<typeof githubCLIService, 'listReviewRequests'>;
  workspaceQueryService: Pick<typeof workspaceQueryService, 'filterReviewRequests'>;
}) {
  const prs = await services.githubCLIService.listReviewRequests();
  return services.workspaceQueryService.filterReviewRequests(prs);
}
