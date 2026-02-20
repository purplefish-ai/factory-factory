ALTER TABLE "UserSettings" ADD COLUMN "defaultWorkspacePermissions" TEXT NOT NULL DEFAULT 'STRICT';
ALTER TABLE "UserSettings" ADD COLUMN "ratchetPermissions" TEXT NOT NULL DEFAULT 'YOLO';
