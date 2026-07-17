import { describe, expect, it, vi } from 'vitest';

const checkDatabaseConnectionMock = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/settings/resources/health.accessor', () => ({
  healthAccessor: {
    checkDatabaseConnection: checkDatabaseConnectionMock,
  },
}));

import { settingsHealthService } from './health.service';

describe('settingsHealthService', () => {
  it('checks the database through the settings resource', async () => {
    checkDatabaseConnectionMock.mockResolvedValue(undefined);

    await expect(settingsHealthService.checkDatabaseConnection()).resolves.toBeUndefined();

    expect(checkDatabaseConnectionMock).toHaveBeenCalledTimes(1);
  });
});
