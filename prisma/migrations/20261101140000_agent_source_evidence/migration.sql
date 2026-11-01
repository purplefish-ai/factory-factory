-- CreateTable
CREATE TABLE "AgentSourcePage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "requestPage" INTEGER NOT NULL,
    "nextPage" INTEGER,
    "sourceOrder" INTEGER,
    "evidence" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSourcePage_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentSourceState" ("connectionId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentSourceBaseline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "headEventId" TEXT,
    "afterHeadEventId" TEXT,
    "sourceOrder" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSourceBaseline_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AgentSourceState" ("connectionId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentSourcePage_connectionId_scanId_ordinal_key" ON "AgentSourcePage"("connectionId", "scanId", "ordinal");

-- CreateIndex
CREATE INDEX "AgentSourceBaseline_connectionId_sourceOrder_idx" ON "AgentSourceBaseline"("connectionId", "sourceOrder");
