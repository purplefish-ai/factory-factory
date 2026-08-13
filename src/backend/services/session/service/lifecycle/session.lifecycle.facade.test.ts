import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceNotificationService } from '@/backend/services/workspace';
import {
  createLifecycleHarness,
  createPendingWorkspaceNotification,
} from './session-lifecycle.test-helpers';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(),
    markDelivered: vi.fn(),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(async () => ({
      defaultWorkspacePermissions: 'STRICT',
      ratchetPermissions: 'YOLO',
    })),
  },
}));

it('creates isolated lifecycle harness state', () => {
  const first = createLifecycleHarness();
  const second = createLifecycleHarness();
  expect(first.repository.getSessionById).not.toBe(second.repository.getSessionById);
  expect(first.runtimeManager.getClient).not.toBe(second.runtimeManager.getClient);
});

it('preserves an explicit null lifecycle provider process ID', () =>
  expect(
    createLifecycleHarness({ providerProcessPid: null }).session.providerProcessPid
  ).toBeNull());

describe('SessionLifecycleFacade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceNotificationService.listPendingForDelivery).mockResolvedValue([
      createPendingWorkspaceNotification(),
    ] as never);
  });

  it('skips the restart default continue prompt when notifications are queued', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createLifecycleHarness();

    await service.restartSession('session-1');

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('sends an explicit restart prompt after queued notification dispatch starts', async () => {
    const { service, sendSessionMessage, tryDispatchNextMessage } = createLifecycleHarness();

    await service.restartSession('session-1', {
      initialPrompt: 'Fix the failing checks',
      startupModePreset: 'non_interactive',
    });

    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    expect(sendSessionMessage).toHaveBeenCalledWith('session-1', 'Fix the failing checks');
    const dispatchOrder = tryDispatchNextMessage.mock.invocationCallOrder[0];
    const sendOrder = sendSessionMessage.mock.invocationCallOrder[0];
    expect(dispatchOrder).toBeDefined();
    expect(sendOrder).toBeDefined();
    expect(dispatchOrder!).toBeLessThan(sendOrder!);
  });
});
