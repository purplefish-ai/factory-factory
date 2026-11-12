-- Slack Socket Mode needs an app-level token in addition to the bot token.
-- Store it encrypted in its own column, with the bot's app ID it was validated
-- against. Both are nullable so existing connections are unchanged.

-- AlterTable
ALTER TABLE "AgentConnection" ADD COLUMN "appCredentialsEncrypted" TEXT;
ALTER TABLE "AgentConnection" ADD COLUMN "appId" TEXT;
