import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());
const mockSet = vi.hoisted(() => vi.fn());
const mockClear = vi.hoisted(() => vi.fn());
const mockSettingsGet = vi.hoisted(() => vi.fn());
const mockFindAgentSessionsByWorkspaceId = vi.hoisted(() => vi.fn());

import { workspaceWakeRouter } from './workspace-wake.trpc';

function createCaller() {
  return workspaceWakeRouter.createCaller({
    appContext: {
      services: {
        workspaceWakeService: {
          get: (...args: unknown[]) => mockGet(...args),
          set: (...args: unknown[]) => mockSet(...args),
          clear: (...args: unknown[]) => mockClear(...args),
        },
        userSettingsQueryService: {
          get: (...args: unknown[]) => mockSettingsGet(...args),
        },
        sessionDataService: {
          findAgentSessionsByWorkspaceId: (...args: unknown[]) =>
            mockFindAgentSessionsByWorkspaceId(...args),
        },
      },
    },
  } as never);
}

describe('workspaceWakeRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue({ workspaceId: 'ws-1', cadence: 'EVERY_HOUR' });
    mockFindAgentSessionsByWorkspaceId.mockResolvedValue([]);
  });

  it('gets and clears the schedule for a workspace', async () => {
    mockGet.mockResolvedValue({ workspaceId: 'ws-1' });

    const caller = createCaller();
    await expect(caller.get({ workspaceId: 'ws-1' })).resolves.toEqual({ workspaceId: 'ws-1' });
    await expect(caller.clear({ workspaceId: 'ws-1' })).resolves.toEqual({ success: true });

    expect(mockGet).toHaveBeenCalledWith('ws-1');
    expect(mockClear).toHaveBeenCalledWith('ws-1');
  });

  it.each(['YOLO', 'RELAXED'])(
    'sets the schedule without a warning when the default preset is %s (auto-approving)',
    async (preset) => {
      mockSettingsGet.mockResolvedValue({ defaultWorkspacePermissions: preset });

      const caller = createCaller();
      const result = await caller.set({
        workspaceId: 'ws-1',
        cadence: 'EVERY_HOUR',
        prompt: 'Check the logs',
        scheduledTime: '09:30',
        timezone: 'America/New_York',
      });

      expect(mockSet).toHaveBeenCalledWith('ws-1', {
        cadence: 'EVERY_HOUR',
        prompt: 'Check the logs',
        scheduledTime: '09:30',
        timezone: 'America/New_York',
      });
      expect(result.schedule).toEqual({ workspaceId: 'ws-1', cadence: 'EVERY_HOUR' });
      expect(result.permissionWarning).toBeNull();
    }
  );

  it('warns when the default preset is STRICT, since wake turns run unattended', async () => {
    mockSettingsGet.mockResolvedValue({ defaultWorkspacePermissions: 'STRICT' });

    const caller = createCaller();
    const result = await caller.set({
      workspaceId: 'ws-1',
      cadence: 'DAILY',
      prompt: 'Check the logs',
    });

    expect(result.permissionWarning).toContain('STRICT');
    expect(result.permissionWarning).toContain('unattended');
  });

  it('resolves the warning from the most recently updated session’s workflow preset, not the default', async () => {
    mockSettingsGet.mockResolvedValue({
      defaultWorkspacePermissions: 'YOLO',
      ratchetPermissions: 'STRICT',
    });
    mockFindAgentSessionsByWorkspaceId.mockResolvedValue([
      { workflow: 'chat', updatedAt: new Date('2026-01-01T00:00:00.000Z') },
      { workflow: 'ratchet', updatedAt: new Date('2026-01-02T00:00:00.000Z') },
    ]);

    const caller = createCaller();
    const result = await caller.set({
      workspaceId: 'ws-1',
      cadence: 'DAILY',
      prompt: 'Check the logs',
    });

    expect(result.permissionWarning).toContain('STRICT');
  });
});
