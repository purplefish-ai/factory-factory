import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockGetWorkspaceOrder = vi.hoisted(() => vi.fn());
const mockUpdateWorkspaceOrder = vi.hoisted(() => vi.fn());
const mockExecCommand = vi.hoisted(() => vi.fn());

vi.mock('@/backend/domains/workspace', () => ({
  userSettingsQueryService: {
    get: (...args: unknown[]) => mockGet(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    getWorkspaceOrder: (...args: unknown[]) => mockGetWorkspaceOrder(...args),
    updateWorkspaceOrder: (...args: unknown[]) => mockUpdateWorkspaceOrder(...args),
  },
}));

vi.mock('@/backend/lib/shell', () => ({
  execCommand: (...args: unknown[]) => mockExecCommand(...args),
}));

import { userSettingsRouter } from './user-settings.trpc';

function createCaller() {
  return userSettingsRouter.createCaller({ appContext: {} } as never);
}

describe('userSettingsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gets and updates settings', async () => {
    mockGet.mockResolvedValue({ preferredIde: 'cursor', customIdeCommand: null });
    mockUpdate.mockResolvedValue({ preferredIde: 'vscode', customIdeCommand: null });

    const caller = createCaller();
    await expect(caller.get()).resolves.toEqual({ preferredIde: 'cursor', customIdeCommand: null });
    await expect(
      caller.update({ preferredIde: 'vscode', playSoundOnComplete: true })
    ).resolves.toEqual({ preferredIde: 'vscode', customIdeCommand: null });

    expect(mockUpdate).toHaveBeenCalledWith({ preferredIde: 'vscode', playSoundOnComplete: true });
  });

  it('requires command when preferred ide is custom', async () => {
    const caller = createCaller();
    await expect(caller.update({ preferredIde: 'custom' })).rejects.toThrow(
      'Custom IDE command is required when using custom IDE'
    );
  });

  it('tests custom command and validates command format', async () => {
    mockExecCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const caller = createCaller();

    await expect(caller.testCustomCommand({ customCommand: 'echo {workspace}' })).resolves.toEqual({
      success: true,
      message: 'Command executed successfully',
    });
    expect(mockExecCommand).toHaveBeenCalled();

    await expect(caller.testCustomCommand({ customCommand: 'echo nope' })).rejects.toThrow(
      'Command must include {workspace} placeholder'
    );

    await expect(
      caller.testCustomCommand({ customCommand: 'echo {workspace}; rm -rf /' })
    ).rejects.toThrow('Command contains invalid shell metacharacters');

    mockExecCommand.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(caller.testCustomCommand({ customCommand: 'echo {workspace}' })).rejects.toThrow(
      'Command failed: spawn failed'
    );
  });

  it('gets and updates workspace order', async () => {
    mockGetWorkspaceOrder.mockResolvedValue(['w2', 'w1']);
    mockUpdateWorkspaceOrder.mockResolvedValue(undefined);

    const caller = createCaller();
    await expect(caller.getWorkspaceOrder({ projectId: 'p1' })).resolves.toEqual(['w2', 'w1']);
    await expect(
      caller.updateWorkspaceOrder({ projectId: 'p1', workspaceIds: ['w1', 'w2'] })
    ).resolves.toEqual({ success: true });

    expect(mockUpdateWorkspaceOrder).toHaveBeenCalledWith('p1', ['w1', 'w2']);
  });
});
