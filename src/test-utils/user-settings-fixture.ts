import type { UserSettings } from '@prisma-gen/client';

/**
 * A complete `UserSettings` row with the schema defaults, so tests that only
 * care about a few fields stop breaking whenever a column is added.
 */
export function buildUserSettingsFixture(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    id: 'settings-1',
    userId: 'default',
    preferredIde: 'cursor',
    customIdeCommand: null,
    playSoundOnComplete: true,
    notificationSoundPath: null,
    workspaceOrder: null,
    cachedSlashCommands: null,
    ratchetEnabled: false,
    ratchetReplyToPrComments: true,
    ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
    defaultSessionProvider: 'CLAUDE',
    defaultClaudeModel: 'sonnet',
    defaultCodexModel: 'default',
    defaultClaudeReasoningEffort: null,
    defaultCodexReasoningEffort: null,
    defaultWorkspacePermissions: 'STRICT',
    ratchetPermissions: 'YOLO',
    reviewerSessionProvider: 'CODEX',
    reviewerClaudeModel: null,
    reviewerCodexModel: null,
    postReviewToGitHub: true,
    voiceModeEnabled: false,
    deepgramApiKeyEncrypted: null,
    voiceTtsModel: 'flux-haley-en',
    voiceTtsSpeed: 1,
    voiceUtteranceEndMs: 1000,
    voiceBargeInSustainedMs: 16,
    appearanceColorScheme: 'factory',
    appearanceBackgroundColor: null,
    appearanceForegroundColor: null,
    appearanceFontScale: 100,
    appearanceFontSans: null,
    appearanceFontMono: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
