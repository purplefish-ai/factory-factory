import { GitHubConnectivityError } from '@/backend/lib/github-cli-error';
import type { PRObservation, PRTarget } from '@/shared/pr-monitoring';
import { prObservationSchema } from '@/shared/schemas/pr-event.schema';
import type { RatchetReviewTriggerMode } from '@prisma-gen/client';
import { normalizeGitHubCheckFacts } from './github-check-facts';
import { githubCLIService } from './github-cli.service';
import { fetchPRReviewFacts } from './pr-review-facts';

interface ObservationPorts {
  findPR(target: PRTarget): Promise<{ url: string; hasMergeConflict?: boolean } | null>;
  readPolicy(): Promise<{ reviewTriggerMode: RatchetReviewTriggerMode }>;
}
// Like a failed enrichment: claims no feedback and no resolutions.
const SKIPPED_REVIEW_FACTS = {
  actionableReviews: [],
  reviewsComplete: false,
  resolvedReviewIds: [],
} satisfies Pick<PRObservation, 'actionableReviews' | 'reviewsComplete' | 'resolvedReviewIds'>;

class PRObservationService {
  private ports: ObservationPorts | null = null;
  private username: { value: string; expiresAt: number } | null = null;
  configure(ports: ObservationPorts) {
    this.ports = ports;
  }
  /**
   * `includeReviews: false` reads only core PR, head and check facts. Review data
   * feeds only the event reducer, so callers skip it while monitoring is off; the
   * observation then reports reviews as incomplete rather than resolved.
   */
  async fetch(
    target: PRTarget,
    signal?: AbortSignal,
    options?: { includeReviews?: boolean }
  ): Promise<PRObservation> {
    if (!this.ports) {
      throw new Error('PR observation service is not configured');
    }
    const ports = this.ports;
    const association = await ports.findPR(target);
    if (!association) {
      throw new Error('PR association no longer exists');
    }
    const match = association.url.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/
    );
    if (!match) {
      throw new Error('Invalid GitHub PR URL');
    }
    const repository = `${match[1]}/${match[2]}`;
    const number = Number(match[3]);
    const [details, reviewFacts] =
      options?.includeReviews === false
        ? await Promise.all([
            githubCLIService.getPRStatusDetails(repository, number, signal),
            SKIPPED_REVIEW_FACTS,
          ])
        : await this.readWithReviews(ports, repository, number, association.url, signal);
    signal?.throwIfAborted();
    if (!details.headRefOid) {
      throw new Error('GitHub observation is missing head SHA');
    }
    const { checks, ciStatus } = normalizeGitHubCheckFacts(details.statusCheckRollup);
    return prObservationSchema.parse({
      url: association.url,
      title: details.title,
      repository,
      number,
      headSha: details.headRefOid,
      headBranch: details.headRefName,
      baseBranch: details.baseRefName,
      observedAt: new Date().toISOString(),
      prState: observationState(details),
      ciStatus,
      reviewState: details.reviewDecision,
      // UNKNOWN means GitHub is still recomputing mergeability after the base or
      // head moved; keep the last known conflict rather than reporting it cleared.
      hasMergeConflict:
        details.mergeStateStatus === 'UNKNOWN'
          ? (association.hasMergeConflict ?? false)
          : details.mergeStateStatus === 'DIRTY',
      checks,
      ...reviewFacts,
    });
  }
  /** One `gh pr view` returns the core facts and the conversation comments. */
  private readWithReviews(
    ports: ObservationPorts,
    repository: string,
    number: number,
    url: string,
    signal?: AbortSignal
  ) {
    const combined = githubCLIService.getPRObservationDetails(repository, number, signal);
    return Promise.all([
      combined.catch((error) => readCoreAfterCombinedFailure(error, repository, number, signal)),
      fetchPRReviewFacts(
        {
          readPolicy: () => ports.readPolicy(),
          readUsername: (abortSignal) => this.readUsername(abortSignal),
          readDetails: async (...args) => {
            const [{ updatedAt, comments }, reviews] = await Promise.all([
              combined,
              githubCLIService.getPRReviews(...args),
            ]);
            return { updatedAt, comments, reviews };
          },
          readComments: (...args) => githubCLIService.getReviewComments(...args),
          readResolvedIds: (...args) => githubCLIService.getResolvedReviewCommentIds(...args),
        },
        repository,
        number,
        url,
        signal
      ),
    ]);
  }
  private async readUsername(signal?: AbortSignal): Promise<string | null> {
    if (this.username && this.username.expiresAt >= Date.now()) {
      return this.username.value;
    }
    const value = await githubCLIService.getAuthenticatedUsername(signal);
    if (value) {
      this.username = { value, expiresAt: Date.now() + 300_000 };
    }
    return value;
  }
}
export const prObservationService = new PRObservationService();

/**
 * Comment data must not block core facts: if the combined read fails, read the
 * core facts alone (review facts then report incomplete). Aborts and connectivity
 * failures would fail that read too, so they propagate unchanged.
 */
function readCoreAfterCombinedFailure(
  error: unknown,
  repository: string,
  number: number,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (
    error instanceof GitHubConnectivityError ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    throw error;
  }
  return githubCLIService.getPRStatusDetails(repository, number, signal);
}

function observationState(
  details: Awaited<ReturnType<typeof githubCLIService.getPRStatusDetails>>
) {
  if (details.state !== 'OPEN') {
    return details.state;
  }
  if (details.isDraft) {
    return 'DRAFT';
  }
  if (details.reviewDecision === 'CHANGES_REQUESTED') {
    return 'CHANGES_REQUESTED';
  }
  if (details.reviewDecision === 'APPROVED') {
    return 'APPROVED';
  }
  return 'OPEN';
}
