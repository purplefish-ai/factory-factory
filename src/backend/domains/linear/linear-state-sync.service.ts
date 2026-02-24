/**
 * Linear State Sync Service
 *
 * Transitions Linear issue states in response to workspace lifecycle events.
 * Callers provide the decrypted API key — this service is encryption-unaware.
 *
 */

import { createLogger } from '@/backend/services/logger.service';
import { linearClientService } from './linear-client.service';

const logger = createLogger('linear-state-sync');

class LinearStateSyncService {
  /**
   * Move a Linear issue to the first 'started' workflow state.
   * Called when a workspace is created from a Linear issue.
   */
  async markIssueStarted(apiKey: string, issueId: string): Promise<void> {
    try {
      await linearClientService.transitionIssueState(apiKey, issueId, 'started');
    } catch (error) {
      logger.warn('Failed to mark Linear issue as started', {
        issueId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Move a Linear issue to the first 'completed' workflow state.
   * Called when a workspace's PR is merged.
   */
  async markIssueCompleted(apiKey: string, issueId: string): Promise<void> {
    try {
      await linearClientService.transitionIssueState(apiKey, issueId, 'completed');
    } catch (error) {
      logger.warn('Failed to mark Linear issue as completed', {
        issueId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const linearStateSyncService = new LinearStateSyncService();
