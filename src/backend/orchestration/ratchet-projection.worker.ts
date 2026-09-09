import type { createLogger } from '@/backend/services/logger.service';
import type { SnapshotUpdateInput, workspaceDataService } from '@/backend/services/workspace';
import { WorkspaceStatus } from '@/shared/core';

const PROJECTION_RETRY_BASE_MS = 1000;
const MAX_PROJECTION_READ_ATTEMPTS = 3;

interface ProjectionRefresh {
  revision: number;
}

function getNewerRevision(refresh: ProjectionRefresh, target: number): number | null {
  return refresh.revision > target ? refresh.revision : null;
}

interface RetryWaiter {
  timer: NodeJS.Timeout;
  resolve: () => void;
}

interface RatchetProjectionDependencies {
  read: typeof workspaceDataService.findRatchetProjection;
  publish(workspaceId: string, fields: SnapshotUpdateInput): void;
  logger: Pick<ReturnType<typeof createLogger>, 'warn'>;
}

/**
 * One collector lifetime's authoritative Ratchet reads. Requests arriving during
 * a read advance its revision so the latest observation is eventually published.
 * Create a new worker on restart; a stopped worker never publishes again.
 */
export class RatchetProjectionWorker {
  private active = true;
  private readonly refreshes = new Map<string, ProjectionRefresh>();
  private readonly archivedWorkspaceIds = new Set<string>();
  private readonly retryWaiters = new Set<RetryWaiter>();

  constructor(private readonly dependencies: RatchetProjectionDependencies) {}

  request(workspaceId: string): void {
    if (!this.isActive(workspaceId)) {
      return;
    }
    const existing = this.refreshes.get(workspaceId);
    if (existing) {
      existing.revision += 1;
      return;
    }

    const refresh = { revision: 1 };
    this.refreshes.set(workspaceId, refresh);
    void this.refresh(workspaceId, refresh);
  }

  setArchived(workspaceId: string, archived: boolean): void {
    if (archived) {
      this.archivedWorkspaceIds.add(workspaceId);
      this.refreshes.delete(workspaceId);
    } else {
      this.archivedWorkspaceIds.delete(workspaceId);
    }
  }

  stop(): void {
    this.active = false;
    for (const waiter of this.retryWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.retryWaiters.clear();
    this.refreshes.clear();
    this.archivedWorkspaceIds.clear();
  }

  private isActive(workspaceId: string): boolean {
    return this.active && !this.archivedWorkspaceIds.has(workspaceId);
  }

  private async project(workspaceId: string): Promise<boolean> {
    try {
      const workspace = await this.dependencies.read(workspaceId);
      if (
        !(workspace && this.isActive(workspaceId)) ||
        workspace.status === WorkspaceStatus.ARCHIVING ||
        workspace.status === WorkspaceStatus.ARCHIVED
      ) {
        return true;
      }
      this.dependencies.publish(workspaceId, {
        ratchetEnabled: workspace.ratchetEnabled,
        ratchetState: workspace.ratchetState,
        ratchetDispatchOutcome: workspace.ratchetDispatchOutcome,
        ratchetDispatchRetryCount: workspace.ratchetDispatchRetryCount,
        ratchetDispatchStalled: workspace.ratchetDispatchStalled,
        hasMergeConflict: workspace.prHasMergeConflict,
      });
      return true;
    } catch (error) {
      this.dependencies.logger.warn('Failed to refresh authoritative Ratchet snapshot projection', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async refresh(workspaceId: string, refresh: ProjectionRefresh): Promise<void> {
    let targetRevision = refresh.revision;
    let failedAttempts = 0;
    try {
      while (this.isActive(workspaceId)) {
        const succeeded = await this.project(workspaceId);
        const newerRevision = getNewerRevision(refresh, targetRevision);
        if (succeeded) {
          if (newerRevision === null) {
            break;
          }
          targetRevision = newerRevision;
          failedAttempts = 0;
          continue;
        }
        failedAttempts += 1;
        if (newerRevision !== null) {
          targetRevision = newerRevision;
        }
        if (!this.isActive(workspaceId)) {
          break;
        }
        // The 60-second snapshot reconciliation is the long-term safety net.
        // Bound event-path retries so a database outage cannot leave one loop
        // per workspace running indefinitely, even with repeated invalidations.
        if (failedAttempts >= MAX_PROJECTION_READ_ATTEMPTS) {
          break;
        }
        await this.waitForRetry(Math.max(failedAttempts - 1, 0));
      }
    } finally {
      if (this.refreshes.get(workspaceId) === refresh) {
        this.refreshes.delete(workspaceId);
      }
    }
  }

  private waitForRetry(attempt: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.active) {
        resolve();
        return;
      }
      const waiter = {
        timer: setTimeout(
          () => {
            this.retryWaiters.delete(waiter);
            resolve();
          },
          PROJECTION_RETRY_BASE_MS * 2 ** attempt
        ),
        resolve,
      };
      this.retryWaiters.add(waiter);
    });
  }
}
