import type { Prisma } from '@prisma-gen/client';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import type { CommandInfo } from '@/shared/claude';
import { createLogger } from './logger.service';

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
  async getCachedCommands(): Promise<CommandInfo[] | null> {
    const settings = await userSettingsAccessor.get();
    return toCommandInfoArray(settings.cachedSlashCommands);
  }

  async setCachedCommands(commands: CommandInfo[]): Promise<void> {
    if (commands.length === 0) {
      return;
    }

    const normalized = normalizeCommands(commands);
    const payload = normalized.map(
      (command) =>
        ({
          name: command.name,
          description: command.description,
          ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
        }) satisfies Prisma.InputJsonObject
    ) as Prisma.InputJsonArray;

    try {
      const settings = await userSettingsAccessor.get();
      const existing = toCommandInfoArray(settings.cachedSlashCommands);

      if (existing && areCommandsEqual(existing, normalized)) {
        return;
      }

      await userSettingsAccessor.update({
        cachedSlashCommands: payload,
      });
    } catch (error) {
      logger.warn('Failed to update cached slash commands', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const slashCommandCacheService = new SlashCommandCacheService();
