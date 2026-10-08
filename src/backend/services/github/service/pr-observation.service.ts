import { createHash } from 'node:crypto';
import type { RatchetReviewTriggerMode } from '@prisma-gen/client';
import { deriveCiStatusFromCheckRollup, reduceCheckRollupToLatestRunAttempts } from '@/shared/core';
import type { PRObservation, PRTarget } from '@/shared/pr-monitoring';
import { prObservationSchema } from '@/shared/schemas/pr-event.schema';
import { githubCLIService } from './github-cli.service';
import {
  isIgnoredReviewAuthor,
  isOwnAdversarialReviewMarker,
  selectActionableReviews,
} from './pr-actionable-review';

interface ObservationPorts {
  findPR(target: PRTarget): Promise<{ url: string } | null>;
  readPolicy(): Promise<{ reviewTriggerMode: RatchetReviewTriggerMode }>;
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function timestamp(value: string | null | undefined): string | null {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
class PRObservationService {
  private ports: ObservationPorts | null = null;
  private username: { value: string | null; expiresAt: number } | null = null;
  configure(ports: ObservationPorts) {
    this.ports = ports;
  }
  async fetch(target: PRTarget, signal?: AbortSignal): Promise<PRObservation> {
    if (!this.ports) {
      throw new Error('PR observation service is not configured');
    }
    const association = await this.ports.findPR(target);
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
    const policy = await this.ports.readPolicy();
    if (!this.username || this.username.expiresAt < Date.now()) {
      this.username = {
        value: await githubCLIService.getAuthenticatedUsername(signal),
        expiresAt: Date.now() + 300_000,
      };
    }
    const username = this.username.value;
    let reviewsComplete = true;
    const incomplete = () => {
      reviewsComplete = false;
    };
    const [details, comments, resolved] = await Promise.all([
      githubCLIService.getPRFullDetails(repository, number, signal),
      githubCLIService.getReviewComments(repository, number, undefined, signal, incomplete),
      githubCLIService.getResolvedReviewCommentIds(repository, number, signal, incomplete),
    ]);
    signal?.throwIfAborted();
    if (!details.headRefOid) {
      throw new Error('GitHub observation is missing head SHA');
    }
    const checks =
      reduceCheckRollupToLatestRunAttempts(details.statusCheckRollup)?.map((c) => ({
        identity: c.detailsUrl || `${c.workflowName ?? ''}:${c.name ?? ''}`,
        attempt: null,
        name: c.name ?? '',
        workflowName: c.workflowName ?? null,
        status: c.status ?? 'UNKNOWN',
        conclusion: c.conclusion ?? null,
        detailsUrl: c.detailsUrl || null,
        startedAt: timestamp(c.startedAt),
        completedAt: timestamp(c.completedAt),
      })) ?? [];
    const actionableReviews = [
      ...selectActionableReviews(details.reviews, username, policy.reviewTriggerMode).map((r) => ({
        identity: `review:${r.id}`,
        contentHash: hash(r.body ?? ''),
        author: r.author.login,
        body: r.body ?? '',
        path: null,
        line: null,
        url: `${association.url}#pullrequestreview-${r.id}`,
        activityAt:
          timestamp(r.submittedAt) ?? timestamp(details.updatedAt) ?? '1970-01-01T00:00:00.000Z',
      })),
      ...comments
        .filter((c) => !(resolved.has(c.id) || isIgnoredReviewAuthor(c.author.login, username)))
        .map((c) => ({
          identity: `comment:${c.id}`,
          contentHash: hash(c.body),
          author: c.author.login,
          body: c.body,
          path: c.path,
          line: c.line,
          url: c.url,
          activityAt:
            timestamp(c.updatedAt) ?? timestamp(c.createdAt) ?? '1970-01-01T00:00:00.000Z',
        })),
      ...details.comments
        .filter((c) => isOwnAdversarialReviewMarker(c, username))
        .map((c) => ({
          identity: `conversation:${c.id}`,
          contentHash: hash(c.body),
          author: c.author.login,
          body: c.body,
          path: null,
          line: null,
          url: c.url,
          activityAt:
            timestamp(c.updatedAt) ?? timestamp(c.createdAt) ?? '1970-01-01T00:00:00.000Z',
        })),
    ];
    return prObservationSchema.parse({
      url: association.url,
      repository,
      number,
      headSha: details.headRefOid,
      headBranch: details.headRefName,
      baseBranch: details.baseRefName,
      observedAt: new Date().toISOString(),
      prState: observationState(details),
      ciStatus:
        details.statusCheckRollup === null
          ? 'UNKNOWN'
          : deriveCiStatusFromCheckRollup(details.statusCheckRollup),
      reviewState: details.reviewDecision,
      hasMergeConflict: details.mergeStateStatus === 'DIRTY',
      checks,
      actionableReviews,
      reviewsComplete,
    });
  }
}
export const prObservationService = new PRObservationService();

function observationState(details: Awaited<ReturnType<typeof githubCLIService.getPRFullDetails>>) {
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
