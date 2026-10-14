ALTER TABLE "WorkspacePRMonitoring" ADD COLUMN "deliveryMode" TEXT NOT NULL DEFAULT 'MAIN';

CREATE TABLE "WorkspacePRDedicatedSession" (
    "prId" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    CONSTRAINT "WorkspacePRDedicatedSession_prId_fkey" FOREIGN KEY ("prId") REFERENCES "WorkspacePR" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkspacePRDedicatedSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkspacePRDedicatedSession_sessionId_key" ON "WorkspacePRDedicatedSession"("sessionId");
