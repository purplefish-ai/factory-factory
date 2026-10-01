import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());
const mockSet = vi.hoisted(() => vi.fn());
const mockClear = vi.hoisted(() => vi.fn());
const mockSettingsGet = vi.hoisted(() => vi.fn());

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
      },
    },
  } as never);
}

describe('workspaceWakeRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue({ workspaceId: 'ws-1', cadence: 'EVERY_HOUR' });
  });

  it('gets and clears the schedule for a workspace', async () => {
    mockGet.mockResolvedValue({ workspaceId: 'ws-1' });

    const caller = createCaller();
    await expect(caller.get({ workspaceId: 'ws-1' })).resolves.toEqual({ workspaceId: 'ws-1' });
    await expect(caller.clear({ workspaceId: 'ws-1' })).resolves.toEqual({ success: true });

    expect(mockGet).toHaveBeenCalledWith('ws-1');
    expect(mockClear).toHaveBeenCalledWith('ws-1');
  });

  it('sets the schedule without a warning when the default preset is YOLO', async () => {
    mockSettingsGet.mockResolvedValue({ defaultWorkspacePermissions: 'YOLO' });

    const caller = createCaller();
    const result = await caller.set({
      workspaceId: 'ws-1',
      cadence: 'EVERY_HOUR',
      prompt: 'Check the logs',
    });

    expect(mockSet).toHaveBeenCalledWith('ws-1', {
      cadence: 'EVERY_HOUR',
      prompt: 'Check the logs',
    });
    expect(result.schedule).toEqual({ workspaceId: 'ws-1', cadence: 'EVERY_HOUR' });
    expect(result.permissionWarning).toBeNull();
  });

  it.each(['STRICT', 'RELAXED'])(
    'warns when the default preset is %s, since wake turns run unattended',
    async (preset) => {
      mockSettingsGet.mockResolvedValue({ defaultWorkspacePermissions: preset });

      const caller = createCaller();
      const result = await caller.set({
        workspaceId: 'ws-1',
        cadence: 'DAILY',
        prompt: 'Check the logs',
      });

      expect(result.permissionWarning).toContain(preset);
      expect(result.permissionWarning).toContain('unattended');
    }
  );
});
