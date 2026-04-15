-- Remove autoApprovePermissions column (replaced by defaultWorkspacePermissions and ratchetPermissions)
ALTER TABLE "UserSettings" DROP COLUMN "autoApprovePermissions";
