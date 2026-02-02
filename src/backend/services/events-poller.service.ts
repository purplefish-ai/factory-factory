/**
 * Events Poller Service
 *
 * Runs server-side polling loops and publishes snapshots to /events.
 */

import { eventsHubService } from './events-hub.service';
import { eventsSnapshotService } from './events-snapshot.service';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';

const logger = createLogger('events-poller');

const PROJECT_SUMMARY_INTERVAL_MS = 2000;
const WORKSPACE_INIT_INTERVAL_MS = 1000;
const REVIEWS_INTERVAL_MS = 30_000;
const PROJECT_LIST_INTERVAL_MS = 10_000;
const WORKSPACE_LIST_INTERVAL_MS = 15_000;
const WORKSPACE_DETAIL_INTERVAL_MS = 10_000;
const ADMIN_INTERVAL_MS = 5000;

class EventsPollerService {
  private projectSummaryInterval: NodeJS.Timeout | null = null;
  private workspaceInitInterval: NodeJS.Timeout | null = null;
  private reviewsInterval: NodeJS.Timeout | null = null;
  private projectListInterval: NodeJS.Timeout | null = null;
  private workspaceListInterval: NodeJS.Timeout | null = null;
  private workspaceDetailInterval: NodeJS.Timeout | null = null;
  private adminInterval: NodeJS.Timeout | null = null;
  private lastReviewCount = 0;
  private lastPollAt = new Map<string, number>();

  start(): void {
    if (!this.projectSummaryInterval) {
      this.projectSummaryInterval = setInterval(() => {
        this.pollProjectSummaries().catch((error) => {
          logger.debug('Project summary poll failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, PROJECT_SUMMARY_INTERVAL_MS);
    }

    if (!this.workspaceInitInterval) {
      this.workspaceInitInterval = setInterval(() => {
        this.pollWorkspaceInitStatuses().catch((error) => {
          logger.debug('Workspace init poll failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, WORKSPACE_INIT_INTERVAL_MS);
    }

    if (!this.reviewsInterval) {
      this.reviewsInterval = setInterval(() => {
        this.pollReviews().catch((error) => {
          logger.debug('Reviews poll failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, REVIEWS_INTERVAL_MS);
    }

    if (!this.projectListInterval) {
      this.projectListInterval = setInterval(() => {
        this.pollProjectList().catch((error) => {
          logger.debug('Project list poll failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, PROJECT_LIST_INTERVAL_MS);
    }

    if (!this.workspaceListInterval) {
      this.workspaceListInterval = setInterval(() => {
        this.pollWorkspaceLists().catch((error) => {
          logger.debug('Workspace list poll failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, WORKSPACE_LIST_INTERVAL_MS);
    }

    if (!this.workspaceDetailInterval) {
      this.workspaceDetailInterval = setInterval(() => {
        this.pollWorkspaceDetails().catch((error) => {
          logger.debug('Workspace detail poll failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, WORKSPACE_DETAIL_INTERVAL_MS);
    }

    if (!this.adminInterval) {
      this.adminInterval = setInterval(() => {
        this.pollAdminSnapshots().catch((error) => {
          logger.debug('Admin poll failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, ADMIN_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.projectSummaryInterval) {
      clearInterval(this.projectSummaryInterval);
      this.projectSummaryInterval = null;
    }
    if (this.workspaceInitInterval) {
      clearInterval(this.workspaceInitInterval);
      this.workspaceInitInterval = null;
    }
    if (this.reviewsInterval) {
      clearInterval(this.reviewsInterval);
      this.reviewsInterval = null;
    }
    if (this.projectListInterval) {
      clearInterval(this.projectListInterval);
      this.projectListInterval = null;
    }
    if (this.workspaceListInterval) {
      clearInterval(this.workspaceListInterval);
      this.workspaceListInterval = null;
    }
    if (this.workspaceDetailInterval) {
      clearInterval(this.workspaceDetailInterval);
      this.workspaceDetailInterval = null;
    }
    if (this.adminInterval) {
      clearInterval(this.adminInterval);
      this.adminInterval = null;
    }
  }

  getReviewCount(): number {
    return this.lastReviewCount;
  }

  private async pollProjectSummaries(): Promise<void> {
    const projectIds = eventsHubService.getSubscribedProjectIds();
    if (projectIds.size === 0) {
      return;
    }

    await Promise.all(
      Array.from(projectIds).map(async (projectId) => {
        if (!this.shouldPoll(`project-summary:${projectId}`, PROJECT_SUMMARY_INTERVAL_MS)) {
          return;
        }
        const snapshot = await eventsSnapshotService.getProjectSummarySnapshot(
          projectId,
          this.lastReviewCount
        );
        eventsHubService.publishSnapshot({
          type: snapshot.type,
          payload: snapshot,
          cacheKey: `project-summary:${projectId}`,
          projectId,
        });
      })
    );
  }

  private async pollWorkspaceInitStatuses(): Promise<void> {
    const workspaceIds = eventsHubService.getSubscribedWorkspaceIds();
    if (workspaceIds.size === 0) {
      return;
    }

    await Promise.all(
      Array.from(workspaceIds).map(async (workspaceId) => {
        if (!this.shouldPoll(`workspace-init:${workspaceId}`, WORKSPACE_INIT_INTERVAL_MS)) {
          return;
        }
        const snapshot = await eventsSnapshotService.getWorkspaceInitStatusSnapshot(workspaceId);
        if (!snapshot) {
          return;
        }
        eventsHubService.publishSnapshot({
          type: snapshot.type,
          payload: snapshot,
          cacheKey: `workspace-init:${workspaceId}`,
          workspaceId,
        });
      })
    );
  }

  private async pollReviews(): Promise<void> {
    if (eventsHubService.getConnectionCount() === 0) {
      return;
    }

    if (!this.shouldPoll('reviews', REVIEWS_INTERVAL_MS)) {
      return;
    }

    const health = await githubCLIService.checkHealth();
    if (!(health.isInstalled && health.isAuthenticated)) {
      this.lastReviewCount = 0;
      eventsHubService.publishSnapshot({
        type: 'reviews_snapshot',
        payload: { type: 'reviews_snapshot', prs: [], health, error: null },
        cacheKey: 'reviews',
        scope: 'global',
      });
      return;
    }

    try {
      const prs = await githubCLIService.listReviewRequests();
      this.lastReviewCount = prs.filter((pr) => pr.reviewDecision !== 'APPROVED').length;
      eventsHubService.publishSnapshot({
        type: 'reviews_snapshot',
        payload: { type: 'reviews_snapshot', prs, health, error: null },
        cacheKey: 'reviews',
        scope: 'global',
      });
    } catch (error) {
      eventsHubService.publishSnapshot({
        type: 'reviews_snapshot',
        payload: {
          type: 'reviews_snapshot',
          prs: [],
          health,
          error: error instanceof Error ? error.message : 'Failed to fetch review requests',
        },
        cacheKey: 'reviews',
        scope: 'global',
      });
    }
  }

  private async pollProjectList(): Promise<void> {
    if (eventsHubService.getConnectionCount() === 0) {
      return;
    }

    if (!this.shouldPoll('project-list', PROJECT_LIST_INTERVAL_MS)) {
      return;
    }

    const snapshot = await eventsSnapshotService.getProjectListSnapshot();
    eventsHubService.publishSnapshot({
      type: snapshot.type,
      payload: snapshot,
      cacheKey: 'project-list',
      scope: 'global',
    });
  }

  private async pollWorkspaceLists(): Promise<void> {
    const projectIds = eventsHubService.getSubscribedProjectIds();
    if (projectIds.size === 0) {
      return;
    }

    await Promise.all(
      Array.from(projectIds).map(async (projectId) => {
        if (!this.shouldPoll(`workspace-list:${projectId}`, WORKSPACE_LIST_INTERVAL_MS)) {
          return;
        }
        const [listSnapshot, kanbanSnapshot] = await Promise.all([
          eventsSnapshotService.getWorkspaceListSnapshot(projectId),
          eventsSnapshotService.getKanbanSnapshot(projectId),
        ]);

        eventsHubService.publishSnapshot({
          type: listSnapshot.type,
          payload: listSnapshot,
          cacheKey: `workspace-list:${projectId}`,
          projectId,
        });

        eventsHubService.publishSnapshot({
          type: kanbanSnapshot.type,
          payload: kanbanSnapshot,
          cacheKey: `kanban:${projectId}`,
          projectId,
        });
      })
    );
  }

  private async pollWorkspaceDetails(): Promise<void> {
    const workspaceIds = eventsHubService.getSubscribedWorkspaceIds();
    if (workspaceIds.size === 0) {
      return;
    }

    await Promise.all(
      Array.from(workspaceIds).map(async (workspaceId) => {
        if (!this.shouldPoll(`workspace-detail:${workspaceId}`, WORKSPACE_DETAIL_INTERVAL_MS)) {
          return;
        }
        const [detailSnapshot, sessionSnapshot] = await Promise.all([
          eventsSnapshotService.getWorkspaceDetailSnapshot(workspaceId),
          eventsSnapshotService.getSessionListSnapshot(workspaceId),
        ]);

        if (detailSnapshot) {
          eventsHubService.publishSnapshot({
            type: detailSnapshot.type,
            payload: detailSnapshot,
            cacheKey: `workspace-detail:${workspaceId}`,
            workspaceId,
          });
        }

        eventsHubService.publishSnapshot({
          type: sessionSnapshot.type,
          payload: sessionSnapshot,
          cacheKey: `session-list:${workspaceId}`,
          workspaceId,
        });
      })
    );
  }

  private async pollAdminSnapshots(): Promise<void> {
    if (eventsHubService.getConnectionCount() === 0) {
      return;
    }

    if (this.shouldPoll('admin-stats', ADMIN_INTERVAL_MS)) {
      const statsSnapshot = eventsSnapshotService.getAdminStatsSnapshot();
      eventsHubService.publishSnapshot({
        type: statsSnapshot.type,
        payload: statsSnapshot,
        cacheKey: 'admin-stats',
        scope: 'global',
      });
    }

    if (this.shouldPoll('admin-processes', ADMIN_INTERVAL_MS)) {
      const processesSnapshot = await eventsSnapshotService.getAdminProcessesSnapshot();
      eventsHubService.publishSnapshot({
        type: processesSnapshot.type,
        payload: processesSnapshot,
        cacheKey: 'admin-processes',
        scope: 'global',
      });
    }
  }

  private shouldPoll(cacheKey: string, intervalMs: number): boolean {
    const lastPolled = this.lastPollAt.get(cacheKey) ?? 0;
    const lastPublished = eventsHubService.getLastPublishedAt(cacheKey) ?? 0;
    const last = Math.max(lastPolled, lastPublished);
    const now = Date.now();
    if (now - last < intervalMs) {
      return false;
    }
    this.lastPollAt.set(cacheKey, now);
    return true;
  }
}

export const eventsPollerService = new EventsPollerService();
