import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import treeKill from 'tree-kill';
import { toError } from '@/backend/lib/error-utils';
import type { createLogger } from '@/backend/services/logger.service';
import type { RunScriptStatus } from '@/shared/core';
import { FactoryConfigService } from './factory-config.service';

type Logger = ReturnType<typeof createLogger>;

export function shouldRejectStopWithoutProcess(
  status: RunScriptStatus,
  childProcess: ChildProcess | undefined,
  pid: number | null
): boolean {
  if (childProcess || pid) {
    return false;
  }
  return status !== 'STARTING';
}

export async function runCleanupScriptProcess(
  workspaceId: string,
  workspace: {
    runScriptCleanupCommand: string;
    worktreePath: string;
    runScriptPort: number | null;
  },
  logger: Logger
): Promise<void> {
  logger.info('Running cleanup script before stopping', {
    workspaceId,
    cleanupCommand: workspace.runScriptCleanupCommand,
  });

  try {
    const cleanupCommand = workspace.runScriptPort
      ? FactoryConfigService.substitutePort(
          workspace.runScriptCleanupCommand,
          workspace.runScriptPort
        )
      : workspace.runScriptCleanupCommand;

    const cleanupProcess = spawn('bash', ['-c', cleanupCommand], {
      cwd: workspace.worktreePath,
      detached: false,
      stdio: 'ignore',
    });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('Cleanup script timed out, proceeding anyway', { workspaceId });
        cleanupProcess.kill('SIGTERM');
        resolve();
      }, 5000);

      cleanupProcess.on('exit', (code) => {
        clearTimeout(timeout);
        logger.info('Cleanup script completed', { workspaceId, exitCode: code });
        resolve();
      });

      cleanupProcess.on('error', (error) => {
        clearTimeout(timeout);
        logger.error('Cleanup script error', error, { workspaceId });
        resolve();
      });
    });
  } catch (error) {
    logger.error('Failed to run cleanup script', toError(error), { workspaceId });
  }
}

export async function treeKillProcess(
  targetPid: number,
  signal: NodeJS.Signals,
  onError: (message: string, code?: string) => void,
  onComplete: () => void
): Promise<void> {
  await new Promise<void>((resolve) => {
    treeKill(targetPid, signal, (err) => {
      if (err) {
        onError(err.message, (err as NodeJS.ErrnoException).code);
      }
      onComplete();
      resolve();
    });
  });
}

export async function waitForChildProcessExit(params: {
  workspaceId: string;
  childProcess: ChildProcess | undefined;
  pid: number | null;
  logger: Logger;
}): Promise<void> {
  const { workspaceId, childProcess, pid, logger } = params;
  if (!childProcess) {
    return;
  }

  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }

  if (typeof childProcess.once !== 'function' || typeof childProcess.off !== 'function') {
    return;
  }

  const waitPid = childProcess.pid ?? pid ?? undefined;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      logger.warn('Timed out waiting for run script process exit after stop', {
        workspaceId,
        pid: waitPid,
      });
      resolve();
    }, 10_000);

    const cleanup = () => {
      clearTimeout(timeout);
      childProcess.off('exit', onExit);
      childProcess.off('error', onError);
    };

    const onExit = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      logger.warn('Run script process emitted error while waiting for exit', {
        workspaceId,
        pid: waitPid,
        error,
      });
      resolve();
    };

    childProcess.once('exit', onExit);
    childProcess.once('error', onError);

    if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
      cleanup();
      resolve();
    }
  });
}
