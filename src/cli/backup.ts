import type { Stats } from 'node:fs';
import { copyFile, chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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
  type BackupManifest,
  BackupManifestSchema,
} from './backup-manifest';
import { getBaseDir, resolveDatabasePath } from './database-path';

export interface CreateBackupOptions {
  databasePath: string;
  /** The data directory holding `encryption.key` and `codex-accounts/`. */
  baseDir: string;
  applicationVersion: string;
  /** The backup directory to create; it must not exist. Defaults beside `db-backups/` snapshots. */
  destination?: string;
  now?: () => Date;
}

export interface BackupResult {
  directory: string;
  manifest: BackupManifest;
  /** Entries under `codex-accounts/` that are not regular files or directories and were not copied. */
  skipped: string[];
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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

async function copyEncryptionKey(baseDir: string, stagingDir: string): Promise<boolean> {
  const source = join(baseDir, 'encryption.key');
  const stats = await lstatIfExists(source);
  if (!stats) {
    return false;
  }
  if (!stats.isFile()) {
    throw new Error(`${source} is not a regular file; refusing to back it up.`);
  }
  await copySecretFile(source, join(stagingDir, BACKUP_ENCRYPTION_KEY_FILE), stats.mode & 0o777);
  return true;
}

async function copyCodexAccounts(
  baseDir: string,
  stagingDir: string,
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
  await copyTree(source, join(stagingDir, BACKUP_CODEX_ACCOUNTS_DIRECTORY), skipped);
  return true;
}

/**
 * Write one self-contained backup directory: a consistent SQLite snapshot,
 * `encryption.key` and `codex-accounts/` when they exist, and a manifest. The
 * snapshot uses SQLite's online backup API, so a running backend is neither
 * stopped nor blocked. The directory is built beside its final name and renamed
 * into place, so a failed backup never leaves something that looks complete.
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupResult> {
  const now = (options.now ?? (() => new Date()))();
  const databasePath = resolve(options.databasePath);
  const baseDir = resolve(options.baseDir);
  const directory = resolve(
    options.destination ??
      join(getPreMigrationBackupDirectory(databasePath), `backup-${timestampForName(now)}`)
  );

  if (!(await lstatIfExists(databasePath))) {
    throw new Error(`No database found at ${databasePath}; nothing to back up.`);
  }
  if (await lstatIfExists(directory)) {
    throw new Error(`${directory} already exists; choose a path that does not exist.`);
  }

  const parent = dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stagingDir = join(parent, `.${basename(directory)}.partial-${process.pid}`);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { mode: 0o700 });
  const skipped: string[] = [];
  try {
    await snapshotSqliteDatabase(databasePath, join(stagingDir, BACKUP_DATABASE_FILE));
    const manifest = BackupManifestSchema.parse({
      formatVersion: BACKUP_FORMAT_VERSION,
      applicationVersion: options.applicationVersion,
      createdAt: now.toISOString(),
      sourceDatabaseFile: basename(databasePath),
      contents: {
        database: true,
        encryptionKey: await copyEncryptionKey(baseDir, stagingDir),
        codexAccounts: await copyCodexAccounts(baseDir, stagingDir, skipped),
      },
    });
    // Written last: a directory without a manifest is never a usable backup.
    await writeFile(
      join(stagingDir, BACKUP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 }
    );
    await rename(stagingDir, directory);
    return { directory, manifest, skipped };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
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
        console.log(chalk.blue(`Backing up ${databasePath}...`));
        const result = await createBackup({
          databasePath,
          baseDir: getBaseDir(),
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
        console.log(chalk.yellow(BACKUP_CREDENTIALS_WARNING));
      } catch (error) {
        console.error(
          chalk.red(`Backup failed: ${error instanceof Error ? error.message : String(error)}`)
        );
        process.exitCode = 1;
      }
    });
}
