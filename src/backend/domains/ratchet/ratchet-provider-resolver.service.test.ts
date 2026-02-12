import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findRawById: vi.fn(),
  },
}));

vi.mock('@/backend/resource_accessors/user-settings.accessor', () => ({
  userSettingsAccessor: {
    get: vi.fn(),
  },
}));

import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { ratchetProviderResolverService } from './ratchet-provider-resolver.service';

describe('ratchetProviderResolverService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      defaultSessionProvider: 'CLAUDE',
    } as never);
  });

  it('uses ratchet provider when workspace overrides it', async () => {
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      id: 'ws-1',
      ratchetSessionProvider: 'CODEX',
      defaultSessionProvider: 'CLAUDE',
    } as never);

    const provider = await ratchetProviderResolverService.resolveRatchetProvider({
      workspaceId: 'ws-1',
    });

    expect(provider).toBe('CODEX');
    expect(userSettingsAccessor.get).not.toHaveBeenCalled();
  });

  it('falls back to workspace default when ratchet provider is WORKSPACE_DEFAULT', async () => {
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      id: 'ws-1',
      ratchetSessionProvider: 'WORKSPACE_DEFAULT',
      defaultSessionProvider: 'CODEX',
    } as never);

    const provider = await ratchetProviderResolverService.resolveRatchetProvider({
      workspaceId: 'ws-1',
    });

    expect(provider).toBe('CODEX');
    expect(userSettingsAccessor.get).not.toHaveBeenCalled();
  });

  it('falls back to user default when workspace defers provider selection', async () => {
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      id: 'ws-1',
      ratchetSessionProvider: 'WORKSPACE_DEFAULT',
      defaultSessionProvider: 'WORKSPACE_DEFAULT',
    } as never);

    const provider = await ratchetProviderResolverService.resolveRatchetProvider({
      workspaceId: 'ws-1',
    });

    expect(provider).toBe('CLAUDE');
    expect(userSettingsAccessor.get).toHaveBeenCalledTimes(1);
  });

  it('uses provided workspace and skips lookup', async () => {
    const provider = await ratchetProviderResolverService.resolveRatchetProvider({
      workspaceId: 'ws-1',
      workspace: {
        id: 'ws-1',
        ratchetSessionProvider: 'CODEX',
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
      },
    });

    expect(provider).toBe('CODEX');
    expect(workspaceAccessor.findRawById).not.toHaveBeenCalled();
  });

  it('throws when workspace cannot be found', async () => {
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue(null);

    await expect(
      ratchetProviderResolverService.resolveRatchetProvider({
        workspaceId: 'missing-workspace',
      })
    ).rejects.toThrow('Workspace not found: missing-workspace');
  });
});
