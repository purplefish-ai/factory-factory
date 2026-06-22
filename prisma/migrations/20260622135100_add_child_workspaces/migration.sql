-- Depth-1 constraint: a workspace that already has a parent cannot itself become a parent.
-- SQLite does not support subquery CHECK constraints, so we use a trigger instead.
CREATE TRIGGER enforce_workspace_depth_1
BEFORE INSERT ON "Workspace"
WHEN NEW."parent_workspace_id" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Child workspaces cannot have children (max depth 1)')
  WHERE EXISTS (
    SELECT 1 FROM "Workspace"
    WHERE "id" = NEW."parent_workspace_id"
    AND "parent_workspace_id" IS NOT NULL
  );
END;