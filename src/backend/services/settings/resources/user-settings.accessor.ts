import type { SessionPermissionPreset, SessionProvider, UserSettings } from '@prisma-gen/client';
import { Prisma } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { normalizeSessionModelForProvider } from '@/backend/lib/session-model';
import { workspaceOrderMapSchema } from '@/shared/schemas/persisted-stores.schema';

interface UpdateUserSettingsInput {
  preferredIde?: string;
  customIdeCommand?: string | null;
  playSoundOnComplete?: boolean;
  notificationSoundPath?: string | null;
  cachedSlashCommands?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  // Ratchet settings
  ratchetEnabled?: boolean;
  ratchetReplyToPrComments?: boolean;
  defaultSessionProvider?: SessionProvider;
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
  defaultClaudeReasoningEffort?: string | null;
  defaultCodexReasoningEffort?: string | null;
  defaultWorkspacePermissions?: SessionPermissionPreset;
  ratchetPermissions?: SessionPermissionPreset;
}

// Type for workspace order storage: { [projectId]: workspaceId[] }
export type WorkspaceOrderMap = Record<string, string[]>;

const WORKSPACE_ORDER_UPDATE_MAX_ATTEMPTS = 5;

function parseWorkspaceOrderMap(value: Prisma.JsonValue | null): WorkspaceOrderMap {
  const parsed = workspaceOrderMapSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function normalizeDefaultSessionModels(data: UpdateUserSettingsInput): {
  normalizedClaudeModel: string | undefined;
  normalizedCodexModel: string | undefined;
} {
  const normalizedClaudeModel =
    data.defaultClaudeModel === undefined
      ? undefined
      : normalizeSessionModelForProvider(data.defaultClaudeModel, 'CLAUDE');
  if (data.defaultClaudeModel !== undefined && !normalizedClaudeModel) {
    throw new Error('Invalid default Claude model');
  }

  const normalizedCodexModel =
    data.defaultCodexModel === undefined
      ? undefined
      : normalizeSessionModelForProvider(data.defaultCodexModel, 'CODEX');
  if (data.defaultCodexModel !== undefined && !normalizedCodexModel) {
    throw new Error('Invalid default Codex model');
  }

  return { normalizedClaudeModel, normalizedCodexModel };
}

function normalizeOptionalEffort(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

class UserSettingsAccessor {
  /**
   * Get user settings for the default user.
   * Creates default settings if they don't exist.
   */
  async get(): Promise<UserSettings> {
    const userId = 'default';

    const existing = await prisma.userSettings.findUnique({
      where: { userId },
    });

    if (existing) {
      return existing;
    }

    try {
      return await prisma.userSettings.create({
        data: {
          userId,
          preferredIde: 'cursor',
          customIdeCommand: null,
          playSoundOnComplete: true,
          defaultSessionProvider: 'CLAUDE',
          defaultClaudeModel: 'sonnet',
          defaultCodexModel: 'default',
          defaultClaudeReasoningEffort: null,
          defaultCodexReasoningEffort: null,
          defaultWorkspacePermissions: 'STRICT',
          ratchetReplyToPrComments: true,
          ratchetPermissions: 'YOLO',
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const settings = await prisma.userSettings.findUnique({
        where: { userId },
      });

      if (!settings) {
        throw error;
      }

      return settings;
    }
  }

  async getDefaultSessionProvider(): Promise<SessionProvider> {
    const settings = await this.get();
    return settings.defaultSessionProvider;
  }

  /**
   * Update user settings for the default user.
   * Uses upsert to avoid race conditions.
   */
  async update(data: UpdateUserSettingsInput): Promise<UserSettings> {
    const userId = 'default';
    const { normalizedClaudeModel, normalizedCodexModel } = normalizeDefaultSessionModels(data);
    const normalizedClaudeEffort = normalizeOptionalEffort(data.defaultClaudeReasoningEffort);
    const normalizedCodexEffort = normalizeOptionalEffort(data.defaultCodexReasoningEffort);

    return await prisma.userSettings.upsert({
      where: { userId },
      update: {
        ...data,
        defaultClaudeModel: normalizedClaudeModel,
        defaultCodexModel: normalizedCodexModel,
        defaultClaudeReasoningEffort: normalizedClaudeEffort,
        defaultCodexReasoningEffort: normalizedCodexEffort,
      },
      create: {
        userId,
        preferredIde: data.preferredIde ?? 'cursor',
        customIdeCommand: data.customIdeCommand ?? null,
        playSoundOnComplete: data.playSoundOnComplete ?? true,
        cachedSlashCommands: data.cachedSlashCommands ?? undefined,
        defaultSessionProvider: data.defaultSessionProvider ?? 'CLAUDE',
        defaultClaudeModel: normalizedClaudeModel ?? 'sonnet',
        defaultCodexModel: normalizedCodexModel ?? 'default',
        defaultClaudeReasoningEffort: normalizedClaudeEffort ?? null,
        defaultCodexReasoningEffort: normalizedCodexEffort ?? null,
        defaultWorkspacePermissions: data.defaultWorkspacePermissions ?? 'STRICT',
        ratchetReplyToPrComments: data.ratchetReplyToPrComments ?? true,
        ratchetPermissions: data.ratchetPermissions ?? 'YOLO',
      },
    });
  }

  /**
   * Get the workspace order for a specific project.
   */
  async getWorkspaceOrder(projectId: string): Promise<string[]> {
    const settings = await this.get();
    const orderMap = parseWorkspaceOrderMap(settings.workspaceOrder);
    return orderMap[projectId] ?? [];
  }

  /**
   * Update the workspace order for a specific project.
   */
  async updateWorkspaceOrder(projectId: string, workspaceIds: string[]): Promise<UserSettings> {
    const userId = 'default';

    for (let attempt = 0; attempt < WORKSPACE_ORDER_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      const settings = await this.get();
      const orderMap = parseWorkspaceOrderMap(settings.workspaceOrder);
      const nextOrderMap = {
        ...orderMap,
        [projectId]: workspaceIds,
      };

      const result = await prisma.userSettings.updateMany({
        where: {
          userId,
          updatedAt: settings.updatedAt,
        },
        data: {
          workspaceOrder: nextOrderMap,
        },
      });

      if (result.count === 1) {
        return await prisma.userSettings.findUniqueOrThrow({
          where: { userId },
        });
      }
    }

    throw new Error(
      `Failed to update workspace order for project ${projectId} after ${WORKSPACE_ORDER_UPDATE_MAX_ATTEMPTS} attempts`
    );
  }
}

export const userSettingsAccessor = new UserSettingsAccessor();
