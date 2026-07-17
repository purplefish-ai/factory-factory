import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userSettingsService } from '@/backend/services/settings';
import { slashCommandCacheService } from './slash-command-cache.service';

const { compareAndSetCachedSlashCommandsMock } = vi.hoisted(() => ({
  compareAndSetCachedSlashCommandsMock: vi.fn(),
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(),
    update: vi.fn(),
    compareAndSetCachedSlashCommands: compareAndSetCachedSlashCommandsMock,
  },
}));

describe('slashCommandCacheService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compareAndSetCachedSlashCommandsMock.mockResolvedValue(true);
  });

  it('reads versioned provider-scoped command cache payloads', async () => {
    vi.mocked(userSettingsService.get).mockResolvedValue({
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
    vi.mocked(userSettingsService.get).mockResolvedValue({
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
    vi.mocked(userSettingsService.get).mockResolvedValue({
      cachedSlashCommands: [{ name: '/help', description: 'Help' }],
    } as never);

    await expect(slashCommandCacheService.getCachedCommands('CLAUDE')).resolves.toBeNull();
    await expect(slashCommandCacheService.getCachedCommands('CODEX')).resolves.toBeNull();
  });

  it('writes versioned global command cache payloads', async () => {
    const updatedAt = new Date('2026-07-17T00:00:00.000Z');
    vi.mocked(userSettingsService.get).mockResolvedValue({
      cachedSlashCommands: null,
      updatedAt,
    } as never);

    await slashCommandCacheService.setCachedCommands('CLAUDE', [
      { name: '/help', description: 'Help', argumentHint: 'topic' },
    ]);

    expect(compareAndSetCachedSlashCommandsMock).toHaveBeenCalledWith(updatedAt, {
      version: 2,
      global: {
        CLAUDE: [{ name: '/help', description: 'Help', argumentHint: 'topic' }],
      },
    });
  });

  it('treats empty versioned provider cache payloads as cache misses', async () => {
    const updatedAt = new Date('2026-07-17T00:00:00.000Z');
    vi.mocked(userSettingsService.get)
      .mockResolvedValueOnce({
        cachedSlashCommands: {
          version: 2,
          global: {
            CLAUDE: [],
          },
        },
        updatedAt,
      } as never)
      .mockResolvedValueOnce({
        cachedSlashCommands: {
          version: 2,
          global: {
            CLAUDE: [{ name: '/stale', description: 'Stale' }],
            CODEX: [{ name: '/status', description: 'Status' }],
          },
        },
        updatedAt,
      } as never);

    await expect(slashCommandCacheService.getCachedCommands('CLAUDE')).resolves.toBeNull();

    await slashCommandCacheService.setCachedCommands('CLAUDE', []);

    expect(compareAndSetCachedSlashCommandsMock).toHaveBeenCalledWith(updatedAt, {
      version: 2,
      global: {
        CODEX: [{ name: '/status', description: 'Status' }],
      },
    });
  });

  it('preserves concurrent provider cache updates', async () => {
    let cachedSlashCommands: unknown = {
      version: 2,
      global: {
        CLAUDE: [{ name: '/claude-old', description: 'Claude old' }],
        CODEX: [{ name: '/codex-old', description: 'Codex old' }],
      },
    };
    let updatedAt = new Date('2026-07-17T00:00:00.000Z');

    vi.mocked(userSettingsService.get).mockImplementation(() => {
      return Promise.resolve({
        cachedSlashCommands: structuredClone(cachedSlashCommands),
        updatedAt: new Date(updatedAt),
      } as never);
    });
    compareAndSetCachedSlashCommandsMock.mockImplementation(
      (expectedUpdatedAt: Date, nextCachedSlashCommands: unknown) => {
        if (expectedUpdatedAt.getTime() !== updatedAt.getTime()) {
          return Promise.resolve(false);
        }
        cachedSlashCommands = structuredClone(nextCachedSlashCommands);
        updatedAt = new Date(updatedAt.getTime() + 1);
        return Promise.resolve(true);
      }
    );

    await Promise.all([
      slashCommandCacheService.setCachedCommands('CLAUDE', [
        { name: '/claude-new', description: 'Claude new' },
      ]),
      slashCommandCacheService.setCachedCommands('CODEX', [
        { name: '/codex-new', description: 'Codex new' },
      ]),
    ]);

    expect(cachedSlashCommands).toEqual({
      version: 2,
      global: {
        CLAUDE: [{ name: '/claude-new', description: 'Claude new' }],
        CODEX: [{ name: '/codex-new', description: 'Codex new' }],
      },
    });
    expect(compareAndSetCachedSlashCommandsMock).toHaveBeenCalledTimes(3);
  });
});
