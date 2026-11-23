import {
  type SlashCommandCacheState,
  type UserSettingsRecord,
  userSettingsAccessor,
} from '@/backend/services/settings/resources/user-settings.accessor';
import type { Prisma, SessionPermissionPreset, SessionProvider } from '@prisma-gen/client';

export interface UpdateUserSettingsInput {
  turnLimitMinutes?: number | null;
  preferredIde?: string;
  customIdeCommand?: string | null;
  playSoundOnComplete?: boolean;
  childWorkspacesEnabled?: boolean;
  ticketDispatchPrompt?: string | null;
  notificationSoundPath?: string | null;
  ratchetEnabled?: boolean;
  ratchetReplyToPrComments?: boolean;
  defaultSessionProvider?: SessionProvider;
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
  defaultClaudeReasoningEffort?: string | null;
  defaultCodexReasoningEffort?: string | null;
  defaultWorkspacePermissions?: SessionPermissionPreset;
  automationPermissions?: SessionPermissionPreset;
  reviewerSessionProvider?: SessionProvider;
  reviewerClaudeModel?: string | null;
  reviewerCodexModel?: string | null;
  postReviewToGitHub?: boolean;
  voiceModeEnabled?: boolean;
  deepgramApiKeyEncrypted?: string | null;
  voiceTtsModel?: string;
  voiceTtsSpeed?: number;
  voiceUtteranceEndMs?: number;
  voiceBargeInSustainedMs?: number;
  appearanceColorScheme?: string;
  appearanceBackgroundColor?: string | null;
  appearanceForegroundColor?: string | null;
  appearanceFontScale?: number;
  appearanceFontSans?: string | null;
  appearanceFontMono?: string | null;
}

class UserSettingsService {
  /** Settings without the slash-command cache; procedures return this to clients. */
  get(): Promise<UserSettingsRecord> {
    return userSettingsAccessor.get();
  }

  update(data: UpdateUserSettingsInput): Promise<UserSettingsRecord> {
    return userSettingsAccessor.update(data);
  }

  getDefaultSessionProvider(): Promise<SessionProvider> {
    return userSettingsAccessor.getDefaultSessionProvider();
  }

  getWorkspaceOrder(projectId: string): Promise<string[]> {
    return userSettingsAccessor.getWorkspaceOrder(projectId);
  }

  updateWorkspaceOrder(projectId: string, workspaceIds: string[]): Promise<UserSettingsRecord> {
    return userSettingsAccessor.updateWorkspaceOrder(projectId, workspaceIds);
  }

  getSlashCommandCache(): Promise<SlashCommandCacheState> {
    return userSettingsAccessor.getSlashCommandCache();
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
