import type { createLogger } from '@/backend/services/logger.service';
import type { SnapshotUpdateInput } from '@/backend/services/workspace';

type AcceptedCompletionProjection = Pick<
  SnapshotUpdateInput,
  'prSummary' | 'prState' | 'prNumber' | 'prUrl'
>;
type PrIdentity = { prNumber: number; prUrl?: string | null };
type LinearContext = { apiKey: string; linearIssueId: string };
interface LinearMergeCompletionDependencies {
  getLinearContext(workspaceId: string): Promise<LinearContext | null>;
  markIssueCompleted(apiKey: string, issueId: string): Promise<boolean>;
  logger: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>;
}

/** Per-collector-lifetime tracking for best-effort Linear merge completion. */
export class LinearMergeCompletion {
  private readonly attempts = new Map<string, PrIdentity>();

  constructor(private readonly dependencies: LinearMergeCompletionDependencies) {}

  observeAcceptedProjection(workspaceId: string, fields: AcceptedCompletionProjection): void {
    // A merged sibling is not workspace completion while the selected PR is open.
    if ((fields.prSummary?.state ?? fields.prState) === 'MERGED' && fields.prNumber != null) {
      void this.handleLinearIssueCompletedOnMerge(workspaceId, {
        prNumber: fields.prNumber,
        prUrl: fields.prUrl,
      });
    }
  }

  removeWorkspace(workspaceId: string): void {
    this.attempts.delete(workspaceId);
  }

  stop(): void {
    // Cleanup drops tracking; work admitted before cleanup may still complete.
    this.attempts.clear();
  }

  private async handleLinearIssueCompletedOnMerge(
    workspaceId: string,
    prIdentity: PrIdentity
  ): Promise<void> {
    const previous = this.attempts.get(workspaceId);
    if (
      previous?.prNumber === prIdentity.prNumber &&
      (!(previous.prUrl && prIdentity.prUrl) || previous.prUrl === prIdentity.prUrl)
    ) {
      previous.prUrl ??= prIdentity.prUrl;
      return;
    }
    // Running and completed attempts suppress repeats for the same PR identity.
    const attempt: PrIdentity = { ...prIdentity };
    this.attempts.set(workspaceId, attempt);
    let completed = false;
    try {
      const ctx = await this.dependencies.getLinearContext(workspaceId);
      if (!ctx) {
        return;
      }

      completed = await this.dependencies.markIssueCompleted(ctx.apiKey, ctx.linearIssueId);
      if (!completed) {
        return;
      }
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
      // A failed attempt is retried by a later observation unless it was replaced.
      if (!completed && this.attempts.get(workspaceId) === attempt) {
        this.attempts.delete(workspaceId);
      }
    }
  }
}
