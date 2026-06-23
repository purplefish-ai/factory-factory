-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_workspace_notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL,
    "source_workspace_id" TEXT NOT NULL,
    "source_workspace_name" TEXT NOT NULL,
    "source_project_name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'CHILD_TO_PARENT',
    "delivered_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_workspace_notifications" ("created_at", "delivered_at", "id", "message", "source_project_name", "source_workspace_id", "source_workspace_name", "workspace_id") SELECT "created_at", "delivered_at", "id", "message", "source_project_name", "source_workspace_id", "source_workspace_name", "workspace_id" FROM "workspace_notifications";
DROP TABLE "workspace_notifications";
ALTER TABLE "new_workspace_notifications" RENAME TO "workspace_notifications";
CREATE INDEX "workspace_notifications_workspace_id_idx" ON "workspace_notifications"("workspace_id");
CREATE INDEX "workspace_notifications_workspace_id_delivered_at_idx" ON "workspace_notifications"("workspace_id", "delivered_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
