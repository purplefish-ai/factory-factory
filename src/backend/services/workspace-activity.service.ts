/**
 * Workspace Activity Service
 *
 * Tracks the running state of all Claude sessions per workspace.
 * Emits events when all sessions in a workspace finish.
 *
 * NOTE: Session idle events no longer trigger notifications directly.
 * Notifications are triggered by kanban state transitions (see kanban-state.service.ts).
 */

import { EventEmitter } from 'node:events';
import { createLogger } from './logger.service';

const logger = createLogger('workspace-activity');

interface WorkspaceActivityState {
  workspaceId: string;
  runningSessions: Set<string>; // Set of session IDs currently running
  lastActivityAt: Date;
}

class WorkspaceActivityService extends EventEmitter {
  private workspaceStates = new Map<string, WorkspaceActivityState>();

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
