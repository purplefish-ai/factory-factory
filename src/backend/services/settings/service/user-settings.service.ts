import type {
  Prisma,
  SessionPermissionPreset,
  SessionProvider,
  UserSettings,
} from '@prisma-gen/client';
import { userSettingsAccessor } from '@/backend/services/settings/resources/user-settings.accessor';

export interface UpdateUserSettingsInput {
  preferredIde?: string;
  customIdeCommand?: string | null;
  playSoundOnComplete?: boolean;
  notificationSoundPath?: string | null;
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

class UserSettingsService {
  get(): Promise<UserSettings> {
    return userSettingsAccessor.get();
  }

  update(data: UpdateUserSettingsInput): Promise<UserSettings> {
    return userSettingsAccessor.update(data);
  }

  getDefaultSessionProvider(): Promise<SessionProvider> {
    return userSettingsAccessor.getDefaultSessionProvider();
  }

  getWorkspaceOrder(projectId: string): Promise<string[]> {
    return userSettingsAccessor.getWorkspaceOrder(projectId);
  }

  updateWorkspaceOrder(projectId: string, workspaceIds: string[]): Promise<UserSettings> {
    return userSettingsAccessor.updateWorkspaceOrder(projectId, workspaceIds);
  }

  compareAndSetCachedSlashCommands(
    expectedUpdatedAt: Date,
    cachedSlashCommands: Prisma.InputJsonValue
  ): Promise<boolean> {
    return userSettingsAccessor.compareAndSetCachedSlashCommands(
      expectedUpdatedAt,
      cachedSlashCommands
    );
  }
}

export const userSettingsService = new UserSettingsService();
