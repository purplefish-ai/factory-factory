import type { Prisma, UserSettings } from '@prisma-gen/client';
import { prisma } from '../db';

interface UpdateUserSettingsInput {
  preferredIde?: string;
  customIdeCommand?: string | null;
  playSoundOnComplete?: boolean;
  notificationSoundPath?: string | null;
  cachedSlashCommands?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  // Ratchet settings
  ratchetEnabled?: boolean;
  ratchetAutoFixCi?: boolean;
  ratchetAutoFixConflicts?: boolean;
  ratchetAutoFixReviews?: boolean;
  ratchetAutoMerge?: boolean;
  ratchetAllowedReviewers?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
}

// Type for workspace order storage: { [projectId]: workspaceId[] }
export type WorkspaceOrderMap = Record<string, string[]>;

class UserSettingsAccessor {
  /**
   * Get user settings for the default user.
   * Creates default settings if they don't exist.
   */
  async get(): Promise<UserSettings> {
    const userId = 'default';

    let settings = await prisma.userSettings.findUnique({
      where: { userId },
    });

    // Create default settings if they don't exist
    if (!settings) {
      settings = await prisma.userSettings.create({
        data: {
          userId,
          preferredIde: 'cursor',
          customIdeCommand: null,
          playSoundOnComplete: true,
        },
      });
    }

    return settings;
  }

  /**
   * Update user settings for the default user.
   * Uses upsert to avoid race conditions.
   */
  async update(data: UpdateUserSettingsInput): Promise<UserSettings> {
    const userId = 'default';

    return await prisma.userSettings.upsert({
      where: { userId },
      update: data,
      create: {
        userId,
        preferredIde: data.preferredIde ?? 'cursor',
        customIdeCommand: data.customIdeCommand ?? null,
        playSoundOnComplete: data.playSoundOnComplete ?? true,
        cachedSlashCommands: data.cachedSlashCommands ?? undefined,
      },
    });
  }

  /**
   * Get the workspace order for a specific project.
   */
  async getWorkspaceOrder(projectId: string): Promise<string[]> {
    const settings = await this.get();
    const orderMap = (settings.workspaceOrder as WorkspaceOrderMap) ?? {};
    return orderMap[projectId] ?? [];
  }

  /**
   * Update the workspace order for a specific project.
   */
  async updateWorkspaceOrder(projectId: string, workspaceIds: string[]): Promise<UserSettings> {
    const userId = 'default';
    const settings = await this.get();
    const orderMap = (settings.workspaceOrder as WorkspaceOrderMap) ?? {};

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
