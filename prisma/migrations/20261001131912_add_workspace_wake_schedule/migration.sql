-- CreateTable
CREATE TABLE "WorkspaceWakeSchedule" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cadence" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "scheduledTime" TEXT,
    "timezone" TEXT,
    "scheduledDayOfMonth" INTEGER,
    "nextWakeAt" DATETIME,
    "lastWakeAt" DATETIME,
    "lastOutcome" TEXT,
    "lastError" TEXT,
    CONSTRAINT "WorkspaceWakeSchedule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WorkspaceWakeSchedule_nextWakeAt_idx" ON "WorkspaceWakeSchedule"("nextWakeAt");
