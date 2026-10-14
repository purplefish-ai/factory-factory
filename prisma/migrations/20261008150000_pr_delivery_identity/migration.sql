ALTER TABLE "WorkspacePREvent" ADD COLUMN "deliveryProvider" TEXT;
ALTER TABLE "WorkspacePREvent" ADD COLUMN "deliveryProviderSessionId" TEXT;
CREATE INDEX "ClosedSession_sessionId_completedAt_idx" ON "ClosedSession"("sessionId", "completedAt");
