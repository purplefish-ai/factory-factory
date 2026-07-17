import type { Prisma } from '@prisma-gen/client';
import { createLogger } from '@/backend/services/logger.service';
import { userSettingsService } from '@/backend/services/settings';
import type { CommandInfo } from '@/shared/acp-protocol';

const logger = createLogger('slash-command-cache');
const CACHE_PAYLOAD_VERSION = 2;
const SLASH_COMMAND_CACHE_UPDATE_MAX_ATTEMPTS = 5;

function isCommandInfo(value: unknown): value is CommandInfo {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string') {
    return false;
  }
  if (typeof record.description !== 'string') {
    return false;
  }
  if (record.argumentHint !== undefined && typeof record.argumentHint !== 'string') {
    return false;
  }
  return true;
}

function normalizeCommands(commands: CommandInfo[]): CommandInfo[] {
  return commands.map((command) => {
    const hint = typeof command.argumentHint === 'string' ? command.argumentHint.trim() : undefined;
    return {
      name: command.name,
      description: command.description ?? '',
      argumentHint: hint || undefined,
    };
  });
}

function toCommandInfoArray(value: unknown, allowEmpty = false): CommandInfo[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const commands = value.filter(isCommandInfo);
  if (commands.length > 0) {
    return normalizeCommands(commands);
  }
  return allowEmpty && value.length === 0 ? [] : null;
}

type SessionProvider = 'CLAUDE' | 'CODEX';
type CachedSlashCommandsByProvider = Partial<Record<SessionProvider, CommandInfo[]>>;

function toProviderCommandMap(value: unknown): CachedSlashCommandsByProvider | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const map: CachedSlashCommandsByProvider = {};
  const record = value as Record<string, unknown>;
  for (const provider of ['CLAUDE', 'CODEX'] as const) {
    const commands = toCommandInfoArray(record[provider]);
    if (commands) {
      map[provider] = commands;
    }
  }

  return Object.keys(map).length > 0 ? map : null;
}

function toVersionedProviderCommandMap(value: unknown): CachedSlashCommandsByProvider | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.version !== CACHE_PAYLOAD_VERSION) {
    return null;
  }

  if (!record.global || typeof record.global !== 'object' || Array.isArray(record.global)) {
    return null;
  }

  const map: CachedSlashCommandsByProvider = {};
  const global = record.global as Record<string, unknown>;
  for (const provider of ['CLAUDE', 'CODEX'] as const) {
    const commands = toCommandInfoArray(global[provider]);
    if (commands) {
      map[provider] = commands;
    }
  }

  return Object.keys(map).length > 0 ? map : null;
}

function toProviderPayload(
  commandsByProvider: CachedSlashCommandsByProvider
): Prisma.InputJsonObject {
  const entries = Object.entries(commandsByProvider)
    .filter(
      (entry): entry is [SessionProvider, CommandInfo[]] => Boolean(entry[1]) && entry[1].length > 0
    )
    .map(([provider, commands]) => [
      provider,
      commands.map(
        (command) =>
          ({
            name: command.name,
            description: command.description,
            ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
          }) satisfies Prisma.InputJsonObject
      ),
    ]);

  return {
    version: CACHE_PAYLOAD_VERSION,
    global: Object.fromEntries(entries) as Prisma.InputJsonObject,
  };
}

function areCommandsEqual(a: CommandInfo[], b: CommandInfo[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!(left && right)) {
      return false;
    }
    if (left.name !== right.name) {
      return false;
    }
    if (left.description !== right.description) {
      return false;
    }
    if ((left.argumentHint ?? null) !== (right.argumentHint ?? null)) {
      return false;
    }
  }
  return true;
}

class SlashCommandCacheService {
  async getCachedCommands(provider: SessionProvider): Promise<CommandInfo[] | null> {
    const settings = await userSettingsService.get();
    const versionedCommandsByProvider = toVersionedProviderCommandMap(settings.cachedSlashCommands);
    if (versionedCommandsByProvider) {
      return versionedCommandsByProvider[provider] ?? null;
    }

    if (provider === 'CODEX') {
      const legacyCommandsByProvider = toProviderCommandMap(settings.cachedSlashCommands);
      return legacyCommandsByProvider?.CODEX ?? null;
    }

    return null;
  }

  async setCachedCommands(provider: SessionProvider, commands: CommandInfo[]): Promise<void> {
    const normalized = normalizeCommands(commands);

    try {
      for (let attempt = 0; attempt < SLASH_COMMAND_CACHE_UPDATE_MAX_ATTEMPTS; attempt += 1) {
        const settings = await userSettingsService.get();
        const existingMap = toVersionedProviderCommandMap(settings.cachedSlashCommands) ?? {};
        const legacyMap = toProviderCommandMap(settings.cachedSlashCommands);
        if (!existingMap.CODEX && legacyMap?.CODEX) {
          existingMap.CODEX = legacyMap.CODEX;
        }
        const existing = existingMap[provider] ?? null;

        if (existing && areCommandsEqual(existing, normalized)) {
          return;
        }

        const nextPayload: CachedSlashCommandsByProvider = {
          ...existingMap,
          [provider]: normalized,
        };

        const updated = await userSettingsService.compareAndSetCachedSlashCommands(
          settings.updatedAt,
          toProviderPayload(nextPayload)
        );
        if (updated) {
          return;
        }
      }

      throw new Error(
        `Failed to update cached slash commands for ${provider} after ${SLASH_COMMAND_CACHE_UPDATE_MAX_ATTEMPTS} attempts`
      );
    } catch (error) {
      logger.warn('Failed to update cached slash commands', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const slashCommandCacheService = new SlashCommandCacheService();
