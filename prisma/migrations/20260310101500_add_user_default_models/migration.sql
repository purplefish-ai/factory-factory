ALTER TABLE "UserSettings" ADD COLUMN "defaultClaudeModel" TEXT NOT NULL DEFAULT 'sonnet';
ALTER TABLE "UserSettings" ADD COLUMN "defaultCodexModel" TEXT NOT NULL DEFAULT 'default';
