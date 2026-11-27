import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { snapshotSqliteDatabase } from './lib/sqlite-snapshot';
import { inspectMigrations, type MigrationOptions, runMigrations } from './migrate';
import { configService } from './services/config.service';

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

/** Set to `1` to migrate anyway when the pre-migration backup cannot be taken. */
export const ALLOW_MIGRATION_WITHOUT_BACKUP_ENV = 'FF_ALLOW_MIGRATION_WITHOUT_BACKUP';

/** The backup before pending migrations failed, so no migration was applied. */
export class MigrationBackupError extends Error {
  /** The directory the backup could not be written to. */
  readonly backupDirectory: string;

  constructor(reason: string, backupDirectory: string) {
    super(
      `Could not back up the database to ${backupDirectory} before migrating: ${reason}. ` +
        'No migration was applied and the database is unchanged. Fix the cause (for example ' +
        'free disk space or make that directory writable) and start again, or set ' +
        `${ALLOW_MIGRATION_WITHOUT_BACKUP_ENV}=1 to migrate without a backup.`
    );
    this.name = 'MigrationBackupError';
    this.backupDirectory = backupDirectory;
  }
}

const MIGRATION_WITHOUT_BACKUP_WARNING = '[migrate] Warning: migrating without a backup';

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

/**
 * The name a pre-migration backup of this database taken at `date` gets, which
 * retention counts among the backups it keeps.
 */
export function preMigrationBackupName(databasePath: string, date: Date): string {
  return `${backupPrefix(databasePath)}${backupTimestamp(date)}.db`;
}

/** The finished pre-migration backups of this database in `directory`; none when it is missing. */
export async function listPreMigrationBackups(
  databasePath: string,
  directory = getPreMigrationBackupDirectory(databasePath)
): Promise<string[]> {
  const prefix = backupPrefix(databasePath);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return names
    .filter((name) => name.startsWith(prefix) && BACKUP_SUFFIX.test(name.slice(prefix.length)))
    .sort();
}

/**
 * Apply the per-database retention to finished backups after `added` was put
 * in `directory` by other means: `added` always stays, and with it the newest
 * others up to {@link PRE_MIGRATION_BACKUPS_TO_KEEP} in all.
 */
export async function prunePreMigrationBackupsKeeping(
  databasePath: string,
  directory: string,
  added: string
): Promise<void> {
  const surplus = (await listPreMigrationBackups(databasePath, directory))
    .filter((name) => name !== added)
    .reverse()
    .slice(PRE_MIGRATION_BACKUPS_TO_KEEP - 1);
  await Promise.all(surplus.map((name) => rm(join(directory, name), { force: true })));
}

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

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * Claim an unused backup name. Creating its `.partial` file exclusively makes
 * the claim atomic, so concurrent launches never share or delete each other's copy.
 */
async function reserveBackupPath(directory: string, prefix: string, now: Date): Promise<string> {
  for (let offsetMs = 0; offsetMs < 1000; offsetMs += 1) {
    const backupPath = join(
      directory,
      `${prefix}${backupTimestamp(new Date(now.getTime() + offsetMs))}.db`
    );
    if (existsSync(backupPath)) {
      continue;
    }
    try {
      await (await open(`${backupPath}.partial`, 'wx', 0o600)).close();
      return backupPath;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
  }
  throw new Error(`No unused backup name in ${directory}`);
}

async function backupBeforeMigrating(
  options: MigrateWithBackupOptions & { backupDirectory: string },
  warn: (msg: string) => void
): Promise<string> {
  const prefix = backupPrefix(options.databasePath);
  await mkdir(options.backupDirectory, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone.
  await chmod(options.backupDirectory, 0o700);
  const backupPath = await reserveBackupPath(
    options.backupDirectory,
    prefix,
    (options.now ?? (() => new Date()))()
  );
  // Written under a name retention ignores, so an interrupted copy never displaces a good backup.
  const partialPath = `${backupPath}.partial`;
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
 * failed backup stops before any migration runs, because a migration cannot be
 * undone by an older version; `FF_ALLOW_MIGRATION_WITHOUT_BACKUP=1` migrates
 * anyway, with a warning.
 */
export async function runMigrationsWithBackup(options: MigrateWithBackupOptions): Promise<void> {
  const warn = options.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const log = options.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const backupDirectory =
    options.backupDirectory ?? getPreMigrationBackupDirectory(options.databasePath);
  let backupPath: string | undefined;
  const inspection = inspectMigrations(options);
  const refused =
    (options.unknownMigrations ?? 'refuse') === 'refuse' &&
    inspection.unknownAppliedMigrations.length > 0;
  if (inspection.hasAppliedMigrations && inspection.pendingMigrations.length > 0 && !refused) {
    try {
      backupPath = await backupBeforeMigrating({ ...options, backupDirectory }, warn);
      log(
        `[migrate] Backed up the database to ${backupPath} before applying ` +
          `${inspection.pendingMigrations.length} migration(s)`
      );
    } catch (error) {
      if (!configService.getAllowMigrationWithoutBackup()) {
        throw new MigrationBackupError(errorMessage(error), backupDirectory);
      }
      warn(
        `${MIGRATION_WITHOUT_BACKUP_WARNING}: could not back up the database to ` +
          `${backupDirectory}: ${errorMessage(error)}. Continuing because ` +
          `${ALLOW_MIGRATION_WITHOUT_BACKUP_ENV}=1.`
      );
    }
  }
  runMigrations({ ...options, log, warn, backupPath });
}
