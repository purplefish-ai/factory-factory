import type { createLogger } from '@/backend/services/logger.service';
import type { SnapshotUpdateInput } from '@/backend/services/workspace';

type CompletionProjection = Pick<SnapshotUpdateInput, 'prSummary' | 'prState'>;
type AcceptedCompletionProjection = CompletionProjection &
  Pick<SnapshotUpdateInput, 'prNumber' | 'prUrl'>;
type PrIdentity = { prNumber: number; prUrl?: string | null };
type LinearContext = { apiKey: string; linearIssueId: string };
interface LinearMergeCompletionDependencies {
  readLegacyProjection(workspaceId: string): Promise<CompletionProjection | null>;
  getLinearContext(workspaceId: string): Promise<LinearContext | null>;
  markIssueCompleted(apiKey: string, issueId: string): Promise<boolean>;
  logger: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>;
}
type CompletionAttempt = PrIdentity & {
  status: 'pending' | 'running' | 'completed';
  retryRequested: boolean;
  retryProjection?: CompletionProjection;
};

/** Per-collector-lifetime tracking for best-effort Linear merge completion. */
export class LinearMergeCompletion {
  private readonly attempts = new Map<string, CompletionAttempt>();

  constructor(private readonly dependencies: LinearMergeCompletionDependencies) {}

  observeAcceptedProjection(workspaceId: string, fields: AcceptedCompletionProjection): void {
    this.retryDeferredLinearCompletion(workspaceId, fields);
    // A merged sibling is not workspace completion while the selected PR is open.
    if ((fields.prSummary?.state ?? fields.prState) === 'MERGED' && fields.prNumber != null) {
      void this.handleLinearIssueCompletedOnMerge(
        workspaceId,
        { prNumber: fields.prNumber, prUrl: fields.prUrl },
        fields
      );
    }
  }

  observeLegacy(workspaceId: string, identity: PrIdentity, state: 'MERGED' | 'CLOSED'): void {
    if (state === 'MERGED') {
      void this.handleLinearIssueCompletedOnMerge(workspaceId, identity);
    } else {
      this.retryDeferredLinearCompletion(workspaceId);
    }
  }

  removeWorkspace(workspaceId: string): void {
    this.attempts.delete(workspaceId);
  }

  stop(): void {
    // Cleanup drops tracking; work admitted before cleanup may still complete.
    this.attempts.clear();
  }

  private getLinearCompletionProjection(
    workspaceId: string,
    acceptedProjection?: CompletionProjection
  ) {
    // Association-aware effects use accepted fields; legacy events retain the
    // independent narrow read and missing-row compatibility gate.
    return acceptedProjection
      ? Promise.resolve(acceptedProjection)
      : this.dependencies.readLegacyProjection(workspaceId);
  }

  private async handleLinearIssueCompletedOnMerge(
    workspaceId: string,
    prIdentity: PrIdentity,
    acceptedProjection?: CompletionProjection
  ): Promise<void> {
    const previous = this.attempts.get(workspaceId);
    if (
      previous?.prNumber === prIdentity.prNumber &&
      (!(previous.prUrl && prIdentity.prUrl) || previous.prUrl === prIdentity.prUrl)
    ) {
      previous.prUrl ??= prIdentity.prUrl;
      if (previous.status !== 'pending') {
        return;
      }
    }
    const attempt: CompletionAttempt = {
      ...prIdentity,
      status: 'running',
      retryRequested: false,
    };
    this.attempts.set(workspaceId, attempt);
    let completed = false;
    try {
      const projection = await this.getLinearCompletionProjection(workspaceId, acceptedProjection);
      if (projection && (projection.prSummary?.state ?? projection.prState) !== 'MERGED') {
        attempt.status = 'pending';
        return;
      }
      const ctx = await this.dependencies.getLinearContext(workspaceId);
      if (!ctx) {
        return;
      }

      completed = await this.dependencies.markIssueCompleted(ctx.apiKey, ctx.linearIssueId);
      if (!completed) {
        return;
      }
      attempt.status = 'completed';
      this.dependencies.logger.info('Marked Linear issue as completed on PR merge', {
        workspaceId,
        linearIssueId: ctx.linearIssueId,
      });
    } catch (error) {
      this.dependencies.logger.warn('Failed to mark Linear issue as completed on PR merge', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.finishLinearCompletionAttempt(workspaceId, attempt, completed);
    }
  }

  private finishLinearCompletionAttempt(
    workspaceId: string,
    attempt: CompletionAttempt,
    completed: boolean
  ): void {
    if (this.attempts.get(workspaceId) !== attempt) {
      return;
    }
    if (attempt.status === 'pending' && attempt.retryRequested) {
      void this.handleLinearIssueCompletedOnMerge(workspaceId, attempt, attempt.retryProjection);
    } else if (!completed && attempt.status !== 'pending') {
      this.attempts.delete(workspaceId);
    }
  }

  private retryDeferredLinearCompletion(
    workspaceId: string,
    acceptedProjection?: CompletionProjection
  ): void {
    const pending = this.attempts.get(workspaceId);
    if (pending?.status === 'pending') {
      void this.handleLinearIssueCompletedOnMerge(workspaceId, pending, acceptedProjection);
    } else if (pending?.status === 'running') {
      pending.retryRequested = true;
      pending.retryProjection = acceptedProjection;
    }
  }
}
