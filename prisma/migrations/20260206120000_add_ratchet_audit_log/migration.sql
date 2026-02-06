-- CreateTable
CREATE TABLE "RatchetAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "prNumber" INTEGER,
    "previousState" TEXT NOT NULL,
    "newState" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actionDetail" TEXT,
    "prSnapshot" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RatchetAuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RatchetAuditLog_workspaceId_timestamp_idx" ON "RatchetAuditLog"("workspaceId", "timestamp");

-- CreateIndex
CREATE INDEX "RatchetAuditLog_timestamp_idx" ON "RatchetAuditLog"("timestamp");
