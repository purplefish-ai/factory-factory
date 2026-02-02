/**
 * Workspace Activity Service
 *
 * Tracks the running state of all Claude sessions per workspace.
 * Emits events when all sessions in a workspace finish.
 */

import { EventEmitter } from 'node:events';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { eventsHubService } from './events-hub.service';
import { eventsPollerService } from './events-poller.service';
import { eventsSnapshotService } from './events-snapshot.service';
import { createLogger } from './logger.service';

const logger = createLogger('workspace-activity');

interface WorkspaceActivityState {
  workspaceId: string;
  runningSessions: Set<string>; // Set of session IDs currently running
  lastActivityAt: Date;
}

class WorkspaceActivityService extends EventEmitter {
  private workspaceStates = new Map<string, WorkspaceActivityState>();

  constructor() {
    super();

    const publishProjectSummary = async (workspaceId: string) => {
      try {
        const workspace = await workspaceAccessor.findById(workspaceId);
        if (!workspace?.projectId) {
          return;
        }
        const subscribedProjects = eventsHubService.getSubscribedProjectIds();
        if (!subscribedProjects.has(workspace.projectId)) {
          return;
        }
        const snapshot = await eventsSnapshotService.getProjectSummarySnapshot(
          workspace.projectId,
          eventsPollerService.getReviewCount()
        );
        eventsHubService.publishSnapshot({
          type: snapshot.type,
          payload: snapshot,
          cacheKey: `project-summary:${workspace.projectId}`,
          projectId: workspace.projectId,
        });
      } catch (error) {
        logger.debug('Failed to publish project summary snapshot', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const publishSessionList = async (workspaceId: string) => {
      try {
        const subscribed = eventsHubService.getSubscribedWorkspaceIds();
        if (!subscribed.has(workspaceId)) {
          return;
        }
        const snapshot = await eventsSnapshotService.getSessionListSnapshot(workspaceId);
        eventsHubService.publishSnapshot({
          type: snapshot.type,
          payload: snapshot,
          cacheKey: `session-list:${workspaceId}`,
          workspaceId,
        });
      } catch (error) {
        logger.debug('Failed to publish session list snapshot', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Listen for workspace idle events and trigger notification requests
    this.on('workspace_idle', async ({ workspaceId, finishedAt }) => {
      try {
        const workspace = await workspaceAccessor.findById(workspaceId);
        if (!workspace) {
          logger.warn('Workspace not found for notification', { workspaceId });
          return;
        }

        // Emit event to frontend for suppression check
        this.emit('request_notification', {
          workspaceId,
          workspaceName: workspace.name,
          sessionCount: workspace.claudeSessions.length,
          finishedAt,
        });
        await publishProjectSummary(workspaceId);
        await publishSessionList(workspaceId);
      } catch (error) {
        logger.error('Failed to process workspace idle event', error as Error, { workspaceId });
      }
    });

    this.on('workspace_active', async ({ workspaceId }) => {
      await publishProjectSummary(workspaceId);
      await publishSessionList(workspaceId);
    });
  }

  /**
   * Mark a session as started/running in a workspace
   */
  markSessionRunning(workspaceId: string, sessionId: string): void {
    let state = this.workspaceStates.get(workspaceId);

    if (!state) {
      state = {
        workspaceId,
        runningSessions: new Set(),
        lastActivityAt: new Date(),
      };
      this.workspaceStates.set(workspaceId, state);
    }

    const wasIdle = state.runningSessions.size === 0;
    state.runningSessions.add(sessionId);
    state.lastActivityAt = new Date();

    if (wasIdle) {
      logger.debug('Workspace became active', { workspaceId, sessionId });
      this.emit('workspace_active', { workspaceId });
    }
  }

  /**
   * Mark a session as finished/idle in a workspace
   */
  markSessionIdle(workspaceId: string, sessionId: string): void {
    const state = this.workspaceStates.get(workspaceId);

    if (!state) {
      return; // No state tracked for this workspace
    }

    state.runningSessions.delete(sessionId);
    state.lastActivityAt = new Date();

    if (state.runningSessions.size === 0) {
      logger.info('All sessions finished in workspace', { workspaceId });
      this.emit('workspace_idle', {
        workspaceId,
        finishedAt: state.lastActivityAt,
      });
    }
  }

  /**
   * Check if any sessions are running in a workspace
   */
  isWorkspaceActive(workspaceId: string): boolean {
    const state = this.workspaceStates.get(workspaceId);
    return state ? state.runningSessions.size > 0 : false;
  }

  /**
   * Get count of running sessions in a workspace
   */
  getRunningSessionCount(workspaceId: string): number {
    const state = this.workspaceStates.get(workspaceId);
    return state ? state.runningSessions.size : 0;
  }

  /**
   * Clear workspace state when workspace is archived/deleted
   */
  clearWorkspace(workspaceId: string): void {
    this.workspaceStates.delete(workspaceId);
  }
}

export const workspaceActivityService = new WorkspaceActivityService();
