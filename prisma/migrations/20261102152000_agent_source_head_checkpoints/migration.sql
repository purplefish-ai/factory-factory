-- Additive only. Bounded application backfill verifies retained finalized proof.
CREATE TABLE "AgentSourceCheckpoint" (
    "connectionId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BUILDING',
    "nextOrdinal" INTEGER NOT NULL DEFAULT 0,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "executableCount" INTEGER NOT NULL DEFAULT 0,
    "verifiedCount" INTEGER NOT NULL DEFAULT 0,
    "headEventId" TEXT,
    "boundaryKnown" BOOLEAN NOT NULL DEFAULT false,
    "previousBoundaryEventId" TEXT,
    "initialSourceOrder" INTEGER,
    "sourceOrder" INTEGER,
    PRIMARY KEY ("connectionId", "scanId"),
    CONSTRAINT "AgentSourceCheckpoint_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentSourceState" ("connectionId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentSourceCheckpoint_connectionId_status_idx" ON "AgentSourceCheckpoint"("connectionId", "status");
CREATE TABLE "AgentSourceHead" (
    "connectionId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "precedingEventCount" INTEGER NOT NULL,
    PRIMARY KEY ("connectionId", "scanId", "providerEventId"),
    CONSTRAINT "AgentSourceHead_connectionId_scanId_fkey" FOREIGN KEY ("connectionId", "scanId") REFERENCES "AgentSourceCheckpoint" ("connectionId", "scanId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentSourceHead_connectionId_scanId_position_key" ON "AgentSourceHead"("connectionId", "scanId", "position");
CREATE INDEX "AgentSourceHead_connectionId_providerEventId_idx" ON "AgentSourceHead"("connectionId", "providerEventId");
CREATE INDEX "AgentSourceBaseline_connectionId_headEventId_idx" ON "AgentSourceBaseline"("connectionId", "headEventId");
CREATE INDEX "AgentSourcePage_connectionId_phase_scanId_ordinal_idx" ON "AgentSourcePage"("connectionId", "phase", "scanId", "ordinal");
