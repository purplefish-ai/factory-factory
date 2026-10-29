import { createLogger } from '@/backend/services/logger.service';
import { githubPRPreviewInputSchema } from '@/shared/github-pr-preview';
import { GH_TIMEOUT_MS } from './constants';
import { reviewRequestedPRGraphQLSchema } from './schemas';
import type { ReviewRequestedPR } from './types';

const logger = createLogger('github-cli');

export async function listReviewRequests(
  exec: (args: string[], options?: { timeout?: number }) => Promise<{ stdout: string }>,
  repository?: string
): Promise<ReviewRequestedPR[]> {
  if (
    repository !== undefined &&
    !githubPRPreviewInputSchema.shape.repo.safeParse(repository).success
  ) {
    throw new Error('Invalid GitHub repository');
  }
  const searchText = `is:pr is:open review-requested:@me archived:false${repository ? ` repo:${repository}` : ''}`;
  const MAX_PAGES = 20;
  const prs: ReviewRequestedPR[] = [];
  let afterCursor: string | null = null;
  let hasNextPage = true;

  for (let page = 1; page <= MAX_PAGES && hasNextPage; page++) {
    const afterClause = afterCursor ? `, after: ${JSON.stringify(afterCursor)}` : '';
    const query = `
        query {
          search(query: ${JSON.stringify(searchText)}, type: ISSUE, first: 50${afterClause}) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ... on PullRequest {
                number title url isDraft createdAt
                author { login }
                repository { nameWithOwner }
                reviewDecision
                additions deletions changedFiles
              }
            }
          }
        }
      `;

    const { stdout } = await exec(['api', 'graphql', '-f', `query=${query}`], {
      timeout: GH_TIMEOUT_MS.default,
    });

    const parsed = reviewRequestedPRGraphQLSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      logger.warn('Failed to parse listReviewRequests GraphQL response', {
        error: parsed.error.message,
      });
      return prs;
    }

    prs.push(
      ...parsed.data.data.search.nodes.map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        repository: { nameWithOwner: pr.repository.nameWithOwner },
        author: { login: pr.author?.login ?? '' },
        createdAt: pr.createdAt,
        isDraft: pr.isDraft,
        reviewDecision: (pr.reviewDecision as ReviewRequestedPR['reviewDecision']) ?? null,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changedFiles ?? 0,
      }))
    );

    hasNextPage = parsed.data.data.search.pageInfo.hasNextPage;
    afterCursor = parsed.data.data.search.pageInfo.endCursor;
    if (hasNextPage && !afterCursor) {
      logger.warn('GitHub review request page is missing an end cursor');
      return prs;
    }

    if (page === MAX_PAGES && hasNextPage) {
      logger.warn('listReviewRequests: reached MAX_PAGES limit, results may be incomplete', {
        totalFetched: prs.length,
        maxPages: MAX_PAGES,
      });
    }
  }

  return prs;
}
