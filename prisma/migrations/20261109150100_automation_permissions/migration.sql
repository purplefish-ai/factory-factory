-- Existing and new installations default automation runs to auto review.
ALTER TABLE "UserSettings" ADD COLUMN "automationPermissions" TEXT NOT NULL DEFAULT 'RELAXED';
