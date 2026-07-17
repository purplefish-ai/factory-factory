import { beforeEach, describe, expect, it, vi } from 'vitest';

const userSettingsAccessorMock = vi.hoisted(() => ({
  compareAndSetCachedSlashCommands: vi.fn(),
  get: vi.fn(),
  getDefaultSessionProvider: vi.fn(),
  getWorkspaceOrder: vi.fn(),
  update: vi.fn(),
  updateWorkspaceOrder: vi.fn(),
}));

vi.mock('@/backend/services/settings/resources/user-settings.accessor', () => ({
  userSettingsAccessor: userSettingsAccessorMock,
}));

import { userSettingsService } from './user-settings.service';

describe('userSettingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates settings use cases to the settings resource', async () => {
    const settings = { id: 'settings-1' };
    const updatedSettings = { id: 'settings-2' };
    const expectedUpdatedAt = new Date('2026-07-17T00:00:00.000Z');
    const cachedSlashCommands = { version: 2, global: {} };
    userSettingsAccessorMock.get.mockResolvedValue(settings);
    userSettingsAccessorMock.update.mockResolvedValue(updatedSettings);
    userSettingsAccessorMock.getDefaultSessionProvider.mockResolvedValue('CODEX');
    userSettingsAccessorMock.getWorkspaceOrder.mockResolvedValue(['ws-2', 'ws-1']);
    userSettingsAccessorMock.updateWorkspaceOrder.mockResolvedValue(updatedSettings);
    userSettingsAccessorMock.compareAndSetCachedSlashCommands.mockResolvedValue(true);

    await expect(userSettingsService.get()).resolves.toBe(settings);
    await expect(userSettingsService.update({ preferredIde: 'cursor' })).resolves.toBe(
      updatedSettings
    );
    await expect(userSettingsService.getDefaultSessionProvider()).resolves.toBe('CODEX');
    await expect(userSettingsService.getWorkspaceOrder('project-1')).resolves.toEqual([
      'ws-2',
      'ws-1',
    ]);
    await expect(
      userSettingsService.updateWorkspaceOrder('project-1', ['ws-1', 'ws-2'])
    ).resolves.toBe(updatedSettings);
    await expect(
      userSettingsService.compareAndSetCachedSlashCommands(expectedUpdatedAt, cachedSlashCommands)
    ).resolves.toBe(true);

    expect(userSettingsAccessorMock.update).toHaveBeenCalledWith({ preferredIde: 'cursor' });
    expect(userSettingsAccessorMock.getWorkspaceOrder).toHaveBeenCalledWith('project-1');
    expect(userSettingsAccessorMock.updateWorkspaceOrder).toHaveBeenCalledWith('project-1', [
      'ws-1',
      'ws-2',
    ]);
    expect(userSettingsAccessorMock.compareAndSetCachedSlashCommands).toHaveBeenCalledWith(
      expectedUpdatedAt,
      cachedSlashCommands
    );
  });
});
