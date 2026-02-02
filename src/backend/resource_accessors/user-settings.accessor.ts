import type { UserSettings } from '@prisma-gen/client';
import { prisma } from '../db';

interface UpdateUserSettingsInput {
  preferredIde?: string;
  customIdeCommand?: string | null;
  playSoundOnComplete?: boolean;
  notificationSoundPath?: string | null;
}

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
      },
    });
  }
}

export const userSettingsAccessor = new UserSettingsAccessor();
