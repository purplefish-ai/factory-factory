-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "appearanceBackgroundColor" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "appearanceColorScheme" TEXT NOT NULL DEFAULT 'factory';
ALTER TABLE "UserSettings" ADD COLUMN "appearanceFontMono" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "appearanceFontSans" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "appearanceFontScale" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "UserSettings" ADD COLUMN "appearanceForegroundColor" TEXT;
