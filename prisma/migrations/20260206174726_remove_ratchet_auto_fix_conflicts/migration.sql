/*
  Warnings:

  - You are about to drop the column `ratchetAutoFixConflicts` on the `UserSettings` table. All the data in the column will be lost.

*/
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
    "ratchetAutoFixCi" BOOLEAN NOT NULL DEFAULT true,
    "ratchetAutoFixReviews" BOOLEAN NOT NULL DEFAULT true,
    "ratchetAutoMerge" BOOLEAN NOT NULL DEFAULT false,
    "ratchetAllowedReviewers" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UserSettings" ("cachedSlashCommands", "createdAt", "customIdeCommand", "id", "notificationSoundPath", "playSoundOnComplete", "preferredIde", "ratchetAllowedReviewers", "ratchetAutoFixCi", "ratchetAutoFixReviews", "ratchetAutoMerge", "ratchetEnabled", "updatedAt", "userId", "workspaceOrder") SELECT "cachedSlashCommands", "createdAt", "customIdeCommand", "id", "notificationSoundPath", "playSoundOnComplete", "preferredIde", "ratchetAllowedReviewers", "ratchetAutoFixCi", "ratchetAutoFixReviews", "ratchetAutoMerge", "ratchetEnabled", "updatedAt", "userId", "workspaceOrder" FROM "UserSettings";
DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
CREATE INDEX "UserSettings_userId_idx" ON "UserSettings"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
