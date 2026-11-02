-- Legacy paths remain readable and published. Only new archives use the protocol.
ALTER TABLE "ClosedSession" ADD COLUMN "archiveKey" TEXT;
ALTER TABLE "ClosedSession" ADD COLUMN "archiveState" TEXT NOT NULL DEFAULT 'COMPLETE' CHECK ("archiveState" IN ('COMPLETE', 'PENDING'));
ALTER TABLE "ClosedSession" ADD COLUMN "pendingTranscript" TEXT;
ALTER TABLE "ClosedSession" ADD COLUMN "transcriptHash" TEXT;
CREATE UNIQUE INDEX "ClosedSession_archiveKey_key" ON "ClosedSession"("archiveKey");
CREATE INDEX "ClosedSession_archiveState_workspaceId_idx" ON "ClosedSession"("archiveState", "workspaceId");
