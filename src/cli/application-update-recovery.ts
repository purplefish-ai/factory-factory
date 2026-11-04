import { randomUUID } from 'node:crypto';
import { copyFile, lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  applicationUpdateStatusSchema,
  type ApplicationUpdateStatus,
  releaseVersionSchema,
} from '@/shared/application-updates';

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((path) => isAbsolute(path) && resolve(path) === path);
const journalSchema = z.object({
  packageRoot: absolutePathSchema,
  databasePath: absolutePathSchema,
  pid: z.number().int().positive().max(2_147_483_647),
  status: applicationUpdateStatusSchema,
  recoveryPath: absolutePathSchema.optional(),
  databaseBackup: absolutePathSchema.optional(),
});
const packageSchema = z.object({
  name: z.literal('factory-factory'),
  version: releaseVersionSchema,
});
type Journal = z.infer<typeof journalSchema>;
interface StateOptions {
  packageRoot: string;
  databasePath: string;
  status: ApplicationUpdateStatus;
  recoveryPath?: string;
  databaseBackup?: string;
}

export function getUpdateStatePath(packageRoot: string): string {
  return join(dirname(resolve(packageRoot)), '.factory-factory-update-state.json');
}

function validatePaths(state: Journal, packageRoot: string, databasePath: string) {
  if (state.packageRoot !== resolve(packageRoot) || state.databasePath !== resolve(databasePath)) {
    throw new Error(
      'Update journal installation or database path does not match this launch. Recover the recorded installation manually before starting.'
    );
  }
  const stage = state.recoveryPath ? dirname(state.recoveryPath) : undefined;
  if (
    stage &&
    (basename(state.recoveryPath ?? '') !== 'previous' ||
      dirname(stage) !== dirname(state.packageRoot) ||
      !/^\.factory-factory-update-(?!lock$)[A-Za-z0-9_-]+$/.test(basename(stage)))
  ) {
    throw new Error('Update journal recovery path is not a safe installation staging directory.');
  }
  if (
    state.databaseBackup &&
    state.databaseBackup !== `${getUpdateStatePath(state.packageRoot)}.database-backup` &&
    (!stage || state.databaseBackup !== join(stage, 'database-backup'))
  ) {
    throw new Error('Update journal database backup path is not a recorded staging snapshot.');
  }
  return stage;
}

/** An atomic, synced checkpoint outside the package being replaced. */
export async function persistApplicationUpdateState(options: StateOptions): Promise<void> {
  const state = journalSchema.parse({
    ...options,
    packageRoot: resolve(options.packageRoot),
    databasePath: resolve(options.databasePath),
    pid: process.pid,
  });
  validatePaths(state, options.packageRoot, options.databasePath);
  const path = getUpdateStatePath(options.packageRoot);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function errorCode(error: unknown) {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}
function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}
async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
async function refuseLiveServers(packageRoot: string) {
  const entries = await readdir(dirname(resolve(packageRoot)));
  for (const name of entries) {
    const match = /^\.factory-factory-running-([1-9]\d*)$/.exec(name);
    if (!match?.[1]) {
      continue;
    }
    const pid = Number(match[1]);
    if (
      pid !== process.pid &&
      Number.isSafeInteger(pid) &&
      pid <= 2_147_483_647 &&
      processIsAlive(pid)
    ) {
      throw new Error(
        `Another Factory Factory server is still running (PID ${pid}). Stop it before attempting update recovery or migrations.`
      );
    }
  }
}
async function requireDirectory(path: string) {
  const stats = await entry(path);
  if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
    throw new Error(`Unsafe symbolic or non-directory update recovery path: ${path}`);
  }
  return stats;
}
async function readPackage(path: string) {
  return packageSchema.parse(JSON.parse(await readFile(join(path, 'package.json'), 'utf8')));
}
async function restoreDatabase(state: Journal) {
  const backup = state.databaseBackup;
  const snapshot = backup ? await entry(backup) : undefined;
  if (!(backup && snapshot?.isFile()) || snapshot.isSymbolicLink()) {
    throw new Error(
      'The recorded database backup snapshot is missing or symbolic. Retain the previous installation and recover manually.'
    );
  }
  const database = await entry(state.databasePath);
  if (database && (!database.isFile() || database.isSymbolicLink())) {
    throw new Error('The database recovery path is symbolic or is not a regular file.');
  }
  await copyFile(backup, state.databasePath);
  await Promise.all(
    ['-wal', '-shm', '-journal'].map((suffix) =>
      rm(`${state.databasePath}${suffix}`, { force: true })
    )
  );
}

async function readJournal(packageRoot: string): Promise<Journal | undefined> {
  const path = getUpdateStatePath(packageRoot);
  const file = await entry(path);
  if (!file) {
    return undefined;
  }
  if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024) {
    throw new Error(
      `Unsafe update recovery journal at ${path}. Inspect it before starting migrations.`
    );
  }
  try {
    return journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new Error(
      `Invalid update recovery journal at ${path}. Recover the installation manually before starting migrations.`
    );
  }
}

async function findPreviousPackage(state: Journal, stage: string | undefined) {
  if (stage) {
    await requireDirectory(stage);
  }
  if (state.recoveryPath && (await requireDirectory(state.recoveryPath))) {
    return state.recoveryPath;
  }
  return undefined;
}

async function inspectActivePackage(state: Journal, previousPath: string | undefined) {
  const current = await requireDirectory(state.packageRoot);
  const currentPackage = current ? await readPackage(state.packageRoot) : undefined;
  if (
    !previousPath &&
    state.status.phase === 'restarting' &&
    currentPackage?.version === state.status.targetVersion
  ) {
    throw new Error(
      'The interrupted replacement is active but the previous package is missing. Retain the database snapshot and recover the installation manually.'
    );
  }
  return current !== undefined;
}

async function rollbackPackage(state: Journal, previousPath: string, currentExists: boolean) {
  await readPackage(previousPath);
  if (state.status.phase === 'waiting' || state.status.phase === 'preparing') {
    throw new Error(
      'The update journal indicates preparation but a prior package exists. Retain recovery files and inspect the interrupted activation manually.'
    );
  }
  const displaced = join(dirname(previousPath), 'failed-replacement');
  if (currentExists && (await entry(displaced))) {
    throw new Error(
      `A failed replacement already exists at ${displaced}. Recovery files have been retained for manual inspection.`
    );
  }
  await restoreDatabase(state);
  if (currentExists) {
    await rename(state.packageRoot, displaced);
  }
  try {
    await rename(previousPath, state.packageRoot);
  } catch (error) {
    if (currentExists) {
      await rename(displaced, state.packageRoot);
    }
    throw error;
  }
}

async function finishRecovery(state: Journal, stage: string | undefined, rolledBack: boolean) {
  await persistApplicationUpdateState({
    packageRoot: state.packageRoot,
    databasePath: state.databasePath,
    status: {
      phase: 'failed',
      targetVersion: state.status.targetVersion,
      error: `The previous update was interrupted and recovered.${rolledBack ? ' The previous installation and database were restored.' : ' The running installation was not replaced.'}${rolledBack && stage ? ` Recovery files remain at ${stage}.` : ''}`,
    },
  });
  // Never delete an unrecorded stage or a package that may be the only usable copy.
  if (stage && !rolledBack) {
    await rm(stage, { recursive: true, force: true });
  }
  if (stage) {
    await rm(join(dirname(state.packageRoot), '.factory-factory-update-lock'), {
      recursive: true,
      force: true,
    });
  }
}

/** Returns true when the caller must relaunch the restored CLI before migrations. */
export async function recoverInterruptedApplicationUpdate(
  packageRoot: string,
  databasePath: string
): Promise<boolean> {
  const state = await readJournal(packageRoot);
  if (!state || state.status.phase === 'idle') {
    return false;
  }
  if (state.status.phase === 'failed' && !state.recoveryPath) {
    return false;
  }
  await refuseLiveServers(packageRoot);
  const stage = validatePaths(state, packageRoot, databasePath);
  const previousPath = await findPreviousPackage(state, stage);
  // A failed journal with no prior package is already recovered or failed before activation.
  if (state.status.phase === 'failed' && !previousPath) {
    return false;
  }
  if (processIsAlive(state.pid)) {
    throw new Error(
      `The recorded update owner is still running (PID ${state.pid}); recovery is refused.`
    );
  }
  const currentExists = await inspectActivePackage(state, previousPath);
  const rolledBack = previousPath !== undefined;
  if (previousPath) {
    await rollbackPackage(state, previousPath, currentExists);
  } else if (state.status.phase === 'restarting' && state.databaseBackup) {
    // Crash after the snapshot but before the package was moved.
    await restoreDatabase(state);
  }
  if (!(currentExists || rolledBack)) {
    throw new Error(
      'The active installation is missing and no previous package can be restored. Retain the update recovery files and reinstall manually.'
    );
  }
  await finishRecovery(state, stage, rolledBack);
  return rolledBack;
}
