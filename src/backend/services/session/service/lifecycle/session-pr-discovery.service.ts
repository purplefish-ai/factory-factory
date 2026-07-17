import type { createLogger } from '@/backend/services/logger.service';
import { workspaceAccessor } from '@/backend/services/workspace';

type Logger = ReturnType<typeof createLogger>;

/**
 * After a session ends, make the workspace immediately eligible for batched PR
 * discovery. The scheduler performs the GitHub lookup so session completion
 * stays lightweight and does not bypass discovery backoff coordination.
 */
export async function maybeDiscoverPROnSessionEnd(
  workspaceId: string,
  logger: Logger
): Promise<void> {
  try {
    await workspaceAccessor.resetPRDiscoveryBackoff(workspaceId);
  } catch (error) {
    // Fire-and-forget: log but don't surface to caller.
    logger.debug('PR discovery backoff reset on session end failed', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
