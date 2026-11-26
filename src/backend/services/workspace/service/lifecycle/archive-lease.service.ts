import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceArchiveRecoveryAccessor } from '@/backend/services/workspace/resources/workspace-archive-recovery.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';

const logger = createLogger('workspace-archive-lease');

/** How often an archive in progress renews its row's lease (`updatedAt`). */
export const ARCHIVE_LEASE_RENEW_MS = 15_000;

/**
 * An ARCHIVING row whose lease is this old has missed eight renewals, so its
 * archive is presumed gone; a process suspended for longer may still be
 * archiving it (see the decision record). Renewal runs on a timer, not between
 * archive steps, so a slow snapshot or session stop does not delay it.
 */
export const ARCHIVE_LEASE_STALE_MS = 2 * 60_000;

/** The lease an archive holds on its ARCHIVING row while it runs. */
export interface ArchiveLease {
  /** The `updatedAt` this lease last wrote. */
  readonly stamp: Date;
  /** Stop renewing; resolves with the final stamp once a renewal in flight settles. */
  release(): Promise<Date>;
}

class WorkspaceArchiveLeaseService {
  isStale(updatedAt: Date, now = Date.now()): boolean {
    return now - updatedAt.getTime() >= ARCHIVE_LEASE_STALE_MS;
  }

  /** IDs of the oldest stale ARCHIVING rows (see `isStale`), at most `limit`. */
  findStaleIds(limit: number): Promise<string[]> {
    return workspaceAccessor.findStaleArchivingIds(
      new Date(Date.now() - ARCHIVE_LEASE_STALE_MS),
      limit
    );
  }

  /**
   * Take the lease of an ARCHIVING row last written at `observedUpdatedAt`.
   * Of several claimers that observed the same value, at most one succeeds.
   * Returns the new stamp, or null when the claim was lost.
   */
  async claim(workspaceId: string, observedUpdatedAt: Date): Promise<Date | null> {
    const stamp = new Date(Math.max(Date.now(), observedUpdatedAt.getTime() + 1));
    const claimed = await workspaceArchiveRecoveryAccessor.claimArchiving(
      workspaceId,
      observedUpdatedAt,
      stamp
    );
    return claimed ? stamp : null;
  }

  /** Renew the row's lease every `ARCHIVE_LEASE_RENEW_MS` until released. */
  hold(workspaceId: string, stamp: Date): ArchiveLease {
    let current = stamp;
    let renewal: Promise<void> | null = null;
    const renew = async () => {
      const renewedAt = new Date();
      try {
        if (await workspaceArchiveRecoveryAccessor.renewArchiving(workspaceId, renewedAt)) {
          current = renewedAt;
        }
      } catch (error) {
        logger.warn('Failed to renew archive lease', {
          workspaceId,
          error: toError(error).message,
        });
      }
    };
    const timer = setInterval(() => {
      renewal ??= renew().finally(() => {
        renewal = null;
      });
    }, ARCHIVE_LEASE_RENEW_MS);
    timer.unref?.();
    return {
      get stamp() {
        return current;
      },
      async release() {
        clearInterval(timer);
        await renewal;
        return current;
      },
    };
  }
}

export const workspaceArchiveLeaseService = new WorkspaceArchiveLeaseService();
