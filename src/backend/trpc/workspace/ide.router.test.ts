import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindById = vi.hoisted(() => vi.fn());
const mockGetUserSettings = vi.hoisted(() => vi.fn());
const mockCheckIdeAvailable = vi.hoisted(() => vi.fn());
const mockOpenPathInIde = vi.hoisted(() => vi.fn());

vi.mock('@/backend/domains/workspace', () => ({
  workspaceDataService: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
  userSettingsQueryService: {
    get: (...args: unknown[]) => mockGetUserSettings(...args),
  },
}));

vi.mock('@/backend/lib/ide-helpers', () => ({
  checkIdeAvailable: (...args: unknown[]) => mockCheckIdeAvailable(...args),
  openPathInIde: (...args: unknown[]) => mockOpenPathInIde(...args),
}));

import { workspaceIdeRouter } from './ide.trpc';

function createCaller() {
  return workspaceIdeRouter.createCaller({ appContext: {} } as never);
}

describe('workspaceIdeRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists available ides including custom IDE when configured', async () => {
    mockGetUserSettings.mockResolvedValue({
      preferredIde: 'custom',
      customIdeCommand: 'open {workspace}',
    });
    mockCheckIdeAvailable.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const caller = createCaller();
    await expect(caller.getAvailableIdes()).resolves.toEqual({
      ides: [
        { id: 'cursor', name: 'Cursor' },
        { id: 'custom', name: 'Custom IDE' },
      ],
      preferredIde: 'custom',
    });
  });

  it('opens workspace using preferred ide by default', async () => {
    mockFindById.mockResolvedValue({ id: 'w1', worktreePath: '/tmp/w1' });
    mockGetUserSettings.mockResolvedValue({ preferredIde: 'vscode', customIdeCommand: null });
    mockOpenPathInIde.mockResolvedValue(true);

    const caller = createCaller();
    await expect(caller.openInIde({ id: 'w1' })).resolves.toEqual({ success: true });
    expect(mockOpenPathInIde).toHaveBeenCalledWith('vscode', '/tmp/w1', null);
  });

  it('validates workspace and custom ide config', async () => {
    const caller = createCaller();

    mockFindById.mockResolvedValue(null);
    await expect(caller.openInIde({ id: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    mockFindById.mockResolvedValue({ id: 'w1', worktreePath: null });
    await expect(caller.openInIde({ id: 'w1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    mockFindById.mockResolvedValue({ id: 'w1', worktreePath: '/tmp/w1' });
    mockGetUserSettings.mockResolvedValue({ preferredIde: 'custom', customIdeCommand: null });
    await expect(caller.openInIde({ id: 'w1', ide: 'custom' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('returns internal error when IDE launch fails', async () => {
    mockFindById.mockResolvedValue({ id: 'w1', worktreePath: '/tmp/w1' });
    mockGetUserSettings.mockResolvedValue({ preferredIde: 'cursor', customIdeCommand: null });
    mockOpenPathInIde.mockResolvedValue(false);

    const caller = createCaller();
    await expect(caller.openInIde({ id: 'w1', ide: 'cursor' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
