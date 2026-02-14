import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
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
});
