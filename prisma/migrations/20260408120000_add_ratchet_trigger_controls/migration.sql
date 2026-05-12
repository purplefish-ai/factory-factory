-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "ratchetCiResponseEnabled" BOOLEAN;
ALTER TABLE "Workspace" ADD COLUMN "ratchetMergeConflictResponseEnabled" BOOLEAN;
ALTER TABLE "Workspace" ADD COLUMN "ratchetReviewResponseEnabled" BOOLEAN;

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
    "defaultSessionProvider" TEXT NOT NULL DEFAULT 'CLAUDE',
    "defaultClaudeModel" TEXT NOT NULL DEFAULT 'sonnet',
    "defaultCodexModel" TEXT NOT NULL DEFAULT 'default',
    "defaultWorkspacePermissions" TEXT NOT NULL DEFAULT 'STRICT',
    "ratchetPermissions" TEXT NOT NULL DEFAULT 'YOLO',
    "ratchetCiResponseEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ratchetMergeConflictResponseEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ratchetReviewResponseEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UserSettings" ("cachedSlashCommands", "createdAt", "customIdeCommand", "defaultClaudeModel", "defaultCodexModel", "defaultSessionProvider", "defaultWorkspacePermissions", "id", "notificationSoundPath", "playSoundOnComplete", "preferredIde", "ratchetEnabled", "ratchetPermissions", "updatedAt", "userId", "workspaceOrder") SELECT "cachedSlashCommands", "createdAt", "customIdeCommand", "defaultClaudeModel", "defaultCodexModel", "defaultSessionProvider", "defaultWorkspacePermissions", "id", "notificationSoundPath", "playSoundOnComplete", "preferredIde", "ratchetEnabled", "ratchetPermissions", "updatedAt", "userId", "workspaceOrder" FROM "UserSettings";
DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
CREATE INDEX "UserSettings_userId_idx" ON "UserSettings"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
