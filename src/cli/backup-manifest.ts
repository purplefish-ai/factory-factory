import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Names inside a backup directory. `ff restore` reads the same layout. */
export const BACKUP_MANIFEST_FILE = 'manifest.json';
export const BACKUP_DATABASE_FILE = 'database.db';
export const BACKUP_ENCRYPTION_KEY_FILE = 'encryption.key';
export const BACKUP_CODEX_ACCOUNTS_DIRECTORY = 'codex-accounts';

/** Bump when the layout or the manifest changes in a way an older reader cannot restore. */
export const BACKUP_FORMAT_VERSION = 1;

export const BackupManifestSchema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    applicationVersion: z.string().min(1),
    createdAt: z.iso.datetime(),
    /** Absolute path of the database that was backed up; informational. */
    sourceDatabasePath: z.string().min(1),
    /** Absolute data directory the key and accounts came from; informational. */
    sourceDataDirectory: z.string().min(1),
    contents: z
      .object({
        /** Always present: `database.db`, a consistent SQLite snapshot. */
        database: z.literal(true),
        encryptionKey: z.boolean(),
        codexAccounts: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

/** A backup that passed {@link readBackup}; every listed path exists. */
export interface ValidatedBackup {
  directory: string;
  manifest: BackupManifest;
  databasePath: string;
  /** Present only when `manifest.contents.encryptionKey`. */
  encryptionKeyPath?: string;
  /** Present only when `manifest.contents.codexAccounts`. */
  codexAccountsPath?: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function requireEntry(
  path: string,
  kind: 'file' | 'directory',
  label: string
): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`The backup is incomplete: ${label} is missing.`);
    }
    throw error;
  }
  if (!(kind === 'file' ? stats.isFile() : stats.isDirectory())) {
    throw new Error(`The backup is invalid: ${label} is not a ${kind}.`);
  }
}

async function readManifestText(directory: string): Promise<string> {
  const path = join(directory, BACKUP_MANIFEST_FILE);
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `${directory} is not a Factory Factory backup: ${BACKUP_MANIFEST_FILE} is missing.`
      );
    }
    throw error;
  }
  // A link could lead outside the directory, which would make the backup not self-contained.
  if (!stats.isFile()) {
    throw new Error(`${BACKUP_MANIFEST_FILE} in ${directory} is not a regular file.`);
  }
  return await readFile(path, 'utf8');
}

function parseManifest(text: string, directory: string): BackupManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${BACKUP_MANIFEST_FILE} in ${directory} is not valid JSON.`);
  }
  const parsed = BackupManifestSchema.safeParse(json);
  if (parsed.success) {
    return parsed.data;
  }
  const found = z.object({ formatVersion: z.unknown() }).safeParse(json);
  throw new Error(
    `The manifest in ${directory} is not one this version understands ` +
      `(format version ${found.success ? JSON.stringify(found.data.formatVersion) : 'unknown'}, ` +
      `expected ${BACKUP_FORMAT_VERSION}): ${z.prettifyError(parsed.error)}`
  );
}

/**
 * Read and validate a backup directory made by `ff backup`. Throws a readable
 * error for a missing manifest, a format this version does not understand, or
 * a file the manifest lists but the directory lacks. A restore opens a backup
 * only through this function.
 */
export async function readBackup(directory: string): Promise<ValidatedBackup> {
  const manifest = parseManifest(await readManifestText(directory), directory);
  const databasePath = join(directory, BACKUP_DATABASE_FILE);
  await requireEntry(databasePath, 'file', BACKUP_DATABASE_FILE);
  const backup: ValidatedBackup = { directory, manifest, databasePath };
  if (manifest.contents.encryptionKey) {
    backup.encryptionKeyPath = join(directory, BACKUP_ENCRYPTION_KEY_FILE);
    await requireEntry(backup.encryptionKeyPath, 'file', BACKUP_ENCRYPTION_KEY_FILE);
  }
  if (manifest.contents.codexAccounts) {
    backup.codexAccountsPath = join(directory, BACKUP_CODEX_ACCOUNTS_DIRECTORY);
    await requireEntry(backup.codexAccountsPath, 'directory', BACKUP_CODEX_ACCOUNTS_DIRECTORY);
  }
  return backup;
}
