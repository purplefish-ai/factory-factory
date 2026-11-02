-- Retain canonical verifier resume/overlap state without changing published migrations.
ALTER TABLE "AgentSourceCheckpoint" ADD COLUMN "verification" JSONB;

-- Older BUILDING rows have only a count, not the resume/rewind state needed to
-- interpret their next page. Replay retained immutable proof from ordinal zero.
-- Keep every head/page/baseline; capture reuses matching indexed identities.
-- Active scans finish normally, then maintenance replays their complete proof.
UPDATE "AgentSourceCheckpoint"
SET "nextOrdinal" = 0, "entryCount" = 0, "executableCount" = 0, "verifiedCount" = 0,
    "validationCursor" = NULL
WHERE "status" = 'BUILDING';
