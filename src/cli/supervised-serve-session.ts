import { execFile, type ChildProcess, type Serializable } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chmod, copyFile, link, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { z } from 'zod';
import { snapshotSqliteDatabase } from '@/backend/lib/sqlite-snapshot';
import {
  ALLOW_MIGRATION_WITHOUT_BACKUP_ENV,
  getPreMigrationBackupDirectory,
  listPreMigrationBackups,
  preMigrationBackupName,
  prunePreMigrationBackupsKeeping,
} from '@/backend/migrate-with-backup';
import {
  applicationUpdateStatusSchema,
  updateSupervisorMessageSchema,
} from '@/shared/application-updates';
import {
  ApplicationUpdateInstaller,
  hasOtherApplicationServers,
} from './application-update-installer';
import { getUpdateStatePath, persistApplicationUpdateState } from './application-update-recovery';
import { stopBackendForUpdate } from './application-update-shutdown';
import { ApplicationUpdateSupervisor } from './application-update-supervisor';
import { runServeSession } from './serve-session';

const savedStateSchema = z.object({ status: applicationUpdateStatusSchema });
type ServeOptions = Parameters<typeof runServeSession>[0];

async function readPreviousStatus(
  statePath: string
): Promise<import('@/shared/application-updates').ApplicationUpdateStatus> {
  try {
    const saved = savedStateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')));
    if (saved.status.phase === 'failed') {
      return saved.status;
    }
    if (saved.status.phase !== 'idle') {
      return {
        phase: 'failed',
        targetVersion: saved.status.targetVersion,
        error: `The previous update was interrupted. Check ${statePath} before retrying.`,
      };
    }
  } catch {
    /* First launch has no journal. */
  }
  return { phase: 'idle' };
}

/**
 * A failed child's output with its last line, the failure itself, first: an
 * earlier warning would otherwise fill the start of the message the update
 * banner shows.
 */
function describeChildFailure(output: string, fallback: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.pop();
  return last ? [last, ...lines].join('\n') : fallback;
}

/**
 * Run the new package's `db:migrate` and return what it wrote to standard
 * error. A failure is logged in full and carries that output, failure first,
 * rather than the command line Node puts first.
 */
function runMigrationChild(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        const output = stripVTControlCharacters(String(stderr)).trim();
        if (!error) {
          resolve(output);
          return;
        }
        const reason = describeChildFailure(output, error.message);
        console.error(chalk.red(`  [update] db:migrate failed: ${reason}`));
        reject(new Error(`The database migration failed: ${reason}`, { cause: error }));
      }
    );
  });
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/** Hard-link `source` into `directory` under the first unused name; a link never replaces a file. */
async function linkUnderUnusedName(
  source: string,
  directory: string,
  name: (attempt: number) => string
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const target = join(directory, name(attempt));
    try {
      await link(source, target);
      return target;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
  }
  throw new Error(`No unused name in ${directory}`);
}

/**
 * The update's `db:migrate` left no new backup in `db-backups/`, so the
 * supervisor's snapshot is the only copy of the database from before the
 * update. Keep it with a hard link, which needs no disk space (a full disk is
 * the likeliest reason that backup failed) and is instant: into `db-backups/`
 * under the pre-migration name retention counts, else beside the package. When
 * no link can be made, the snapshot stays in the stage. Never throws: the new
 * backend is already running. Returns the snapshot when the stage must keep it.
 */
async function keepPreUpdateSnapshot(
  snapshot: string,
  databasePath: string,
  projectRoot: string
): Promise<string | undefined> {
  const now = Date.now();
  const backupDirectory = getPreMigrationBackupDirectory(databasePath);
  const failures: string[] = [];
  let kept: string | undefined;
  try {
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory's mode alone; others must not unlink the only copy.
    await chmod(backupDirectory, 0o700);
    kept = await linkUnderUnusedName(snapshot, backupDirectory, (attempt) =>
      preMigrationBackupName(databasePath, new Date(now + attempt))
    );
  } catch (error) {
    failures.push(`${backupDirectory} (${String(error)})`);
  }
  if (kept && dirname(kept) === backupDirectory) {
    // The same retention as the migration's own backups; the link just made always stays.
    await prunePreMigrationBackupsKeeping(databasePath, backupDirectory, basename(kept)).catch(
      (error: unknown) => {
        console.warn(
          chalk.yellow(`  [update] Could not prune old database backups: ${String(error)}`)
        );
      }
    );
  }
  if (!kept) {
    const stamp = new Date(now).toISOString().replace(/[-:.]/g, '');
    try {
      kept = await linkUnderUnusedName(
        snapshot,
        dirname(projectRoot),
        (attempt) => `.factory-factory-database-backup-${stamp}${attempt ? `-${attempt}` : ''}.db`
      );
    } catch (error) {
      failures.push(`${dirname(projectRoot)} (${String(error)})`);
    }
  }
  const linkFailures =
    failures.length > 0 ? ` Could not link it into ${failures.join(' or ')}.` : '';
  console.error(
    chalk.red(
      `  [update] The database migration made no lasting backup: no new pre-migration ` +
        `backup appeared in ${backupDirectory}. The database as it was before the update ` +
        `is kept at ${kept ?? snapshot}.${linkFailures}`
    )
  );
  return kept ? undefined : snapshot;
}

/** Keeps the CLI alive while its production backend is gracefully replaced. */
export async function runSupervisedServeSession(options: ServeOptions & { databasePath: string }) {
  if (options.dev) {
    return runServeSession(options);
  }
  let backend: ChildProcess | undefined;
  let preparationRecoveryPath: string | undefined;
  const installer = new ApplicationUpdateInstaller({
    packageRoot: options.projectRoot,
    env: options.env,
    ownedProcessIds: () => (backend?.pid ? [backend.pid] : []),
    onStage: async (recoveryPath) => {
      preparationRecoveryPath = recoveryPath;
      await persistApplicationUpdateState({
        packageRoot: options.projectRoot,
        databasePath: options.databasePath,
        status: supervisor.status,
        recoveryPath,
      });
    },
  });
  const supportedInstallation = await installer.isSupported();
  const marker = join(dirname(options.projectRoot), `.factory-factory-running-${process.pid}`);
  if (supportedInstallation) {
    await mkdir(marker, { recursive: true });
  }
  const automaticUpdate =
    supportedInstallation && !(await hasOtherApplicationServers(options.projectRoot));
  const statePath = getUpdateStatePath(options.projectRoot);
  let backupPath: string | undefined;
  let backendExited: Promise<void> = Promise.resolve();
  let firstReady = true;
  let expectedExit = false;
  let gracefulExit: Promise<void> | undefined;
  let snapshotExists = false;
  /** Set unless the update's `db:migrate` was seen to leave a new backup in `db-backups/`. */
  let snapshotIsOnlyBackup = false;
  /** A snapshot no link could keep, which the stage's disposal leaves in place. */
  let snapshotLeftInStage: string | undefined;
  const publish = (message: Serializable) => {
    if (backend?.connected) {
      backend.send(message, () => {
        /* A disconnected backend gets state at its next handshake. */
      });
    }
  };
  const supervisor = new ApplicationUpdateSupervisor({
    automaticUpdate,
    prepare: async (version, signal) => {
      const prepared = await installer.prepare(version, signal);
      return { ...prepared, dispose: () => prepared.dispose({ keep: snapshotLeftInStage }) };
    },
    publish: (status) => publish({ type: 'update-status', status }),
    persist: async (status) => {
      // Unsupported source/desktop launches do not write beside their package.
      if (!automaticUpdate) {
        return;
      }
      await persistApplicationUpdateState({
        packageRoot: options.projectRoot,
        databasePath: options.databasePath,
        status,
        recoveryPath:
          supervisor.recoveryPath ??
          (status.phase === 'preparing' ? preparationRecoveryPath : undefined),
        databaseBackup: snapshotExists && supervisor.recoveryPath ? backupPath : undefined,
      });
    },
    isBackendStopped: () => !!backend && (backend.exitCode !== null || backend.signalCode !== null),
    stopBackend: async () => {
      if (!backend || backend.exitCode !== null || backend.signalCode !== null) {
        throw new Error('The backend exited before it could prepare the update.');
      }
      expectedExit = true;
      gracefulExit = stopBackendForUpdate(backend);
      await gracefulExit;
    },
    backupDatabase: async () => {
      if (!supervisor.recoveryPath) {
        throw new Error('The prepared update has no recovery location.');
      }
      backupPath = join(dirname(supervisor.recoveryPath), 'database-backup');
      const snapshot = backupPath;
      await snapshotSqliteDatabase(options.databasePath, snapshot);
      snapshotExists = true;
      return async () => {
        await copyFile(snapshot, options.databasePath);
        // A failed migration can leave a journal which must not be replayed over the snapshot.
        await Promise.all(
          ['-wal', '-shm', '-journal'].map((suffix) =>
            rm(`${options.databasePath}${suffix}`, { force: true })
          )
        );
      };
    },
    migrate: async () => {
      // Fails safe: only a new backup file seen on disk lets the snapshot go.
      snapshotIsOnlyBackup = true;
      const before = await listPreMigrationBackups(options.databasePath).catch(() => undefined);
      const output = await runMigrationChild(
        [
          join(options.projectRoot, 'dist/src/cli/index.js'),
          'db:migrate',
          '--database-path',
          options.databasePath,
        ],
        // The supervisor's own snapshot, taken just before, is this update's backup.
        { ...options.env, [ALLOW_MIGRATION_WITHOUT_BACKUP_ENV]: '1' }
      );
      if (output) {
        console.warn(chalk.yellow(`  [update] db:migrate: ${output}`));
      }
      const after = await listPreMigrationBackups(options.databasePath).catch(() => []);
      const childMadeBackup = !!before && after.some((name) => !before.includes(name));
      snapshotIsOnlyBackup = !childMadeBackup;
    },
  });
  if (automaticUpdate) {
    supervisor.status = await readPreviousStatus(statePath);
  }
  const abort = () => supervisor.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    do {
      expectedExit = false;
      let ready!: () => void;
      let failedReady!: (error: Error) => void;
      const backendStarted = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failedReady = reject;
      });
      void backendStarted.catch(() => undefined);
      let readyTimeout: ReturnType<typeof setTimeout> | undefined;
      const cancelled = () => failedReady(new Error('Startup cancelled.'));
      options.signal.addEventListener('abort', cancelled, { once: true });
      let childMarker: string | undefined;
      let messageOperation: Promise<void> | undefined;
      let fatalUpdateError: unknown;
      const onMessage = (raw: unknown) => {
        const message = updateSupervisorMessageSchema.safeParse(raw);
        if (!message.success) {
          return;
        }
        try {
          switch (message.data.type) {
            case 'update-backend-ready':
              ready();
              break;
            case 'update-hello':
              publish({
                type: 'update-capabilities',
                automaticUpdate,
                manualCommand: supportedInstallation
                  ? 'Close other Factory Factory servers, or run npm install -g factory-factory@latest, then restart Factory Factory.'
                  : 'Update Factory Factory using its original installation method, then restart it',
              });
              publish({ type: 'update-status', status: supervisor.status });
              break;
            case 'update-request':
              supervisor.request(message.data.version);
              break;
            case 'update-cancel':
              supervisor.cancel();
              publish({ type: 'update-status', status: supervisor.status });
              break;
            case 'update-ready':
              messageOperation = supervisor.ready().catch((error) => {
                fatalUpdateError = error;
              });
              break;
          }
        } catch (error) {
          publish({ type: 'update-status', status: { phase: 'failed', error: String(error) } });
        }
      };
      await runServeSession({
        ...options,
        onBackend: (child) => {
          backend = child;
          backend.on('message', onMessage);
          if (supportedInstallation && child.pid) {
            childMarker = join(
              dirname(options.projectRoot),
              `.factory-factory-running-${child.pid}`
            );
            mkdirSync(childMarker, { recursive: true });
          }
          backendExited = new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            child.once('error', () => {
              if (!child.pid) {
                resolve();
              }
            });
          });
          readyTimeout = setTimeout(
            () =>
              failedReady(
                new Error('Backend startup timed out; update recovery files have been retained.')
              ),
            120_000
          );
        },
        isExpectedBackendExit: () => expectedExit,
        onReady: async () => {
          await backendStarted;
          clearTimeout(readyTimeout);
          const keepSnapshot = snapshotIsOnlyBackup;
          snapshotIsOnlyBackup = false;
          // Only for a completed update (a failed one restored the database from the
          // snapshot), and before backendReady deletes the stage holding it.
          if (
            keepSnapshot &&
            supervisor.status.phase === 'restarting' &&
            snapshotExists &&
            backupPath
          ) {
            snapshotLeftInStage = await keepPreUpdateSnapshot(
              backupPath,
              options.databasePath,
              options.projectRoot
            );
          }
          await supervisor.backendReady();
          if (snapshotExists && backupPath && !snapshotLeftInStage) {
            await rm(backupPath, { force: true });
          }
          snapshotExists = false;
          snapshotLeftInStage = undefined;
          if (firstReady) {
            firstReady = false;
            await options.onReady();
          }
        },
      })
        .catch(async (error) => {
          await backendExited;
          if (supervisor.restartRequired && supervisor.status.phase === 'restarting') {
            await supervisor.backendFailed(error);
          } else {
            throw error;
          }
        })
        .finally(() => {
          clearTimeout(readyTimeout);
          options.signal.removeEventListener('abort', cancelled);
          backend?.off('message', onMessage);
          if (childMarker) {
            rmSync(childMarker, { recursive: true, force: true });
          }
        });
      await messageOperation;
      await supervisor.settled();
      if (fatalUpdateError) {
        throw fatalUpdateError;
      }
    } while (!options.signal.aborted && supervisor.restartRequired);
  } finally {
    options.signal.removeEventListener('abort', abort);
    supervisor.abort();
    await gracefulExit?.catch(() => undefined);
    if (supportedInstallation) {
      await rm(marker, { recursive: true, force: true });
    }
  }
}
