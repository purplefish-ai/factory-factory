import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { snapshotSqliteDatabase } from './lib/sqlite-snapshot';
import { inspectMigrations, type MigrationOptions, runMigrations } from './migrate';

/** Pre-migration snapshots kept per database; older ones are deleted after a new one succeeds. */
export const PRE_MIGRATION_BACKUPS_TO_KEEP = 3;

export interface MigrateWithBackupOptions extends Omit<MigrationOptions, 'backupPath'> {
  /** Defaults to {@link getPreMigrationBackupDirectory}. */
  backupDirectory?: string;
  backupsToKeep?: number;
  now?: () => Date;
}

/** `db-backups` beside the database, so the snapshots live on the same volume as the data. */
export function getPreMigrationBackupDirectory(databasePath: string): string {
  return join(dirname(databasePath), 'db-backups');
}

function backupPrefix(databasePath: string): string {
  const name = basename(databasePath);
  return `${name.slice(0, name.length - extname(name).length) || name}-pre-migration-`;
}

function backupTimestamp(date: Date): string {
  // 2026-11-09T17:30:00.123Z -> 20261109T173000123Z: sorts chronologically by name.
  return date.toISOString().replace(/[-:.]/g, '');
}

function isPreMigrationBackup(fileName: string, prefix: string): boolean {
  return fileName.startsWith(prefix) && /^\d{8}T\d{9}Z\.db$/.test(fileName.slice(prefix.length));
}

async function pruneBackups(directory: string, prefix: string, keep: number): Promise<void> {
  const backups = (await readdir(directory))
    .filter((fileName) => isPreMigrationBackup(fileName, prefix))
    .sort()
    .reverse();
  await Promise.all(
    backups.slice(keep).map((fileName) => rm(join(directory, fileName), { force: true }))
  );
}

async function backupBeforeMigrating(
  options: MigrateWithBackupOptions & { backupDirectory: string }
): Promise<string> {
  const prefix = backupPrefix(options.databasePath);
  const backupPath = join(
    options.backupDirectory,
    `${prefix}${backupTimestamp((options.now ?? (() => new Date()))())}.db`
  );
  // Write under a name pruning ignores, so an interrupted copy never displaces a good backup.
  const partialPath = `${backupPath}.partial`;
  await mkdir(options.backupDirectory, { recursive: true, mode: 0o700 });
  try {
    await snapshotSqliteDatabase(options.databasePath, partialPath);
    await rename(partialPath, backupPath);
  } finally {
    await rm(partialPath, { force: true });
  }
  await pruneBackups(
    options.backupDirectory,
    prefix,
    Math.max(1, options.backupsToKeep ?? PRE_MIGRATION_BACKUPS_TO_KEEP)
  );
  return backupPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run migrations after snapshotting the database when any are pending. Fresh
 * databases, up-to-date databases and refused downgrades are not copied. A
 * failed backup is a warning: the database still starts, without a backup.
 */
export async function runMigrationsWithBackup(options: MigrateWithBackupOptions): Promise<void> {
  const warn = options.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const log = options.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const backupDirectory =
    options.backupDirectory ?? getPreMigrationBackupDirectory(options.databasePath);
  let backupPath: string | undefined;
  try {
    const inspection = inspectMigrations(options);
    const refused =
      (options.unknownMigrations ?? 'refuse') === 'refuse' &&
      inspection.unknownAppliedMigrations.length > 0;
    if (inspection.hasAppliedMigrations && inspection.pendingMigrations.length > 0 && !refused) {
      backupPath = await backupBeforeMigrating({ ...options, backupDirectory });
      log(
        `[migrate] Backed up the database to ${backupPath} before applying ` +
          `${inspection.pendingMigrations.length} migration(s)`
      );
    }
  } catch (error) {
    warn(
      `[migrate] Warning: could not back up the database before migrating: ${errorMessage(error)}. ` +
        'Continuing without a backup.'
    );
  }
  runMigrations({ ...options, log, warn, backupPath });
}
