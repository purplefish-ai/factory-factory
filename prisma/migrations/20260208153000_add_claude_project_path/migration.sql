-- Add persisted Claude project path so session history lookup does not depend on runtime workingDir.
ALTER TABLE "ClaudeSession" ADD COLUMN "claudeProjectPath" TEXT;
