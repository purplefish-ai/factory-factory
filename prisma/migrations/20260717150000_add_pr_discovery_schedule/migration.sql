-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "prDiscoveryLastCheckedAt" DATETIME;
ALTER TABLE "Workspace" ADD COLUMN "prDiscoveryRetryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Workspace" ADD COLUMN "prDiscoveryNextCheckAt" DATETIME;

-- CreateIndex
CREATE INDEX "Workspace_status_prUrl_prDiscoveryNextCheckAt_idx"
ON "Workspace"("status", "prUrl", "prDiscoveryNextCheckAt");
