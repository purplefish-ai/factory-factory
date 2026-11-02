-- Two bounded index seeks compare every retained head with all issued baseline claims.
CREATE INDEX "AgentSourceBaseline_connectionId_headEventId_sourceOrder_idx"
  ON "AgentSourceBaseline"("connectionId", "headEventId", "sourceOrder");

-- Extend the forward fence to every checkpoint claim consulted during promotion.
-- Cursor bookkeeping and INDEXED -> COMPLETE still do not change authority.
DROP TRIGGER "AgentSourceCheckpoint_validation_update";
CREATE TRIGGER "AgentSourceCheckpoint_validation_update" AFTER UPDATE ON "AgentSourceCheckpoint"
WHEN OLD."sourceOrder" IS NOT NEW."sourceOrder"
  OR OLD."previousBoundaryEventId" IS NOT NEW."previousBoundaryEventId"
  OR OLD."initialSourceOrder" IS NOT NEW."initialSourceOrder"
  OR OLD."entryCount" != NEW."entryCount"
  OR OLD."headEventId" IS NOT NEW."headEventId"
  OR (OLD."status" IN ('INDEXED', 'COMPLETE')) != (NEW."status" IN ('INDEXED', 'COMPLETE'))
  OR OLD."connectionId" != NEW."connectionId" OR OLD."scanId" != NEW."scanId"
BEGIN
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = NEW."connectionId";
  UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1 WHERE "connectionId" = OLD."connectionId" AND OLD."connectionId" != NEW."connectionId";
END;

-- Existing cursor-v2 chunks predate the stronger checks. Restart them on maintenance.
UPDATE "AgentSourceState" SET "authorityRevision" = "authorityRevision" + 1;
