ALTER TABLE "workspace_notifications" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspace_notifications" ADD COLUMN "subject" TEXT;
ALTER TABLE "workspace_notifications" ADD COLUMN "preview" TEXT NOT NULL DEFAULT '';
ALTER TABLE "workspace_notifications" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'MESSAGE';
ALTER TABLE "workspace_notifications" ADD COLUMN "task_key" TEXT;
ALTER TABLE "workspace_notifications" ADD COLUMN "task_revision" INTEGER;
ALTER TABLE "workspace_notifications" ADD COLUMN "read_at" DATETIME;
ALTER TABLE "workspace_notifications" ADD COLUMN "acknowledged_at" DATETIME;
ALTER TABLE "workspace_notifications" ADD COLUMN "superseded_at" DATETIME;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS revision
  FROM workspace_notifications
)
UPDATE workspace_notifications SET
  revision = (SELECT revision FROM ordered WHERE ordered.id = workspace_notifications.id),
  preview = SUBSTR(message, 1, 160),
  acknowledged_at = delivered_at;

CREATE TABLE "workspace_mail_state" (
  "workspace_id" TEXT NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "notified_revision" INTEGER NOT NULL DEFAULT 0,
  "wake_acknowledged_revision" INTEGER NOT NULL DEFAULT 0,
  "claim_id" TEXT,
  "claim_revision" INTEGER,
  "wake_ambiguous_at" DATETIME,
  "claimed_at" DATETIME,
  CONSTRAINT "workspace_mail_state_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO workspace_mail_state(workspace_id,revision)
SELECT workspace_id,MAX(revision) FROM workspace_notifications GROUP BY workspace_id;
CREATE UNIQUE INDEX "workspace_notifications_workspace_id_revision_key" ON "workspace_notifications"("workspace_id", "revision");
CREATE INDEX "workspace_notifications_workspace_id_acknowledged_at_superseded_at_kind_idx" ON "workspace_notifications"("workspace_id", "acknowledged_at", "superseded_at", "kind");
