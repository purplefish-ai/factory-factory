import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: vi.fn().mockResolvedValue({ name: 'Test Workspace', agentSessions: [] }),
  },
}));

import { workspaceActivityService } from './activity.service';

describe('WorkspaceActivityService', () => {
  const workspaceIds: string[] = [];

  afterEach(() => {
    for (const workspaceId of workspaceIds) {
      workspaceActivityService.clearWorkspace(workspaceId);
    }
    workspaceIds.length = 0;
  });

  it('emits workspace_idle once when duplicate idle transitions occur', () => {
    const workspaceId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    workspaceIds.push(workspaceId);
    const sessionId = 's1';
    let idleCount = 0;
    const onIdle = () => {
      idleCount += 1;
    };

    workspaceActivityService.on('workspace_idle', onIdle);

    workspaceActivityService.markSessionRunning(workspaceId, sessionId);
    workspaceActivityService.markSessionIdle(workspaceId, sessionId);
    // Second idle call for the same session should be a no-op.
    workspaceActivityService.markSessionIdle(workspaceId, sessionId);

    workspaceActivityService.off('workspace_idle', onIdle);

    expect(idleCount).toBe(1);
  });

  it('ignores stale idle transitions from older prompt generations', () => {
    const workspaceId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    workspaceIds.push(workspaceId);
    const sessionId = 's1';
    let idleCount = 0;
    const onIdle = () => {
      idleCount += 1;
    };

    workspaceActivityService.on('workspace_idle', onIdle);

    const firstGeneration = workspaceActivityService.markSessionRunning(workspaceId, sessionId);
    const secondGeneration = workspaceActivityService.markSessionRunning(workspaceId, sessionId);

    workspaceActivityService.markSessionIdle(workspaceId, sessionId, firstGeneration);

    expect(workspaceActivityService.isWorkspaceActive(workspaceId)).toBe(true);
    expect(workspaceActivityService.getRunningSessionCount(workspaceId)).toBe(1);
    expect(idleCount).toBe(0);

    workspaceActivityService.markSessionIdle(workspaceId, sessionId, secondGeneration);
    workspaceActivityService.off('workspace_idle', onIdle);

    expect(workspaceActivityService.isWorkspaceActive(workspaceId)).toBe(false);
    expect(idleCount).toBe(1);
  });

  it('allows unguarded idle transitions to clear the current session during stop cleanup', () => {
    const workspaceId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    workspaceIds.push(workspaceId);
    const sessionId = 's1';

    workspaceActivityService.markSessionRunning(workspaceId, sessionId);
    workspaceActivityService.markSessionRunning(workspaceId, sessionId);

    workspaceActivityService.markSessionIdle(workspaceId, sessionId);

    expect(workspaceActivityService.isWorkspaceActive(workspaceId)).toBe(false);
    expect(workspaceActivityService.getRunningSessionCount(workspaceId)).toBe(0);
  });
});
