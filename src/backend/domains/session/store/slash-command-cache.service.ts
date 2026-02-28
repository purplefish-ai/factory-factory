import type { Prisma } from '@prisma-gen/client';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { createLogger } from '@/backend/services/logger.service';
import type { CommandInfo } from '@/shared/acp-protocol';

const logger = createLogger('slash-command-cache');

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

function toCommandInfoArray(value: unknown): CommandInfo[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const commands = value.filter(isCommandInfo);
  return commands.length > 0 ? normalizeCommands(commands) : null;
}

type SessionProvider = 'CLAUDE' | 'CODEX' | 'OPENCODE';
type CachedSlashCommandsByProvider = Partial<Record<SessionProvider, CommandInfo[]>>;

function toProviderCommandMap(value: unknown): CachedSlashCommandsByProvider | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const map: CachedSlashCommandsByProvider = {};
  const record = value as Record<string, unknown>;
  for (const provider of ['CLAUDE', 'CODEX', 'OPENCODE'] as const) {
    const commands = toCommandInfoArray(record[provider]);
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
    .filter((entry): entry is [SessionProvider, CommandInfo[]] => Boolean(entry[1]))
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

  return Object.fromEntries(entries) as Prisma.InputJsonObject;
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
    const settings = await userSettingsAccessor.get();
    const commandsByProvider = toProviderCommandMap(settings.cachedSlashCommands);
    return commandsByProvider?.[provider] ?? null;
  }

  async setCachedCommands(provider: SessionProvider, commands: CommandInfo[]): Promise<void> {
    if (commands.length === 0) {
      return;
    }

    const normalized = normalizeCommands(commands);

    try {
      const settings = await userSettingsAccessor.get();
      const existingMap = toProviderCommandMap(settings.cachedSlashCommands) ?? {};
      const existing = existingMap[provider] ?? null;

      if (existing && areCommandsEqual(existing, normalized)) {
        return;
      }

      const nextPayload: CachedSlashCommandsByProvider = {
        ...existingMap,
        [provider]: normalized,
      };

      await userSettingsAccessor.update({
        cachedSlashCommands: toProviderPayload(nextPayload),
      });
    } catch (error) {
      logger.warn('Failed to update cached slash commands', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const slashCommandCacheService = new SlashCommandCacheService();
