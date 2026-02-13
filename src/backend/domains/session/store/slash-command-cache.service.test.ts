import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { slashCommandCacheService } from './slash-command-cache.service';

vi.mock('@/backend/resource_accessors/user-settings.accessor');

describe('slashCommandCacheService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads provider-scoped command cache payloads', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      cachedSlashCommands: {
        CLAUDE: [{ name: '/help', description: 'Help' }],
        CODEX: [{ name: '/status', description: 'Status' }],
      },
    } as never);

    await expect(slashCommandCacheService.getCachedCommands('CLAUDE')).resolves.toEqual([
      { name: '/help', description: 'Help', argumentHint: undefined },
    ]);
    await expect(slashCommandCacheService.getCachedCommands('CODEX')).resolves.toEqual([
      { name: '/status', description: 'Status', argumentHint: undefined },
    ]);
  });

  it('falls back to legacy CLAUDE array cache format', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      cachedSlashCommands: [{ name: '/help', description: 'Help' }],
    } as never);

    await expect(slashCommandCacheService.getCachedCommands('CLAUDE')).resolves.toEqual([
      { name: '/help', description: 'Help', argumentHint: undefined },
    ]);
    await expect(slashCommandCacheService.getCachedCommands('CODEX')).resolves.toBeNull();
  });
});
