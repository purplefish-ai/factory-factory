import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUpsert = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    userSettings: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

import { userSettingsAccessor } from './user-settings.accessor';

describe('userSettingsAccessor.update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves ratchetEnabled when update creates the settings', async () => {
    mockUpsert.mockImplementation(async ({ create }: { create: { ratchetEnabled?: boolean } }) => ({
      ...create,
      ratchetEnabled: create.ratchetEnabled ?? false,
    }));

    const settings = await userSettingsAccessor.update({ ratchetEnabled: true });

    expect(settings.ratchetEnabled).toBe(true);
  });
});
