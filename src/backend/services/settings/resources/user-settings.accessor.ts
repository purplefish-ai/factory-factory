import type {
  RatchetReviewTriggerMode,
  SessionPermissionPreset,
  SessionProvider,
  UserSettings,
} from '@prisma-gen/client';
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
  ratchetReviewTriggerMode?: RatchetReviewTriggerMode;
  defaultSessionProvider?: SessionProvider;
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
  defaultClaudeReasoningEffort?: string | null;
  defaultCodexReasoningEffort?: string | null;
  defaultWorkspacePermissions?: SessionPermissionPreset;
  ratchetPermissions?: SessionPermissionPreset;
  voiceModeEnabled?: boolean;
  deepgramApiKeyEncrypted?: string | null;
  voiceTtsModel?: string;
  voiceTtsSpeed?: number;
  voiceUtteranceEndMs?: number;
  voiceBargeInSustainedMs?: number;
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

function buildGeneralPreferenceDefaults(
  data: UpdateUserSettingsInput
): Pick<
  Prisma.UserSettingsCreateInput,
  'preferredIde' | 'customIdeCommand' | 'playSoundOnComplete' | 'cachedSlashCommands'
> {
  return {
    preferredIde: data.preferredIde ?? 'cursor',
    customIdeCommand: data.customIdeCommand ?? null,
    playSoundOnComplete: data.playSoundOnComplete ?? true,
    cachedSlashCommands: data.cachedSlashCommands ?? undefined,
  };
}

function buildRatchetDefaults(
  data: UpdateUserSettingsInput
): Pick<
  Prisma.UserSettingsCreateInput,
  | 'ratchetEnabled'
  | 'ratchetReplyToPrComments'
  | 'ratchetReviewTriggerMode'
  | 'ratchetPermissions'
  | 'defaultWorkspacePermissions'
> {
  return {
    ratchetEnabled: data.ratchetEnabled ?? false,
    ratchetReplyToPrComments: data.ratchetReplyToPrComments ?? true,
    ratchetReviewTriggerMode: data.ratchetReviewTriggerMode ?? 'CHANGES_REQUESTED',
    ratchetPermissions: data.ratchetPermissions ?? 'YOLO',
    defaultWorkspacePermissions: data.defaultWorkspacePermissions ?? 'STRICT',
  };
}

function buildSessionModelDefaults(
  data: UpdateUserSettingsInput,
  normalizedClaudeModel: string | undefined,
  normalizedCodexModel: string | undefined,
  normalizedClaudeEffort: string | null | undefined,
  normalizedCodexEffort: string | null | undefined
): Pick<
  Prisma.UserSettingsCreateInput,
  | 'defaultSessionProvider'
  | 'defaultClaudeModel'
  | 'defaultCodexModel'
  | 'defaultClaudeReasoningEffort'
  | 'defaultCodexReasoningEffort'
> {
  return {
    defaultSessionProvider: data.defaultSessionProvider ?? 'CLAUDE',
    defaultClaudeModel: normalizedClaudeModel ?? 'sonnet',
    defaultCodexModel: normalizedCodexModel ?? 'default',
    defaultClaudeReasoningEffort: normalizedClaudeEffort ?? null,
    defaultCodexReasoningEffort: normalizedCodexEffort ?? null,
  };
}

function buildVoiceDefaults(
  data: UpdateUserSettingsInput
): Pick<
  Prisma.UserSettingsCreateInput,
  | 'voiceModeEnabled'
  | 'deepgramApiKeyEncrypted'
  | 'voiceTtsModel'
  | 'voiceTtsSpeed'
  | 'voiceUtteranceEndMs'
  | 'voiceBargeInSustainedMs'
> {
  return {
    voiceModeEnabled: data.voiceModeEnabled ?? false,
    deepgramApiKeyEncrypted: data.deepgramApiKeyEncrypted ?? null,
    voiceTtsModel: data.voiceTtsModel ?? undefined,
    voiceTtsSpeed: data.voiceTtsSpeed ?? undefined,
    voiceUtteranceEndMs: data.voiceUtteranceEndMs ?? undefined,
    voiceBargeInSustainedMs: data.voiceBargeInSustainedMs ?? undefined,
  };
}

/**
 * Builds the upsert `create` branch's data, so a first-time write of any
 * field (e.g. voice mode config before any other setting has been saved)
 * still lands with sensible defaults for everything else rather than
 * relying on Prisma's `@default` — which the `update` branch above bypasses
 * entirely since it spreads `data` directly.
 */
function buildCreateData(
  userId: string,
  data: UpdateUserSettingsInput,
  normalizedClaudeModel: string | undefined,
  normalizedCodexModel: string | undefined,
  normalizedClaudeEffort: string | null | undefined,
  normalizedCodexEffort: string | null | undefined
): Prisma.UserSettingsCreateInput {
  return {
    userId,
    ...buildGeneralPreferenceDefaults(data),
    ...buildRatchetDefaults(data),
    ...buildSessionModelDefaults(
      data,
      normalizedClaudeModel,
      normalizedCodexModel,
      normalizedClaudeEffort,
      normalizedCodexEffort
    ),
    ...buildVoiceDefaults(data),
  };
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
          ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
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
      create: buildCreateData(
        userId,
        data,
        normalizedClaudeModel,
        normalizedCodexModel,
        normalizedClaudeEffort,
        normalizedCodexEffort
      ),
    });
  }

  async compareAndSetCachedSlashCommands(
    expectedUpdatedAt: Date,
    cachedSlashCommands: Prisma.InputJsonValue
  ): Promise<boolean> {
    const result = await prisma.userSettings.updateMany({
      where: { userId: 'default', updatedAt: expectedUpdatedAt },
      data: { cachedSlashCommands },
    });
    return result.count === 1;
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
