-- Persist bounded validation progress. Existing COMPLETE checkpoints retain their proof contract.
ALTER TABLE "AgentSourceState" ADD COLUMN "authorityRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentSourceCheckpoint" ADD COLUMN "validationCursor" JSONB;
CREATE INDEX "AgentSourceBaseline_connectionId_id_idx" ON "AgentSourceBaseline"("connectionId", "id");

-- Changes to any authority consulted by promotion invalidate an in-flight traversal.
-- Triggers cover all writers (including restored/imported rows), in the same SQLite transaction.
-- INDEXED -> COMPLETE does not change the set of canonical ordinal claims.
CREATE TRIGGER "AgentSourceHead_validation_insert" AFTER INSERT ON "AgentSourceHead"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
END;

CREATE TRIGGER "AgentSourceHead_validation_update" AFTER UPDATE ON "AgentSourceHead"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId" AND OLD."connectionId" != NEW."connectionId";
END;

CREATE TRIGGER "AgentSourceHead_validation_delete" AFTER DELETE ON "AgentSourceHead"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId";
END;

CREATE TRIGGER "AgentSourceBaseline_validation_insert" AFTER INSERT ON "AgentSourceBaseline"
WHEN NEW."sourceOrder" IS NOT NULL
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
END;

CREATE TRIGGER "AgentSourceBaseline_validation_update" AFTER UPDATE ON "AgentSourceBaseline"
WHEN OLD."sourceOrder" IS NOT NEW."sourceOrder" OR OLD."headEventId" IS NOT NEW."headEventId" OR OLD."id" != NEW."id" OR OLD."connectionId" != NEW."connectionId"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId" AND OLD."connectionId" != NEW."connectionId";
END;

CREATE TRIGGER "AgentSourceBaseline_validation_delete" AFTER DELETE ON "AgentSourceBaseline"
WHEN OLD."sourceOrder" IS NOT NULL
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId";
END;

CREATE TRIGGER "AgentSourceCheckpoint_validation_insert" AFTER INSERT ON "AgentSourceCheckpoint"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
END;

CREATE TRIGGER "AgentSourceCheckpoint_validation_update" AFTER UPDATE ON "AgentSourceCheckpoint"
WHEN OLD."sourceOrder" IS NOT NEW."sourceOrder" OR (OLD."status" IN ('INDEXED', 'COMPLETE')) != (NEW."status" IN ('INDEXED', 'COMPLETE')) OR OLD."connectionId" != NEW."connectionId" OR OLD."scanId" != NEW."scanId"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId" AND OLD."connectionId" != NEW."connectionId";
END;

CREATE TRIGGER "AgentSourceCheckpoint_validation_delete" AFTER DELETE ON "AgentSourceCheckpoint"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId";
END;

CREATE TRIGGER "AgentSourcePage_validation_insert" AFTER INSERT ON "AgentSourcePage"
WHEN NEW."phase" = 'FINALIZED'
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
END;

CREATE TRIGGER "AgentSourcePage_validation_update" AFTER UPDATE ON "AgentSourcePage"
WHEN (OLD."phase" = 'FINALIZED' OR NEW."phase" = 'FINALIZED')
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId" AND OLD."connectionId" != NEW."connectionId";
END;

CREATE TRIGGER "AgentSourcePage_validation_delete" AFTER DELETE ON "AgentSourcePage"
WHEN OLD."phase" = 'FINALIZED'
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId";
END;

