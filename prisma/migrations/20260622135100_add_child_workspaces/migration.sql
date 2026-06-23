-- Depth-1 constraint: a workspace that already has a parent cannot itself become a parent.
-- SQLite does not support subquery CHECK constraints, so we use a trigger instead.
CREATE TRIGGER enforce_workspace_depth_1
BEFORE INSERT ON "Workspace"
WHEN NEW."parent_workspace_id" IS NOT NULL
BEGIN
  -- Block self-parenting
  SELECT RAISE(ABORT, 'A workspace cannot be its own parent')
  WHERE NEW."id" = NEW."parent_workspace_id";
  -- Block grandchild chains: proposed parent must not already have a parent
  SELECT RAISE(ABORT, 'Child workspaces cannot have children (max depth 1)')
  WHERE EXISTS (
    SELECT 1 FROM "Workspace"
    WHERE "id" = NEW."parent_workspace_id"
    AND "parent_workspace_id" IS NOT NULL
  );
END;

CREATE TRIGGER enforce_workspace_depth_1_update
BEFORE UPDATE ON "Workspace"
WHEN NEW."parent_workspace_id" IS NOT NULL
BEGIN
  -- Block self-parenting
  SELECT RAISE(ABORT, 'A workspace cannot be its own parent')
  WHERE NEW."id" = NEW."parent_workspace_id";
  -- Block grandchild chains: proposed parent must not already have a parent
  SELECT RAISE(ABORT, 'Child workspaces cannot have children (max depth 1)')
  WHERE EXISTS (
    SELECT 1 FROM "Workspace"
    WHERE "id" = NEW."parent_workspace_id"
    AND "parent_workspace_id" IS NOT NULL
  );
  -- Block re-parenting a workspace that already has children
  SELECT RAISE(ABORT, 'Cannot re-parent a workspace that already has children (max depth 1)')
  WHERE EXISTS (
    SELECT 1 FROM "Workspace"
    WHERE "parent_workspace_id" = NEW."id"
  );
END;