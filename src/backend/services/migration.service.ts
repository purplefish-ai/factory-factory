/**
 * Migration Service
 *
 * Handles data migration from old directory structure to new structure.
 * Specifically migrates from ~/factory-factory to ~/.factory-factory
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.service';

const logger = createLogger('migration');

/**
 * Migrate data from old directory to new hidden directory
 *
 * Migration strategy:
 * - Old location: ~/factory-factory
 * - New location: ~/.factory-factory
 * - If new location exists, assume migration is done and skip
 * - If old location doesn't exist, nothing to migrate
 * - Copy (not move) all files from old to new location
 * - Preserve old directory for user to manually delete after verification
 */
export function migrateDataDirectory(): void {
  const oldDir = join(homedir(), 'factory-factory');
  const newDir = join(homedir(), '.factory-factory');

  // Skip if new directory already exists
  if (existsSync(newDir)) {
    logger.debug('New directory ~/.factory-factory already exists, skipping migration');
    return;
  }

  // Skip if old directory doesn't exist
  if (!existsSync(oldDir)) {
    logger.debug('Old directory ~/factory-factory does not exist, skipping migration');
    return;
  }

  logger.info('Migrating data from ~/factory-factory to ~/.factory-factory');

  try {
    // Create parent directory if needed (shouldn't be needed for home directory)
    mkdirSync(newDir, { recursive: true });

    // Copy all files and subdirectories recursively
    cpSync(oldDir, newDir, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: false,
    });

    logger.info('Migration completed successfully');
    logger.info('Old directory ~/factory-factory has been preserved');
    logger.info('You can safely delete it after verifying the migration worked');
  } catch (error) {
    logger.error('Migration failed', { error });
    throw new Error(
      `Failed to migrate data from ~/factory-factory to ~/.factory-factory: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
