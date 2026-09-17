/**
 * Adversarial Review: an on-demand critique of a workspace's open PR using a
 * different provider/model than the one that built it, configured once in
 * Admin. Read-only — it never edits the worktree. See
 * docs/design/adversarial-review.md for the full design.
 */

import { ApplicationError } from '@/backend/lib/application-error';
import { toError } from '@/backend/lib/error-utils';
import { buildAdversarialReviewDispatchPrompt } from '@/backend/prompts/adversarial-review-dispatch';
import {
  type AdversarialReviewComment,
  type AdversarialReviewFindings,
  parseAdversarialReviewFindings,
} from '@/backend/prompts/adversarial-review-findings.schema';
import {
  createReviewComment,
  getPRDescription,
  getPRHeadCommitSha,
  githubCLIService,
  ReviewSubmissionError,
  submitCodeReview,
} from '@/backend/services/github';
import { createLogger } from '@/backend/services/logger.service';
import {
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
  sessionService,
} from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService } from '@/backend/services/workspace';
import {
  ADVERSARIAL_REVIEW_MARKER,
  ADVERSARIAL_REVIEW_WORKFLOW,
} from '@/shared/adversarial-review';
import { PRState, SessionStatus } from '@/shared/core';
import { buildDiffLineIndex } from './adversarial-review-diff-line-index';

const logger = createLogger('adversarial-review');

// The enriched PRState values that mean "still an open, live PR" — mirrors
// the set `deriveRatchetState` uses for the same question.
const OPEN_PR_STATES = new Set<PRState>([
  PRState.OPEN,
  PRState.DRAFT,
  PRState.CHANGES_REQUESTED,
  PRState.APPROVED,
]);

export interface TriggerAdversarialReviewResult {
  status: 'started' | 'already_active';
  sessionId: string;
}

// Per-workspace acquisition lock: without it, two concurrent triggers can
// both observe "no active session" before either has created one, starting
// duplicate reviewers. A second call for the same workspace instead awaits
// the first call's own in-flight result rather than repeating its checks.
const inFlightTriggers = new Map<string, Promise<TriggerAdversarialReviewResult>>();

export function triggerAdversarialReview(
  workspaceId: string
): Promise<TriggerAdversarialReviewResult> {
  const existingTrigger = inFlightTriggers.get(workspaceId);
  if (existingTrigger !== undefined) {
    return existingTrigger;
  }

  const trigger = triggerAdversarialReviewLocked(workspaceId).finally(() => {
    inFlightTriggers.delete(workspaceId);
  });
  inFlightTriggers.set(workspaceId, trigger);
  return trigger;
}

async function triggerAdversarialReviewLocked(
  workspaceId: string
): Promise<TriggerAdversarialReviewResult> {
  const [fixerContext, prState] = await Promise.all([
    workspaceDataService.findFixerContext(workspaceId),
    workspaceDataService.findPRState(workspaceId),
  ]);

  if (!fixerContext) {
    throw new ApplicationError('NOT_FOUND', `Workspace not found: ${workspaceId}`);
  }
  if (!fixerContext.worktreePath) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Workspace is not ready yet (no worktree)');
  }
  if (!(prState?.prUrl && prState.prNumber && OPEN_PR_STATES.has(prState.prState))) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Workspace has no open pull request to review'
    );
  }

  const existing = await findActiveAdversarialReviewSession(workspaceId);
  if (existing) {
    return { status: 'already_active', sessionId: existing.id };
  }

  const prInfo = githubCLIService.extractPRInfo(prState.prUrl);
  if (!prInfo) {
    throw new ApplicationError('PRECONDITION_FAILED', `Could not parse PR URL: ${prState.prUrl}`);
  }
  const repo = `${prInfo.owner}/${prInfo.repo}`;

  const settings = await userSettingsService.get();
  const provider = settings.reviewerSessionProvider;
  // Explicit fallbacks (matching the Admin UI's own placeholders), not
  // `undefined` — an unset reviewer model must not silently inherit whatever
  // the general chat-default model happens to be configured as.
  const model =
    provider === 'CLAUDE'
      ? (settings.reviewerClaudeModel ?? 'sonnet')
      : (settings.reviewerCodexModel ?? 'default');
  const providerLabel = provider === 'CLAUDE' ? 'Claude' : 'Codex';

  const session = await sessionDataService.createAgentSession({
    workspaceId,
    name: `Adversarial Review (${providerLabel})`,
    workflow: ADVERSARIAL_REVIEW_WORKFLOW,
    provider,
    model,
  });

  // `plan` mode structurally blocks write tools (not just the permission
  // preset, which non-interactive sessions can't be prompted to approve
  // anyway) — see session-lifecycle-external-ports.ts for the matching
  // permission-preset side of this. An empty initial prompt prevents the
  // startup default ("Continue with the task.") from running a turn before
  // the review prompt below is the first thing the model sees.
  await sessionLifecycleService.startSession(session.id, {
    initialPrompt: '',
    startupModePreset: 'plan',
  });

  // Fire-and-forget: the caller gets the session id back immediately so the
  // client can switch to it and watch it work; the review turn itself can
  // take minutes, far longer than an HTTP request should block for.
  void runAdversarialReviewTurn({
    sessionId: session.id,
    repo,
    prUrl: prState.prUrl,
    prNumber: prState.prNumber,
    postReviewToGitHub: settings.postReviewToGitHub,
  }).catch((error) => {
    logger.error('Adversarial review turn failed', toError(error), {
      workspaceId,
      sessionId: session.id,
    });
  });

  return { status: 'started', sessionId: session.id };
}

async function findActiveAdversarialReviewSession(
  workspaceId: string
): Promise<{ id: string } | null> {
  const sessions = await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId);
  return (
    sessions.find(
      (session) =>
        session.workflow === ADVERSARIAL_REVIEW_WORKFLOW &&
        (session.status === SessionStatus.RUNNING || session.status === SessionStatus.IDLE)
    ) ?? null
  );
}

interface RunAdversarialReviewTurnParams {
  sessionId: string;
  repo: string;
  prUrl: string;
  prNumber: number;
  postReviewToGitHub: boolean;
}

async function runAdversarialReviewTurn(params: RunAdversarialReviewTurnParams): Promise<void> {
  const { sessionId, repo, prUrl, prNumber, postReviewToGitHub } = params;

  try {
    const [diff, headSha, fullDetails, description] = await Promise.all([
      githubCLIService.getPRDiff(repo, prNumber),
      getPRHeadCommitSha(repo, prNumber),
      githubCLIService.getPRFullDetails(repo, prNumber),
      getPRDescription(repo, prNumber),
    ]);

    const prompt = buildAdversarialReviewDispatchPrompt({
      prUrl,
      prNumber,
      prDescription: description,
      prDiff: diff,
      existingReviewCommentsSummary: summarizeExistingActivity(fullDetails),
    });

    await sessionService.sendSessionMessage(sessionId, prompt);

    const finalMessage = getLastAssistantMessageText(sessionId);
    if (!finalMessage) {
      logger.warn('Adversarial review session produced no assistant message', { sessionId });
      return;
    }

    let findings: AdversarialReviewFindings;
    try {
      findings = parseAdversarialReviewFindings(finalMessage);
    } catch (error) {
      logger.warn('Failed to parse adversarial review findings', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!postReviewToGitHub) {
      return;
    }

    await postFindingsToGitHub(repo, prNumber, diff, headSha, findings);
  } finally {
    // A one-off review turn: retire the session once it's done so a later
    // trigger starts a fresh review instead of finding this one "already
    // active" forever.
    await sessionLifecycleService.stopSession(sessionId).catch((error) => {
      logger.warn('Failed to stop adversarial review session after its turn', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

function summarizeExistingActivity(fullDetails: {
  reviews: Array<{ author: { login: string }; state?: string; body?: string }>;
}): string {
  return fullDetails.reviews
    .filter((review) => (review.body?.trim().length ?? 0) > 0)
    .map(
      (review) => `Review by ${review.author.login} (${review.state ?? 'UNKNOWN'}): ${review.body}`
    )
    .join('\n\n');
}

/** Mirrors the transcript-reading pattern in `domain-bridges.orchestrator.ts`'s auto-iteration bridge. */
function getLastAssistantMessageText(sessionId: string): string {
  const transcript = sessionDomainService.getTranscriptSnapshot(sessionId);
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (entry?.message?.type !== 'assistant') {
      continue;
    }
    const content = entry.message.message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(
          (block) =>
            typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
        )
        .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
        .join('');
    }
    return '';
  }
  return '';
}

async function postFindingsToGitHub(
  repo: string,
  prNumber: number,
  diff: string,
  headSha: string,
  findings: AdversarialReviewFindings
): Promise<void> {
  const diffIndex = buildDiffLineIndex(diff);
  const validComments: AdversarialReviewComment[] = [];
  const droppedComments: AdversarialReviewComment[] = [];

  for (const comment of findings.comments) {
    if (diffIndex.has(comment.path, comment.side, comment.line)) {
      validComments.push(comment);
    } else {
      droppedComments.push(comment);
    }
  }

  if (droppedComments.length > 0) {
    logger.warn('Dropped adversarial review comments outside the diff', {
      repo,
      prNumber,
      droppedCount: droppedComments.length,
    });
  }

  const body = buildReviewBody(findings.summary, droppedComments);

  try {
    await submitCodeReview(repo, prNumber, {
      commitId: headSha,
      body,
      comments: validComments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: formatCommentBody(comment),
      })),
    });
    return;
  } catch (error) {
    // Only a confirmed self-review rejection is safe to retry through the
    // fallback endpoints — any other failure (auth, rate limit, timeout) may
    // have still landed the review server-side, so falling back blind risks
    // posting duplicate comments.
    if (!(error instanceof ReviewSubmissionError && error.isSelfReviewRejection)) {
      throw error;
    }
    logger.warn('submitCodeReview rejected as self-review; falling back to individual comments', {
      repo,
      prNumber,
      error: error.message,
    });
  }

  // Fallback for when the review-object endpoint rejects this app's `gh`
  // identity for reviewing its own PR: post the same content through
  // endpoints with no such self-review restriction, anchored to the same
  // commit the diff (and therefore the findings' line numbers) was read at.
  for (const comment of validComments) {
    await createReviewComment(repo, prNumber, {
      commitId: headSha,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: formatCommentBody(comment),
    });
  }
  await githubCLIService.addPRComment(repo, prNumber, body);
}

function formatCommentBody(comment: AdversarialReviewComment): string {
  const severityLabel =
    comment.severity === 'blocking'
      ? '🔴 Blocking'
      : comment.severity === 'suggestion'
        ? '🟡 Suggestion'
        : '⚪ Nit';
  return `${severityLabel}\n\n${comment.body}`;
}

function buildReviewBody(summary: string, droppedComments: AdversarialReviewComment[]): string {
  const parts = [ADVERSARIAL_REVIEW_MARKER, '', '## Adversarial Review', '', summary];
  if (droppedComments.length > 0) {
    parts.push('', '### Additional notes (outside this diff)', '');
    for (const comment of droppedComments) {
      parts.push(`- **${comment.path}** (not part of this diff): ${comment.body}`);
    }
  }
  return parts.join('\n');
}
