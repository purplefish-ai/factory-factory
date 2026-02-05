import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { githubCLIService } from './github-cli.service';
import { kanbanStateService } from './kanban-state.service';
import { createLogger } from './logger.service';

const logger = createLogger('pr-snapshot');

type SnapshotData = {
  prNumber: number;
  prState: Awaited<ReturnType<typeof githubCLIService.fetchAndComputePRState>> extends infer T
    ? T extends { prState: infer S }
      ? S
      : never
    : never;
  prReviewState: string | null;
  prCiStatus: Awaited<ReturnType<typeof githubCLIService.fetchAndComputePRState>> extends infer T
    ? T extends { prCiStatus: infer S }
      ? S
      : never
    : never;
};

export type PRSnapshotRefreshResult =
  | { success: true; snapshot: SnapshotData }
  | { success: false; reason: 'workspace_not_found' | 'no_pr_url' | 'fetch_failed' | 'error' };

class PRSnapshotService {
  async refreshWorkspace(
    workspaceId: string,
    explicitPrUrl?: string | null
  ): Promise<PRSnapshotRefreshResult> {
    try {
      let prUrl = explicitPrUrl;

      if (!prUrl) {
        const workspace = await workspaceAccessor.findById(workspaceId);
        if (!workspace) {
          return { success: false, reason: 'workspace_not_found' };
        }

        prUrl = workspace.prUrl;
      }

      if (!prUrl) {
        return { success: false, reason: 'no_pr_url' };
      }

      const snapshot = await githubCLIService.fetchAndComputePRState(prUrl);
      if (!snapshot) {
        return { success: false, reason: 'fetch_failed' };
      }

      await this.applySnapshot(workspaceId, {
        prNumber: snapshot.prNumber,
        prState: snapshot.prState,
        prReviewState: snapshot.prReviewState,
        prCiStatus: snapshot.prCiStatus,
      });

      return {
        success: true,
        snapshot: {
          prNumber: snapshot.prNumber,
          prState: snapshot.prState,
          prReviewState: snapshot.prReviewState,
          prCiStatus: snapshot.prCiStatus,
        },
      };
    } catch (error) {
      logger.error('Failed to refresh PR snapshot', error as Error, { workspaceId });
      return { success: false, reason: 'error' };
    }
  }

  async applySnapshot(workspaceId: string, snapshot: SnapshotData): Promise<void> {
    await workspaceAccessor.update(workspaceId, {
      prNumber: snapshot.prNumber,
      prState: snapshot.prState,
      prReviewState: snapshot.prReviewState,
      prCiStatus: snapshot.prCiStatus,
      prUpdatedAt: new Date(),
    });

    await kanbanStateService.updateCachedKanbanColumn(workspaceId);
  }
}

export const prSnapshotService = new PRSnapshotService();
