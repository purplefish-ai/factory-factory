import { execFile, type ChildProcess, type Serializable } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  applicationUpdateStatusSchema,
  updateSupervisorMessageSchema,
} from '@/shared/application-updates';
import {
  ApplicationUpdateInstaller,
  hasOtherApplicationServers,
} from './application-update-installer';
import { getUpdateStatePath, persistApplicationUpdateState } from './application-update-recovery';
import { ApplicationUpdateSupervisor } from './application-update-supervisor';
import { runServeSession } from './serve-session';

const exec = promisify(execFile);
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
  const publish = (message: Serializable) => {
    if (backend?.connected) {
      backend.send(message, () => {
        /* A disconnected backend gets state at its next handshake. */
      });
    }
  };
  const supervisor = new ApplicationUpdateSupervisor({
    automaticUpdate,
    prepare: (version, signal) => installer.prepare(version, signal),
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
        recoveryPath: supervisor.recoveryPath ?? preparationRecoveryPath,
        databaseBackup: snapshotExists ? backupPath : undefined,
      });
    },
    isBackendStopped: () => !!backend && (backend.exitCode !== null || backend.signalCode !== null),
    stopBackend: async () => {
      if (!backend || backend.exitCode !== null || backend.signalCode !== null) {
        throw new Error('The backend exited before it could prepare the update.');
      }
      expectedExit = true;
      const child = backend;
      gracefulExit = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          child.kill('SIGKILL');
        }, 120_000);
        const exited = (code: number | null) => {
          clearTimeout(deadline);
          child.off('error', failed);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Backend shutdown failed (${code}). No update was activated.`));
          }
        };
        const failed = (error: Error) => {
          clearTimeout(deadline);
          child.off('exit', exited);
          reject(error);
        };
        child.once('exit', exited);
        child.once('error', failed);
        if (!child.kill('SIGTERM')) {
          clearTimeout(deadline);
          child.off('exit', exited);
          child.off('error', failed);
          reject(new Error('Could not request graceful backend shutdown.'));
        }
      });
      await gracefulExit;
    },
    backupDatabase: async () => {
      if (!supervisor.recoveryPath) {
        throw new Error('The prepared update has no recovery location.');
      }
      backupPath = join(dirname(supervisor.recoveryPath), 'database-backup');
      const snapshot = backupPath;
      const database = new Database(options.databasePath, { readonly: true, fileMustExist: true });
      try {
        await database.backup(snapshot);
        await chmod(snapshot, 0o600);
        snapshotExists = true;
      } finally {
        database.close();
      }
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
      await exec(
        process.execPath,
        [
          join(options.projectRoot, 'dist/src/cli/index.js'),
          'db:migrate',
          '--database-path',
          options.databasePath,
        ],
        {
          env: options.env,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        }
      );
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
          await supervisor.backendReady();
          if (snapshotExists && backupPath) {
            await rm(backupPath, { force: true });
            snapshotExists = false;
          }
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
