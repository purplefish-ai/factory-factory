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

  it('normalizes a valid reviewer Claude model before saving', async () => {
    mockUpsert.mockImplementation(
      async ({ update }: { update: Record<string, unknown> }) => update
    );

    const settings = await userSettingsAccessor.update({ reviewerClaudeModel: 'OPUS' });

    expect(settings.reviewerClaudeModel).toBe('opus');
  });

  it('rejects a reviewer Claude model that looks like a Codex model', async () => {
    await expect(userSettingsAccessor.update({ reviewerClaudeModel: 'gpt-4' })).rejects.toThrow(
      'Invalid reviewer Claude model'
    );
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects a reviewer Codex model that looks like a Claude model', async () => {
    await expect(
      userSettingsAccessor.update({ reviewerCodexModel: 'claude-sonnet-5' })
    ).rejects.toThrow('Invalid reviewer Codex model');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('clears the reviewer model override when set to null', async () => {
    mockUpsert.mockImplementation(
      async ({ update }: { update: Record<string, unknown> }) => update
    );

    const settings = await userSettingsAccessor.update({ reviewerClaudeModel: null });

    expect(settings.reviewerClaudeModel).toBeNull();
  });
});
