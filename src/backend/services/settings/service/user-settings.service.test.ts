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

  it('gets settings from the settings resource', async () => {
    const settings = { id: 'settings-1' };
    userSettingsAccessorMock.get.mockResolvedValue(settings);

    await expect(userSettingsService.get()).resolves.toBe(settings);
  });

  it('updates settings through the settings resource', async () => {
    const updatedSettings = { id: 'settings-2' };
    userSettingsAccessorMock.update.mockResolvedValue(updatedSettings);

    await expect(userSettingsService.update({ preferredIde: 'cursor' })).resolves.toBe(
      updatedSettings
    );
    expect(userSettingsAccessorMock.update).toHaveBeenCalledWith({ preferredIde: 'cursor' });
  });

  it('gets the default session provider from the settings resource', async () => {
    userSettingsAccessorMock.getDefaultSessionProvider.mockResolvedValue('CODEX');

    await expect(userSettingsService.getDefaultSessionProvider()).resolves.toBe('CODEX');
  });

  it('gets workspace order from the settings resource', async () => {
    userSettingsAccessorMock.getWorkspaceOrder.mockResolvedValue(['ws-2', 'ws-1']);

    await expect(userSettingsService.getWorkspaceOrder('project-1')).resolves.toEqual([
      'ws-2',
      'ws-1',
    ]);
    expect(userSettingsAccessorMock.getWorkspaceOrder).toHaveBeenCalledWith('project-1');
  });

  it('updates workspace order through the settings resource', async () => {
    const updatedSettings = { id: 'settings-2' };
    userSettingsAccessorMock.updateWorkspaceOrder.mockResolvedValue(updatedSettings);

    await expect(
      userSettingsService.updateWorkspaceOrder('project-1', ['ws-1', 'ws-2'])
    ).resolves.toBe(updatedSettings);
    expect(userSettingsAccessorMock.updateWorkspaceOrder).toHaveBeenCalledWith('project-1', [
      'ws-1',
      'ws-2',
    ]);
  });

  it('compares and sets cached slash commands through the settings resource', async () => {
    const expectedUpdatedAt = new Date('2026-07-17T00:00:00.000Z');
    const cachedSlashCommands = { version: 2, global: {} };
    userSettingsAccessorMock.compareAndSetCachedSlashCommands.mockResolvedValue(true);

    await expect(
      userSettingsService.compareAndSetCachedSlashCommands(expectedUpdatedAt, cachedSlashCommands)
    ).resolves.toBe(true);
    expect(userSettingsAccessorMock.compareAndSetCachedSlashCommands).toHaveBeenCalledWith(
      expectedUpdatedAt,
      cachedSlashCommands
    );
  });
});
