-- Simplify KanbanColumn enum from 7 values to 3: WORKING, WAITING, DONE
-- Migration strategy:
-- - BACKLOG, IN_PROGRESS -> WORKING (initializing or actively working)
-- - PR_OPEN, WAITING, APPROVED -> WAITING (idle, waiting for input)
-- - MERGED, DONE -> DONE (completed)

-- Step 1: Update existing cachedKanbanColumn values to new enum values
UPDATE "Workspace"
SET "cachedKanbanColumn" = CASE
  WHEN "cachedKanbanColumn" IN ('BACKLOG', 'IN_PROGRESS') THEN 'WORKING'
  WHEN "cachedKanbanColumn" IN ('PR_OPEN', 'WAITING', 'APPROVED') THEN 'WAITING'
  WHEN "cachedKanbanColumn" IN ('MERGED', 'DONE') THEN 'DONE'
  ELSE 'WAITING'
END;
