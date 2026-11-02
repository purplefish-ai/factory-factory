CREATE TABLE "PromptDispatchAttempt" (
 "id" TEXT NOT NULL PRIMARY KEY, "sessionId" TEXT NOT NULL,
 "members" JSONB NOT NULL, "content" JSONB NOT NULL,
 "effectiveSettings" JSONB NOT NULL, "providerIdentity" JSONB NOT NULL,
 "sendGeneration" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'uncertain',
 "evidence" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "settledAt" DATETIME,
 CONSTRAINT "PromptDispatchAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PromptDispatchAttempt_sessionId_status_idx" ON "PromptDispatchAttempt"("sessionId", "status");
CREATE TABLE "ChatIntent" (
 "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "sessionId" TEXT NOT NULL,
 "messageId" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "submitted" JSONB NOT NULL,
 "desired" JSONB NOT NULL, "revision" INTEGER NOT NULL DEFAULT 0,
 "status" TEXT NOT NULL DEFAULT 'queued', "attemptId" TEXT,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ChatIntent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "ChatIntent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PromptDispatchAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ChatIntent_sessionId_messageId_key" ON "ChatIntent"("sessionId", "messageId");
CREATE INDEX "ChatIntent_sessionId_status_id_idx" ON "ChatIntent"("sessionId", "status", "id");
CREATE INDEX "ChatIntent_attemptId_idx" ON "ChatIntent"("attemptId");
