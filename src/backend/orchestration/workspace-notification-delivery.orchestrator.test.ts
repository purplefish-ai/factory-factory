import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliverWorkspaceNotification,
  recoverWorkspaceMail,
} from './workspace-notification-delivery.orchestrator';

const mocks = vi.hoisted(() => ({
  findSessions: vi.fn(),
  recover: vi.fn(),
  snapshot: vi.fn(),
  owned: vi.fn(),
  dispatch: vi.fn(),
  steer: vi.fn(),
  persistChild: vi.fn(),
  persistParent: vi.fn(),
  append: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: mocks.warn, debug: vi.fn() }),
}));
vi.mock('@/backend/services/session', () => ({
  sessionDataService: { findAgentSessionsByWorkspaceId: mocks.findSessions },
  sessionNotificationDeliveryService: {
    recoverPending: mocks.recover,
    isOwnedMailSignal: mocks.owned,
  },
  sessionDomainService: { getQueueSnapshot: mocks.snapshot, appendClaudeEvent: mocks.append },
  sessionDispatchService: {
    tryDispatchNextMessage: mocks.dispatch,
    steerWorkspaceMailSignal: mocks.steer,
  },
}));
vi.mock('./workspace-notification-persistence.orchestrator', () => ({
  persistChildNotification: mocks.persistChild,
  persistParentNotification: mocks.persistParent,
}));
const input = {
  direction: 'CHILD_TO_PARENT' as const,
  targetWorkspaceId: 'parent',
  sourceWorkspace: { id: 'child', name: 'child', projectName: 'project' },
  message: 'a private report body',
  subject: 'Report',
  kind: 'COMPLETION' as const,
  taskKey: 'build',
  taskRevision: 2,
  buildUiEvent: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.persistChild.mockResolvedValue({ id: 'mail-1' });
  mocks.persistParent.mockResolvedValue({ id: 'mail-1' });
  mocks.findSessions.mockResolvedValue([
    { id: 'old', status: 'RUNNING' },
    { id: 'active', status: 'IDLE' },
  ]);
  mocks.recover.mockResolvedValue({ dispatchableCount: 1 });
  mocks.snapshot.mockReturnValue([
    { id: 'workspace-mail-wake-parent:2', text: 'You have workspace mail.' },
  ]);
  mocks.owned.mockReturnValue(true);
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.steer.mockResolvedValue(undefined);
});

describe('workspace mail delivery orchestration', () => {
  it('persists metadata first, queues a signal, and truthfully reports persistence separately from delivery', async () => {
    expect(await deliverWorkspaceNotification(input)).toEqual({
      delivered: false,
      persisted: true,
      queued: true,
      notificationId: 'mail-1',
    });
    expect(mocks.persistChild).toHaveBeenCalledWith({
      parentWorkspaceId: 'parent',
      sourceWorkspaceId: 'child',
      message: input.message,
      subject: 'Report',
      kind: 'COMPLETION',
      taskKey: 'build',
      taskRevision: 2,
    });
    expect(mocks.recover).toHaveBeenCalledWith({
      sessionId: 'active',
      workspaceId: 'parent',
      preferSession: true,
      assertAllowed: expect.any(Function),
    });
    expect(mocks.dispatch).toHaveBeenCalledWith('active');
    expect(input.buildUiEvent).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.persistChild.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recover.mock.invocationCallOrder[0]!
    );
  });
  it('forwards parent-to-child metadata and wakes the child workspace', async () => {
    await deliverWorkspaceNotification({
      ...input,
      direction: 'PARENT_TO_CHILD',
      targetWorkspaceId: 'child',
      sourceWorkspace: { id: 'parent', name: 'parent', projectName: 'project' },
    });
    expect(mocks.persistParent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentWorkspaceId: 'parent',
        targetChildWorkspaceId: 'child',
        kind: 'COMPLETION',
        taskRevision: 2,
      })
    );
    expect(mocks.findSessions).toHaveBeenCalledExactlyOnceWith('child');
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'active',
      workspaceId: 'child',
      preferSession: true,
      assertAllowed: expect.any(Function),
    });
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith('active');
  });
  it('attempts native signal steering during a busy session without waiting for its turn', async () => {
    mocks.findSessions.mockResolvedValue([{ id: 'busy', status: 'RUNNING' }]);
    mocks.steer.mockReturnValue(new Promise(() => undefined));
    expect(await deliverWorkspaceNotification(input)).toMatchObject({
      persisted: true,
      queued: true,
      delivered: false,
    });
    expect(mocks.steer).toHaveBeenCalledWith('busy', 'workspace-mail-wake-parent:2');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it('keeps unsupported native signal steering queued for turn completion', async () => {
    mocks.findSessions.mockResolvedValue([{ id: 'busy', status: 'RUNNING' }]);
    mocks.steer.mockRejectedValue(new Error('adapter unsupported'));
    await expect(deliverWorkspaceNotification(input)).resolves.toMatchObject({
      persisted: true,
      queued: true,
    });
  });
  it('kicks queue progress when recovery finds no dispatchable wake', async () => {
    mocks.recover.mockResolvedValue({ dispatchableCount: 0 });
    mocks.snapshot.mockReturnValue([]);
    expect(await recoverWorkspaceMail('parent')).toEqual({ queued: false });
    expect(mocks.dispatch).toHaveBeenCalledWith('active');
  });
  it('returns promptly while idle dispatch owns an entire provider turn', async () => {
    mocks.dispatch.mockReturnValue(new Promise(() => undefined));
    await expect(deliverWorkspaceNotification(input)).resolves.toMatchObject({
      persisted: true,
      queued: true,
    });
  });
  it('logs a rejected detached dispatch while preserving the persisted-mail result', async () => {
    const error = new Error('dispatch unavailable');
    mocks.dispatch.mockRejectedValueOnce(error);

    await expect(deliverWorkspaceNotification(input)).resolves.toEqual({
      persisted: true,
      queued: true,
      delivered: false,
      notificationId: 'mail-1',
    });
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('Workspace mail queue progress deferred', {
      sessionId: 'active',
      error,
    });
  });
  it('leaves persisted mail for startup when the recipient has no active session', async () => {
    mocks.findSessions.mockResolvedValue([{ id: 'stopped', status: 'STOPPED' }]);
    expect(await deliverWorkspaceNotification(input)).toEqual({
      persisted: true,
      queued: false,
      delivered: false,
      notificationId: 'mail-1',
    });
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('does not attempt a wake when persistence could not resolve the workspace', async () => {
    mocks.persistChild.mockResolvedValue(null);
    expect(await deliverWorkspaceNotification(input)).toEqual({ delivered: false });
    expect(mocks.findSessions).not.toHaveBeenCalled();
  });
});

it('preserves persisted-mail confirmation when recipient wake lookup fails', async () => {
  mocks.findSessions.mockRejectedValueOnce(new Error('temporary recipient lookup failure'));
  await expect(deliverWorkspaceNotification(input)).resolves.toEqual({
    persisted: true,
    queued: false,
    delivered: false,
    notificationId: 'mail-1',
  });
  expect(mocks.persistChild).toHaveBeenCalledOnce();
});
