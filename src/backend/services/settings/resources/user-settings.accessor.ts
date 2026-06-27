import type {
  Prisma,
  SessionPermissionPreset,
  SessionProvider,
  UserSettings,
} from '@prisma-gen/client';
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

class UserSettingsAccessor {
  /**
   * Get user settings for the default user.
   * Creates default settings if they don't exist.
   */
  async get(): Promise<UserSettings> {
    const userId = 'default';

    return await prisma.userSettings.upsert({
      where: { userId },
      update: {},
      create: {
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
    const settings = await this.get();
    const orderMap = parseWorkspaceOrderMap(settings.workspaceOrder);

    // Update the order for this project
    orderMap[projectId] = workspaceIds;

    return await prisma.userSettings.update({
      where: { userId },
      data: {
        workspaceOrder: orderMap,
      },
    });
  }
}

export const userSettingsAccessor = new UserSettingsAccessor();
