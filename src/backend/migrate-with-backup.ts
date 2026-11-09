import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The full file name keeps `data.db` and `data.sqlite` in one directory apart. */
function backupPrefix(databasePath: string): string {
  return `${basename(databasePath)}-pre-migration-`;
}

function backupTimestamp(date: Date): string {
  // 2026-11-09T17:30:00.123Z -> 20261109T173000123Z: sorts chronologically by name.
  return date.toISOString().replace(/[-:.]/g, '');
}

const BACKUP_SUFFIX = /^\d{8}T\d{9}Z\.db$/;
const PARTIAL_SUFFIX = /^\d{8}T\d{9}Z\.db\.partial$/;
/** A partial copy this old was left by an interrupted process, not one still writing. */
const STALE_PARTIAL_MS = 60 * 60 * 1000;

function retainedCount(requested: number | undefined): number {
  return requested !== undefined && Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : PRE_MIGRATION_BACKUPS_TO_KEEP;
}

/** Delete backups beyond `keep` and stale partial copies; never other files. */
async function pruneBackups(
  directory: string,
  prefix: string,
  keep: number,
  now: Date
): Promise<void> {
  const ours = (await readdir(directory)).filter((fileName) => fileName.startsWith(prefix));
  const surplus = ours
    .filter((fileName) => BACKUP_SUFFIX.test(fileName.slice(prefix.length)))
    .sort()
    .reverse()
    .slice(keep);
  const stalePartials: string[] = [];
  for (const fileName of ours.filter((name) => PARTIAL_SUFFIX.test(name.slice(prefix.length)))) {
    const { mtimeMs } = await stat(join(directory, fileName));
    if (now.getTime() - mtimeMs > STALE_PARTIAL_MS) {
      stalePartials.push(fileName);
    }
  }
  await Promise.all(
    [...surplus, ...stalePartials].map((fileName) => rm(join(directory, fileName), { force: true }))
  );
}

async function backupBeforeMigrating(
  options: MigrateWithBackupOptions & { backupDirectory: string },
  warn: (msg: string) => void
): Promise<string> {
  const prefix = backupPrefix(options.databasePath);
  const now = (options.now ?? (() => new Date()))();
  const backupPath = join(options.backupDirectory, `${prefix}${backupTimestamp(now)}.db`);
  // Write under a name retention ignores, so an interrupted copy never displaces a good backup.
  const partialPath = `${backupPath}.partial`;
  await mkdir(options.backupDirectory, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone.
  await chmod(options.backupDirectory, 0o700);
  try {
    await snapshotSqliteDatabase(options.databasePath, partialPath);
    await rename(partialPath, backupPath);
  } finally {
    await rm(partialPath, { force: true });
  }
  try {
    await pruneBackups(
      options.backupDirectory,
      prefix,
      retainedCount(options.backupsToKeep),
      new Date()
    );
  } catch (error) {
    warn(`[migrate] Warning: could not prune old database backups: ${errorMessage(error)}`);
  }
  return backupPath;
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
      backupPath = await backupBeforeMigrating({ ...options, backupDirectory }, warn);
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
