/**
 * Workspace Activity Service
 *
 * Tracks the running state of all Claude sessions per workspace.
 * Emits events when all sessions in a workspace finish.
 */

import { EventEmitter } from 'node:events';
import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';

const logger = createLogger('workspace-activity');

interface WorkspaceActivityState {
  workspaceId: string;
  runningSessions: Map<string, number>; // Session ID to current activity generation.
  participatingSessions: Set<string>; // Unique sessions in the current busy interval.
  currentGeneration: number;
  lastActivityAt: Date;
}

class WorkspaceActivityService extends EventEmitter {
  private workspaceStates = new Map<string, WorkspaceActivityState>();
  private readonly notificationChains = new Map<string, Promise<void>>();

  constructor() {
    super();

    // Serialize each workspace's lookups so busy intervals notify in idle order.
    this.on('workspace_idle', ({ workspaceId, finishedAt, sessionCount }) => {
      const activityState = this.workspaceStates.get(workspaceId);
      const previous = this.notificationChains.get(workspaceId) ?? Promise.resolve();
      const notification = previous
        .then(async () => {
          const workspace = await workspaceAccessor.findById(workspaceId);
          if (!workspace) {
            logger.warn('Workspace not found for notification', { workspaceId });
            return;
          }

          // Clearing a workspace invalidates its queued notifications, even if
          // activity starts again before this lookup resolves.
          if (!activityState || this.workspaceStates.get(workspaceId) !== activityState) {
            return;
          }

          // Emit event to frontend for suppression check.
          this.emit('request_notification', {
            workspaceId,
            workspaceName: workspace.name,
            sessionCount,
            finishedAt,
          });
        })
        .catch((error) => {
          logger.error('Failed to process workspace idle event', toError(error), { workspaceId });
        })
        .finally(() => {
          if (this.notificationChains.get(workspaceId) === notification) {
            this.notificationChains.delete(workspaceId);
          }
        });
      this.notificationChains.set(workspaceId, notification);
    });
  }

  /**
   * Mark a session as started/running in a workspace
   */
  markSessionRunning(workspaceId: string, sessionId: string): number {
    let state = this.workspaceStates.get(workspaceId);

    if (!state) {
      state = {
        workspaceId,
        runningSessions: new Map(),
        participatingSessions: new Set(),
        currentGeneration: 0,
        lastActivityAt: new Date(),
      };
      this.workspaceStates.set(workspaceId, state);
    }

    const wasIdle = state.runningSessions.size === 0;
    if (wasIdle) {
      state.participatingSessions.clear();
    }
    state.participatingSessions.add(sessionId);
    state.currentGeneration += 1;
    const generation = state.currentGeneration;
    state.runningSessions.set(sessionId, generation);
    state.lastActivityAt = new Date();

    this.emit('session_activity_changed', {
      workspaceId,
      sessionId,
      isWorking: true,
      runningSessionCount: state.runningSessions.size,
      updatedAt: state.lastActivityAt,
    });

    if (wasIdle) {
      logger.debug('Workspace became active', { workspaceId, sessionId });
      this.emit('workspace_active', { workspaceId });
    }

    return generation;
  }

  /**
   * Mark a session as finished/idle in a workspace
   */
  markSessionIdle(workspaceId: string, sessionId: string, generation?: number): void {
    const state = this.workspaceStates.get(workspaceId);

    if (!state) {
      return; // No state tracked for this workspace
    }

    const currentGeneration = state.runningSessions.get(sessionId);
    if (currentGeneration === undefined) {
      return;
    }

    if (generation !== undefined && currentGeneration !== generation) {
      logger.debug('Ignoring stale workspace session idle transition', {
        workspaceId,
        sessionId,
        generation,
        currentGeneration,
      });
      return;
    }

    const wasActive = state.runningSessions.size > 0;
    state.runningSessions.delete(sessionId);
    state.lastActivityAt = new Date();

    this.emit('session_activity_changed', {
      workspaceId,
      sessionId,
      isWorking: false,
      runningSessionCount: state.runningSessions.size,
      updatedAt: state.lastActivityAt,
    });

    if (wasActive && state.runningSessions.size === 0) {
      logger.info('All sessions finished in workspace', { workspaceId });
      this.emit('workspace_idle', {
        workspaceId,
        finishedAt: state.lastActivityAt,
        sessionCount: state.participatingSessions.size,
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
