import type { Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { snapshotSqliteDatabase } from '@/backend/lib/sqlite-snapshot';
import { getPreMigrationBackupDirectory } from '@/backend/migrate-with-backup';
import {
  BACKUP_CODEX_ACCOUNTS_DIRECTORY,
  BACKUP_DATABASE_FILE,
  BACKUP_ENCRYPTION_KEY_FILE,
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_FILE,
  BACKUP_PARTIAL_SUFFIX,
  type BackupManifest,
  BackupManifestSchema,
  isNotFound,
} from './backup-manifest';
import { getBaseDir, resolveDatabasePath } from './database-path';

export interface CreateBackupOptions {
  databasePath: string;
  /** The data directory holding `encryption.key` and `codex-accounts/`. */
  baseDir: string;
  applicationVersion: string;
  /** The backup directory to create; it must not exist. Defaults to a new one in `db-backups/`. */
  destination?: string;
  now?: () => Date;
}

export interface BackupResult {
  directory: string;
  manifest: BackupManifest;
  /** Entries under `codex-accounts/` that are not regular files or directories and were not copied. */
  skipped: string[];
  /** Unfinished `.partial` backups found beside a default backup, left by an interrupted run. */
  leftovers: string[];
}

async function lstatIfExists(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/** 20261127T101500123Z: sorts chronologically, safe in a file name. */
function timestampForName(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

/** Copy a secret file; it ends with the original's mode, never wider. */
async function copySecretFile(source: string, destination: string, mode: number): Promise<void> {
  await writeFile(destination, '', { mode: 0o600 });
  await copyFile(source, destination);
  await chmod(destination, mode);
}

/**
 * Copy a directory tree preserving each entry's mode. Symlinks and other
 * special files are skipped rather than followed: a link could point at
 * credentials outside the directory, and Factory Factory never creates one.
 */
async function copyTree(source: string, destination: string, skipped: string[]): Promise<void> {
  const sourceStats = await lstat(source);
  // Created owner-only and widened to the original's mode only after it is filled.
  await mkdir(destination, { mode: 0o700 });
  for (const name of await readdir(source)) {
    const from = join(source, name);
    const to = join(destination, name);
    const stats = await lstat(from);
    if (stats.isDirectory()) {
      await copyTree(from, to, skipped);
    } else if (stats.isFile()) {
      await copySecretFile(from, to, stats.mode & 0o777);
    } else {
      skipped.push(from);
    }
  }
  await chmod(destination, sourceStats.mode & 0o777);
}

async function copyEncryptionKey(baseDir: string, directory: string): Promise<boolean> {
  const source = join(baseDir, 'encryption.key');
  const stats = await lstatIfExists(source);
  if (!stats) {
    return false;
  }
  if (!stats.isFile()) {
    throw new Error(`${source} is not a regular file; refusing to back it up.`);
  }
  await copySecretFile(source, join(directory, BACKUP_ENCRYPTION_KEY_FILE), stats.mode & 0o777);
  return true;
}

async function copyCodexAccounts(
  baseDir: string,
  directory: string,
  skipped: string[]
): Promise<boolean> {
  const source = join(baseDir, 'codex-accounts');
  const stats = await lstatIfExists(source);
  if (!stats) {
    return false;
  }
  if (!stats.isDirectory()) {
    throw new Error(`${source} is not a directory; refusing to back it up.`);
  }
  await copyTree(source, join(directory, BACKUP_CODEX_ACCOUNTS_DIRECTORY), skipped);
  return true;
}

/**
 * Where an absolute path really leads: the real path of its nearest existing
 * ancestor with the missing rest appended, so a path not created yet still has
 * the links on its way resolved.
 */
async function realPathAllowingMissing(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const parent = dirname(current);
      if (!isNotFound(error) || parent === current) {
        throw error;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function isInside(path: string, directory: string): boolean {
  const relation = relative(directory, path);
  // `..foo` is a child named `..foo`; only `..` itself or `../...` leads out.
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function describeExistingDestination(directory: string, isDefault: boolean): string {
  return isDefault
    ? `${directory} already exists: another backup started at the same moment, or the ` +
        'clock was set back. Run `ff backup` again, or choose a new directory with ' +
        '`ff backup --output <path>`.'
    : `${directory} already exists, and ff backup never writes into an existing path. ` +
        'Run `ff backup --output <path>` with a path that does not exist yet.';
}

/**
 * A kill between claiming the final name and the rename leaves an empty
 * `<directory>` beside its `.partial`.
 */
async function isInterruptedRename(directory: string, building: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length === 0 && !!(await lstatIfExists(building));
  } catch {
    return false;
  }
}

function describeInterruptedRename(directory: string, building: string): string {
  return (
    `${directory} is an empty directory a backup left when it was interrupted while ` +
    `finishing. If ${building} contains ${BACKUP_MANIFEST_FILE}, that backup is complete: ` +
    `remove the empty ${directory} and rename ${building} to it. Otherwise delete both and ` +
    'run `ff backup` again.'
  );
}

/** The backup is complete but still under its `.partial` name, which must not be deleted. */
class UnrenamedBackupError extends Error {}

/**
 * Claim `<directory>.partial`, where the backup is built, failing if it or the
 * final directory already exists: `mkdir` is the atomic claim, so two backups
 * never share a directory. The default parent is made owner-only even when it
 * already existed with a wider mode; a parent the user chose is left alone.
 */
async function reserveDirectory(
  directory: string,
  building: string,
  isDefault: boolean
): Promise<void> {
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (isDefault) {
    await chmod(parent, 0o700);
  }
  if (await lstatIfExists(directory)) {
    if (await isInterruptedRename(directory, building)) {
      throw new Error(describeInterruptedRename(directory, building));
    }
    throw new Error(describeExistingDestination(directory, isDefault));
  }
  try {
    await mkdir(building, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error(
        `${building} already exists: an earlier backup to ${directory} was interrupted, or ` +
          'one is still running. Delete it once no backup is running, then run `ff backup` again.'
      );
    }
    throw error;
  }
}

/**
 * Rename the finished `.partial` directory to its final name without ever
 * replacing something another process put there. POSIX `rename` replaces an
 * empty directory, so the final name is first claimed with `mkdir` (which
 * fails if it exists) and only that empty directory of ours is replaced;
 * Windows `rename` never replaces a directory.
 */
async function finishBackup(building: string, directory: string, isDefault: boolean) {
  const claim = process.platform !== 'win32';
  if (claim) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      throw isAlreadyExists(error)
        ? new Error(describeExistingDestination(directory, isDefault))
        : error;
    }
  }
  try {
    await rename(building, directory);
  } catch (error) {
    throw claim
      ? await explainClaimedRenameFailure(error, building, directory)
      : await explainRenameFailure(error, directory, isDefault);
  }
}

/** POSIX: the rename onto our claimed directory failed. */
async function explainClaimedRenameFailure(
  error: unknown,
  building: string,
  directory: string
): Promise<unknown> {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'ENOTEMPTY' || code === 'EEXIST') {
    // Someone wrote into the claim: the finished backup stays where it is.
    return new UnrenamedBackupError(
      `The backup is complete in ${building}, but another process wrote into ${directory} ` +
        `before it could be renamed there. Rename ${building} to a new path without ` +
        `${BACKUP_PARTIAL_SUFFIX} to use it.`,
      { cause: error }
    );
  }
  // Only our claim, and only while it is still empty.
  await rmdir(directory).catch(() => undefined);
  return error;
}

/** Windows: `rename` refuses an existing directory, which is the usual cause. */
async function explainRenameFailure(
  error: unknown,
  directory: string,
  isDefault: boolean
): Promise<unknown> {
  return (await lstatIfExists(directory).catch(() => null))
    ? new Error(describeExistingDestination(directory, isDefault), { cause: error })
    : error;
}

const DEFAULT_PARTIAL_NAME = /^backup-\d{8}T\d{9}Z\.partial$/;

/**
 * Unfinished default backups other than this run's, left by an interrupted (or
 * a running) backup, and the empty final directories an interrupted rename left.
 */
async function findLeftoverBackups(parent: string, building: string): Promise<string[]> {
  const partials = (await readdir(parent))
    .filter((name) => DEFAULT_PARTIAL_NAME.test(name))
    .map((name) => join(parent, name))
    .filter((path) => path !== building);
  const emptyClaims: string[] = [];
  for (const partial of partials) {
    const claimed = partial.slice(0, -BACKUP_PARTIAL_SUFFIX.length);
    if (await isInterruptedRename(claimed, partial)) {
      emptyClaims.push(claimed);
    }
  }
  return [...partials, ...emptyClaims].sort();
}

/**
 * A warning when the database is not inside the data directory, where the key
 * and accounts come from. `DATABASE_PATH` and `BASE_DIR` are independent, so
 * this can pair one install's database with another's key, which leaves the
 * database's stored secrets undecryptable after a restore. Never throws: a
 * path whose real location cannot be read is compared as given.
 */
export async function describeMismatchedSources(options: {
  databasePath: string;
  baseDir: string;
}): Promise<string | undefined> {
  const databasePath = resolve(options.databasePath);
  const baseDir = resolve(options.baseDir);
  // SQLite opens the link's target, so compare where each path really lives;
  // when either cannot be resolved, compare both as given.
  const [realDatabasePath, realBaseDir] = await Promise.all([
    realPathAllowingMissing(databasePath),
    realPathAllowingMissing(baseDir),
  ]).catch(() => [databasePath, baseDir]);
  if (isInside(realDatabasePath, realBaseDir)) {
    return undefined;
  }
  const target = realDatabasePath === databasePath ? '' : ` (a link to ${realDatabasePath})`;
  return (
    `The database ${databasePath}${target} is not inside the data directory ${baseDir}, ` +
    'which supplies the encryption key and Codex accounts. Check that they belong ' +
    'to the same installation; set BASE_DIR to change the data directory.'
  );
}

/**
 * Write one self-contained backup directory: a consistent SQLite snapshot,
 * `encryption.key` and `codex-accounts/` when they exist, and a manifest. The
 * snapshot uses SQLite's online backup API, so a running backend is neither
 * stopped nor blocked. Everything is written into `<directory>.partial`, the
 * manifest last, which is renamed to `<directory>` only when complete. A failed
 * backup removes its `.partial` directory; one a killed run leaves behind keeps
 * the suffix, which `readBackup` refuses.
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupResult> {
  const now = (options.now ?? (() => new Date()))();
  const databasePath = resolve(options.databasePath);
  const baseDir = resolve(options.baseDir);
  const isDefault = options.destination === undefined;
  const directory = resolve(
    options.destination ??
      join(getPreMigrationBackupDirectory(databasePath), `backup-${timestampForName(now)}`)
  );
  const building = `${directory}${BACKUP_PARTIAL_SUFFIX}`;

  if (!(await lstatIfExists(databasePath))) {
    throw new Error(`No database found at ${databasePath}; nothing to back up.`);
  }
  if (directory.endsWith(BACKUP_PARTIAL_SUFFIX)) {
    throw new Error(
      `${directory} ends in ${BACKUP_PARTIAL_SUFFIX}, which marks an unfinished backup; ` +
        'choose another path.'
    );
  }
  // Compared by real path, so a link cannot place the backup inside what it copies.
  const accounts = await realPathAllowingMissing(join(baseDir, 'codex-accounts'));
  const realDirectory = await realPathAllowingMissing(directory);
  // Equal counts too: a backup created as an absent codex-accounts/ would become the account
  // source. Case is ignored, because on a case-insensitive disk Codex-Accounts is the same.
  const lowerAccounts = accounts.toLowerCase();
  const lowerDirectory = realDirectory.toLowerCase();
  if (lowerDirectory === lowerAccounts || isInside(lowerDirectory, lowerAccounts)) {
    throw new Error(`${directory} is inside the Codex accounts directory it would copy.`);
  }

  await reserveDirectory(directory, building, isDefault);
  const skipped: string[] = [];
  try {
    const leftovers = isDefault ? await findLeftoverBackups(dirname(directory), building) : [];
    await snapshotSqliteDatabase(databasePath, join(building, BACKUP_DATABASE_FILE));
    const manifest = BackupManifestSchema.parse({
      formatVersion: BACKUP_FORMAT_VERSION,
      applicationVersion: options.applicationVersion,
      createdAt: now.toISOString(),
      sourceDatabasePath: databasePath,
      sourceDataDirectory: baseDir,
      contents: {
        database: true,
        encryptionKey: await copyEncryptionKey(baseDir, building),
        codexAccounts: await copyCodexAccounts(baseDir, building, skipped),
      },
    });
    await writeFile(
      join(building, BACKUP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 }
    );
    await finishBackup(building, directory, isDefault);
    return { directory, manifest, skipped, leftovers };
  } catch (error) {
    if (!(error instanceof UnrenamedBackupError)) {
      await rm(building, { recursive: true, force: true });
    }
    throw error;
  }
}

function describeLeftover(path: string): string {
  if (!path.endsWith(BACKUP_PARTIAL_SUFFIX)) {
    return (
      `Found ${path}, an empty directory a backup left when it was interrupted while ` +
      'finishing; delete it.'
    );
  }
  return (
    `Found ${path}, left by a backup that was interrupted (or is still running). It is not ` +
    `usable under that name. If it contains ${BACKUP_MANIFEST_FILE}, the backup finished but ` +
    `was not renamed: rename it without ${BACKUP_PARTIAL_SUFFIX}. Otherwise delete it once ` +
    'no backup is running.'
  );
}

export const BACKUP_CREDENTIALS_WARNING =
  'This backup contains credentials (the encryption key and Codex account sign-ins). ' +
  'Keep it private and store it only somewhere you trust.';

export function registerBackupCommand(program: Command, applicationVersion: string): void {
  program
    .command('backup')
    .description(
      'Back up the database, encryption key and Codex accounts into one directory (safe while Factory Factory is running)'
    )
    .option('-d, --database-path <path>', 'SQLite database file path (or set DATABASE_PATH env)')
    .option(
      '-o, --output <path>',
      'Backup directory to create, which must not exist (default: a new directory in db-backups/ beside the database)'
    )
    .action(async (options: { databasePath?: string; output?: string }) => {
      try {
        const databasePath = resolveDatabasePath({ databasePath: options.databasePath });
        const baseDir = resolve(getBaseDir());
        console.log(chalk.blue(`Backing up ${databasePath}`));
        console.log(chalk.gray(`  data directory (encryption key, Codex accounts): ${baseDir}`));
        const mismatch = await describeMismatchedSources({ databasePath, baseDir });
        if (mismatch) {
          console.warn(chalk.yellow(`  Warning: ${mismatch}`));
        }
        const result = await createBackup({
          databasePath,
          baseDir,
          applicationVersion,
          destination: options.output,
        });
        const { contents } = result.manifest;
        console.log(chalk.green(`Backup written to ${result.directory}`));
        console.log(chalk.gray(`  database:       included`));
        console.log(
          chalk.gray(`  encryption key: ${contents.encryptionKey ? 'included' : 'not present'}`)
        );
        console.log(
          chalk.gray(`  Codex accounts: ${contents.codexAccounts ? 'included' : 'not present'}`)
        );
        for (const entry of result.skipped) {
          console.warn(chalk.yellow(`  Skipped (not a regular file or directory): ${entry}`));
        }
        for (const leftover of result.leftovers) {
          console.warn(chalk.yellow(`  ${describeLeftover(leftover)}`));
        }
        console.log(chalk.yellow(BACKUP_CREDENTIALS_WARNING));
      } catch (error) {
        console.error(
          chalk.red(`Backup failed: ${error instanceof Error ? error.message : String(error)}`)
        );
        process.exitCode = 1;
      }
    });
}
