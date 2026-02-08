-- AlterTable
-- Remove unused ratchet settings that were disabled in the UI
-- These settings are consolidated into a single ratchetEnabled flag
PRAGMA foreign_keys=OFF;

-- Drop the unused columns
ALTER TABLE "UserSettings" DROP COLUMN "ratchetAutoFixCi";
ALTER TABLE "UserSettings" DROP COLUMN "ratchetAutoFixReviews";
ALTER TABLE "UserSettings" DROP COLUMN "ratchetAutoMerge";
ALTER TABLE "UserSettings" DROP COLUMN "ratchetAllowedReviewers";

PRAGMA foreign_keys=ON;
