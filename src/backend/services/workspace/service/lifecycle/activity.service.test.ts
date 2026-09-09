import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockFindById } = vi.hoisted(() => ({
  mockFindById: vi.fn().mockResolvedValue({ name: 'Test Workspace', agentSessions: [] }),
}));

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: mockFindById,
  },
}));

import { workspaceActivityService } from './activity.service';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushNotifications(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('WorkspaceActivityService', () => {
  it('counts unique sessions in each busy interval for notifications', async () => {
    const workspaceId = 'notification-count';
    workspaceIds.push(workspaceId);
    const notifications: number[] = [];
    const onNotification = (event: { workspaceId: string; sessionCount: number }) => {
      if (event.workspaceId === workspaceId) {
        notifications.push(event.sessionCount);
      }
    };
    workspaceActivityService.on('request_notification', onNotification);
    try {
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionRunning(workspaceId, 's2');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      workspaceActivityService.markSessionRunning(workspaceId, 's3');
      workspaceActivityService.markSessionIdle(workspaceId, 's2');
      workspaceActivityService.markSessionIdle(workspaceId, 's3');

      // Start another interval before the prior notification's DB lookup resolves.
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      await flushNotifications();

      expect(notifications).toEqual([3, 1]);
    } finally {
      workspaceActivityService.off('request_notification', onNotification);
    }
  });

  it('preserves busy interval order while an earlier workspace lookup is pending', async () => {
    const workspaceId = 'notification-order';
    workspaceIds.push(workspaceId);
    const lookup = createDeferred<{ name: string }>();
    mockFindById.mockReturnValueOnce(lookup.promise);
    const notifications: number[] = [];
    const onNotification = (event: { workspaceId: string; sessionCount: number }) => {
      if (event.workspaceId === workspaceId) {
        notifications.push(event.sessionCount);
      }
    };
    workspaceActivityService.on('request_notification', onNotification);
    try {
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionRunning(workspaceId, 's2');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      workspaceActivityService.markSessionIdle(workspaceId, 's2');
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      await flushNotifications();

      expect(notifications).toEqual([]);
      expect(mockFindById).toHaveBeenCalledTimes(1);
      lookup.resolve({ name: 'Test Workspace' });
      await flushNotifications();
      expect(notifications).toEqual([2, 1]);
    } finally {
      lookup.resolve({ name: 'Test Workspace' });
      await flushNotifications();
      workspaceActivityService.off('request_notification', onNotification);
    }
  });

  it('allows other workspaces to notify while a workspace lookup is pending', async () => {
    const workspaceId = 'notification-slow';
    const otherWorkspaceId = 'notification-independent';
    workspaceIds.push(workspaceId, otherWorkspaceId);
    const lookup = createDeferred<{ name: string }>();
    mockFindById.mockReturnValueOnce(lookup.promise);
    const notifications: string[] = [];
    const onNotification = (event: { workspaceId: string }) => {
      notifications.push(event.workspaceId);
    };
    workspaceActivityService.on('request_notification', onNotification);
    try {
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      workspaceActivityService.markSessionRunning(otherWorkspaceId, 's1');
      workspaceActivityService.markSessionIdle(otherWorkspaceId, 's1');
      await flushNotifications();

      expect(notifications).toEqual([otherWorkspaceId]);
      lookup.resolve({ name: 'Test Workspace' });
      await flushNotifications();
      expect(notifications).toEqual([otherWorkspaceId, workspaceId]);
    } finally {
      lookup.resolve({ name: 'Test Workspace' });
      await flushNotifications();
      workspaceActivityService.off('request_notification', onNotification);
    }
  });

  it('continues queued notifications after a workspace lookup fails', async () => {
    const workspaceId = 'notification-failure';
    workspaceIds.push(workspaceId);
    const lookup = createDeferred<{ name: string }>();
    mockFindById.mockReturnValueOnce(lookup.promise);
    const onNotification = vi.fn();
    workspaceActivityService.on('request_notification', onNotification);
    try {
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionRunning(workspaceId, 's2');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      workspaceActivityService.markSessionIdle(workspaceId, 's2');
      workspaceActivityService.markSessionRunning(workspaceId, 's1');
      workspaceActivityService.markSessionIdle(workspaceId, 's1');
      await flushNotifications();
      expect(onNotification).not.toHaveBeenCalled();

      lookup.reject(new Error('Lookup failed'));
      await flushNotifications();
      expect(onNotification).toHaveBeenCalledExactlyOnceWith({
        workspaceId,
        workspaceName: 'Test Workspace',
        sessionCount: 1,
        finishedAt: expect.any(Date),
      });
    } finally {
      lookup.resolve({ name: 'Test Workspace' });
      await flushNotifications();
      workspaceActivityService.off('request_notification', onNotification);
    }
  });

  const workspaceIds: string[] = [];

  afterEach(async () => {
    await flushNotifications();
    mockFindById.mockClear();
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
