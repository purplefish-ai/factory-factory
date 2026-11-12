-- An explicit source reset starts a new epoch beside the old proof. Every proof row records
-- the epoch that wrote it; only the current epoch's rows are authority for ordinals.
-- Existing rows belong to epoch 0, whose authority is unchanged. ADD COLUMN keeps the
-- existing CHECK constraints and authority-revision triggers on these tables intact.
ALTER TABLE "AgentSourceState" ADD COLUMN "epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentSourceState" ADD COLUMN "epochStartSourceOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentSourcePage" ADD COLUMN "epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentSourceCheckpoint" ADD COLUMN "epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentSourceHead" ADD COLUMN "epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentSourceBaseline" ADD COLUMN "epoch" INTEGER NOT NULL DEFAULT 0;
-- Events captured in an earlier epoch can never receive a source order.
ALTER TABLE "AgentEvent" ADD COLUMN "sourceEpoch" INTEGER NOT NULL DEFAULT 0;

-- Bounded keyset traversals within one epoch.
CREATE INDEX "AgentSourcePage_connectionId_epoch_phase_scanId_ordinal_idx" ON "AgentSourcePage"("connectionId", "epoch", "phase", "scanId", "ordinal");
CREATE INDEX "AgentSourceCheckpoint_connectionId_epoch_status_idx" ON "AgentSourceCheckpoint"("connectionId", "epoch", "status");
CREATE INDEX "AgentSourceHead_connectionId_epoch_scanId_position_idx" ON "AgentSourceHead"("connectionId", "epoch", "scanId", "position");
CREATE INDEX "AgentSourceBaseline_connectionId_epoch_id_idx" ON "AgentSourceBaseline"("connectionId", "epoch", "id");
CREATE INDEX "AgentSourceBaseline_connectionId_epoch_headEventId_sourceOrder_idx" ON "AgentSourceBaseline"("connectionId", "epoch", "headEventId", "sourceOrder");

-- Epoch membership decides which rows promotion consults, so changing it (or the current
-- epoch and its starting ordinal) invalidates an in-flight validation traversal.
-- Head and FINALIZED page update triggers already fire on every update.
DROP TRIGGER "AgentSourceBaseline_validation_update";
CREATE TRIGGER "AgentSourceBaseline_validation_update" AFTER UPDATE ON "AgentSourceBaseline"
WHEN OLD."sourceOrder" IS NOT NEW."sourceOrder" OR OLD."headEventId" IS NOT NEW."headEventId" OR OLD."id" != NEW."id" OR OLD."connectionId" != NEW."connectionId" OR OLD."epoch" != NEW."epoch"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId" AND OLD."connectionId" != NEW."connectionId";
END;

DROP TRIGGER "AgentSourceCheckpoint_validation_update";
CREATE TRIGGER "AgentSourceCheckpoint_validation_update" AFTER UPDATE ON "AgentSourceCheckpoint"
WHEN OLD."sourceOrder" IS NOT NEW."sourceOrder"
  OR OLD."previousBoundaryEventId" IS NOT NEW."previousBoundaryEventId"
  OR OLD."initialSourceOrder" IS NOT NEW."initialSourceOrder"
  OR OLD."entryCount" != NEW."entryCount"
  OR OLD."headEventId" IS NOT NEW."headEventId"
  OR (OLD."status" IN ('INDEXED', 'COMPLETE')) != (NEW."status" IN ('INDEXED', 'COMPLETE'))
  OR OLD."connectionId" != NEW."connectionId" OR OLD."scanId" != NEW."scanId"
  OR OLD."epoch" != NEW."epoch"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId" AND OLD."connectionId" != NEW."connectionId";
END;

-- recursive_triggers is off, and the nested update leaves the epoch unchanged.
CREATE TRIGGER "AgentSourceState_epoch_update" AFTER UPDATE ON "AgentSourceState"
WHEN OLD."epoch" != NEW."epoch" OR OLD."epochStartSourceOrder" != NEW."epochStartSourceOrder"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
END;
