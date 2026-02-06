-- Remove MERGE_CONFLICT from RatchetState enum.
-- Merge conflicts are now resolved opportunistically by agents syncing with
-- main before CI/review fixes, so MERGE_CONFLICT is no longer a distinct state.

-- Migrate any existing rows with MERGE_CONFLICT to IDLE (next poll re-evaluates).
UPDATE "Workspace" SET "ratchetState" = 'IDLE' WHERE "ratchetState" = 'MERGE_CONFLICT';
UPDATE "Workspace" SET "ratchetLastNotifiedState" = NULL WHERE "ratchetLastNotifiedState" = 'MERGE_CONFLICT';
