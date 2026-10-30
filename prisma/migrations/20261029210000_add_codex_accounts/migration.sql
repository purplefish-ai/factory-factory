CREATE TABLE "CodexAccount" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "label" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "enabled" BOOLEAN NOT NULL DEFAULT true,
 "identityKey" TEXT,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "CodexAccount_identityKey_key" ON "CodexAccount"("identityKey");
INSERT INTO "CodexAccount" ("id", "label", "kind", "updatedAt") VALUES ('codex-native-default', 'Native default', 'NATIVE_DEFAULT', CURRENT_TIMESTAMP);
ALTER TABLE "AgentSession" ADD COLUMN "codexAccountId" TEXT REFERENCES "CodexAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
UPDATE "AgentSession" SET "codexAccountId" = 'codex-native-default' WHERE "provider" = 'CODEX';
CREATE INDEX "AgentSession_codexAccountId_idx" ON "AgentSession"("codexAccountId");
