/**
 * Migration Service
 *
 * Handles data migration from old directory structure to new structure.
 * Specifically migrates from ~/factory-factory to ~/.factory-factory
 */

import { cpSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.service';

const logger = createLogger('migration');

const MIGRATION_MARKER = '.migrated';

/**
 * Migrate data from old directory to new hidden directory
 *
 * Migration strategy:
 * - Old location: ~/factory-factory
 * - New location: ~/.factory-factory
 * - Uses a marker file (.migrated) to track completion instead of directory existence
 * - Copies to a temp directory then renames atomically to avoid partial state
 * - Preserves old directory for user to manually delete after verification
 */
export function migrateDataDirectory(): void {
  const oldDir = join(homedir(), 'factory-factory');
  const newDir = join(homedir(), '.factory-factory');
  const markerFile = join(newDir, MIGRATION_MARKER);

  // Skip if migration was already completed (marker file exists)
  if (existsSync(markerFile)) {
    logger.debug('Migration marker exists, skipping migration');
    return;
  }

  // Skip if old directory doesn't exist (nothing to migrate)
  if (!existsSync(oldDir)) {
    logger.debug('Old directory ~/factory-factory does not exist, skipping migration');
    return;
  }

  // If new directory already has data.db, treat as already migrated and write marker
  if (existsSync(join(newDir, 'data.db'))) {
    logger.debug('New directory already contains data.db, writing migration marker');
    writeFileSync(markerFile, new Date().toISOString());
    return;
  }

  logger.info('Migrating data from ~/factory-factory to ~/.factory-factory');

  // Copy to a temp directory first, then rename atomically to avoid partial state
  const tmpDir = join(homedir(), '.factory-factory-migrating');

  try {
    // Clean up any stale temp dir from a previous failed attempt
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // Copy all data to temp directory
    cpSync(oldDir, tmpDir, { recursive: true, preserveTimestamps: true });

    // Atomic rename into place (same filesystem guarantees atomicity)
    if (existsSync(newDir)) {
      // New dir exists (empty/partial) - remove it first so rename succeeds
      rmSync(newDir, { recursive: true, force: true });
    }
    renameSync(tmpDir, newDir);

    // Write migration marker to indicate successful completion
    writeFileSync(join(newDir, MIGRATION_MARKER), new Date().toISOString());

    logger.info('Migration completed successfully');
    logger.info('Old directory ~/factory-factory has been preserved');
    logger.info('You can safely delete it after verifying the migration worked');
  } catch (error) {
    // Clean up temp directory on failure
    try {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // Non-critical: temp dir cleanup failure
    }
    logger.error('Migration failed', { error });
    throw new Error(
      `Failed to migrate data from ~/factory-factory to ~/.factory-factory: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
