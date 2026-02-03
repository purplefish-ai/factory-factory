-- Add needsAttention field to Workspace
ALTER TABLE "Workspace" ADD COLUMN "needsAttention" BOOLEAN NOT NULL DEFAULT false;
