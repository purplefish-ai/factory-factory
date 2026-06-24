import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userSettingsAccessor } from '@/backend/services/settings';
import { slashCommandCacheService } from './slash-command-cache.service';

vi.mock('@/backend/services/settings');

describe('slashCommandCacheService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads versioned provider-scoped command cache payloads', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      cachedSlashCommands: {
        version: 2,
        global: {
          CLAUDE: [{ name: '/help', description: 'Help' }],
          CODEX: [{ name: '/status', description: 'Status' }],
        },
      },
    } as never);

    await expect(slashCommandCacheService.getCachedCommands('CLAUDE')).resolves.toEqual([
      { name: '/help', description: 'Help', argumentHint: undefined },
    ]);
    await expect(slashCommandCacheService.getCachedCommands('CODEX')).resolves.toEqual([
      { name: '/status', description: 'Status', argumentHint: undefined },
    ]);
  });

  it('ignores legacy Claude cache payloads because they may include workspace commands', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      cachedSlashCommands: {
        CLAUDE: [{ name: '/workspace-only', description: 'Workspace only' }],
        CODEX: [{ name: '/status', description: 'Status' }],
      },
    } as never);

    await expect(slashCommandCacheService.getCachedCommands('CLAUDE')).resolves.toBeNull();
    await expect(slashCommandCacheService.getCachedCommands('CODEX')).resolves.toEqual([
      { name: '/status', description: 'Status', argumentHint: undefined },
    ]);
  });

  it('returns null for malformed cache payloads', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      cachedSlashCommands: [{ name: '/help', description: 'Help' }],
    } as never);

    await expect(slashCommandCacheService.getCachedCommands('CLAUDE')).resolves.toBeNull();
    await expect(slashCommandCacheService.getCachedCommands('CODEX')).resolves.toBeNull();
  });

  it('writes versioned global command cache payloads', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      cachedSlashCommands: null,
    } as never);

    await slashCommandCacheService.setCachedCommands('CLAUDE', [
      { name: '/help', description: 'Help', argumentHint: 'topic' },
    ]);

    expect(userSettingsAccessor.update).toHaveBeenCalledWith({
      cachedSlashCommands: {
        version: 2,
        global: {
          CLAUDE: [{ name: '/help', description: 'Help', argumentHint: 'topic' }],
        },
      },
    });
  });
});
