-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL DEFAULT 'default',
    "preferredIde" TEXT NOT NULL DEFAULT 'cursor',
    "customIdeCommand" TEXT,
    "playSoundOnComplete" BOOLEAN NOT NULL DEFAULT true,
    "notificationSoundPath" TEXT,
    "workspaceOrder" JSONB,
    "cachedSlashCommands" JSONB,
    "ratchetEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ratchetReplyToPrComments" BOOLEAN NOT NULL DEFAULT true,
    "ratchetReviewTriggerMode" TEXT NOT NULL DEFAULT 'CHANGES_REQUESTED',
    "defaultSessionProvider" TEXT NOT NULL DEFAULT 'CLAUDE',
    "defaultClaudeModel" TEXT NOT NULL DEFAULT 'sonnet',
    "defaultCodexModel" TEXT NOT NULL DEFAULT 'default',
    "defaultClaudeReasoningEffort" TEXT,
    "defaultCodexReasoningEffort" TEXT,
    "defaultWorkspacePermissions" TEXT NOT NULL DEFAULT 'STRICT',
    "ratchetPermissions" TEXT NOT NULL DEFAULT 'YOLO',
    "voiceModeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deepgramApiKeyEncrypted" TEXT,
    "voiceTtsModel" TEXT NOT NULL DEFAULT 'aura-2-thalia-en',
    "voiceTtsSpeed" REAL NOT NULL DEFAULT 1,
    "voiceUtteranceEndMs" INTEGER NOT NULL DEFAULT 1000,
    "voiceBargeInSustainedMs" INTEGER NOT NULL DEFAULT 16,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UserSettings" ("cachedSlashCommands", "createdAt", "customIdeCommand", "deepgramApiKeyEncrypted", "defaultClaudeModel", "defaultClaudeReasoningEffort", "defaultCodexModel", "defaultCodexReasoningEffort", "defaultSessionProvider", "defaultWorkspacePermissions", "id", "notificationSoundPath", "playSoundOnComplete", "preferredIde", "ratchetEnabled", "ratchetPermissions", "ratchetReplyToPrComments", "ratchetReviewTriggerMode", "updatedAt", "userId", "voiceModeEnabled", "voiceTtsModel", "voiceTtsSpeed", "workspaceOrder") SELECT "cachedSlashCommands", "createdAt", "customIdeCommand", "deepgramApiKeyEncrypted", "defaultClaudeModel", "defaultClaudeReasoningEffort", "defaultCodexModel", "defaultCodexReasoningEffort", "defaultSessionProvider", "defaultWorkspacePermissions", "id", "notificationSoundPath", "playSoundOnComplete", "preferredIde", "ratchetEnabled", "ratchetPermissions", "ratchetReplyToPrComments", "ratchetReviewTriggerMode", "updatedAt", "userId", "voiceModeEnabled", "voiceTtsModel", "voiceTtsSpeed", "workspaceOrder" FROM "UserSettings";
DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
CREATE INDEX "UserSettings_userId_idx" ON "UserSettings"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
