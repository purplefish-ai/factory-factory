import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getNodeExecPath } from '@/backend/lib/node-runtime';
import { createLogger } from '@/backend/services/logger.service';
import { normalizeUnknownError } from './acp-stream-normalizer';

const logger = createLogger('acp-runtime-manager');
const requireFromCurrentModule = createRequire(import.meta.url);

export type SpawnCommand = {
  command: string;
  args: string[];
  commandLabel: string;
};

export function validateAcpWorkingDir(workingDir: string | null | undefined): void {
  if (typeof workingDir !== 'string' || workingDir.trim().length === 0) {
    throw new Error('ACP working directory is required before spawning adapter process');
  }

  // A missing cwd makes spawn report ENOENT against the executable, even when Node exists.
  const stats = statSync(workingDir, { throwIfNoEntry: false });
  if (!stats) {
    throw new Error(
      `ACP working directory does not exist: "${workingDir}". Restore the workspace worktree before starting the session.`
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`ACP working directory is not a directory: "${workingDir}"`);
  }
}

export function createAcpSpawnError(commandLabel: string, error: unknown): Error {
  const normalized = normalizeUnknownError(error);
  return new Error(`Failed to spawn ACP adapter "${commandLabel}": ${normalized.message}`);
}

/**
 * Resolves the full path to an ACP adapter binary by finding its package
 * directory and reading the bin field from package.json.
 * Falls back to the bare command name (relies on PATH).
 */
export function resolveAcpBinary(packageName: string, binaryName: string): string {
  try {
    const packageJsonPath = requireFromCurrentModule.resolve(`${packageName}/package.json`);
    const packageDir = dirname(packageJsonPath);
    const pkg = requireFromCurrentModule(packageJsonPath) as {
      bin?: string | Record<string, string | undefined>;
    };
    const binPath =
      typeof pkg.bin === 'string'
        ? pkg.bin
        : typeof pkg.bin?.[binaryName] === 'string'
          ? pkg.bin[binaryName]
          : undefined;
    if (binPath) {
      return join(packageDir, binPath);
    }
  } catch {
    logger.debug('Could not resolve binary via package.json, falling back to PATH', {
      packageName,
      binaryName,
    });
  }
  return binaryName;
}

export async function withTimeout<T>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  description: string;
  cancelOn?: Promise<unknown>;
}): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`ACP ${params.description} timed out after ${params.timeoutMs}ms`));
    }, params.timeoutMs);
    timeout.unref?.();
    const clearTimer = () => {
      clearTimeout(timeout);
    };

    const cancelOn = params.cancelOn;
    if (cancelOn !== undefined) {
      void cancelOn.finally(clearTimer).catch(() => {
        // cancelOn is best-effort cancellation; ignore its rejection.
      });
    }

    params.promise.then(
      (value) => {
        clearTimer();
        resolve(value);
      },
      (error: unknown) => {
        clearTimer();
        reject(error);
      }
    );
  });
}

/** Runs package entrypoints with Node (including Electron's bundled Node runtime). */
export function resolveProviderAcpSpawnCommand(provider: 'CLAUDE' | 'CODEX'): SpawnCommand {
  const packageName =
    provider === 'CODEX'
      ? '@agentclientprotocol/codex-acp'
      : '@agentclientprotocol/claude-agent-acp';
  const binaryName = provider === 'CODEX' ? 'codex-acp' : 'claude-agent-acp';
  const entrypoint = resolveAcpBinary(packageName, binaryName).replace(
    /\.asar([/\\])/g,
    '.asar.unpacked$1'
  );
  if (entrypoint === binaryName) {
    return { command: binaryName, args: [], commandLabel: binaryName };
  }
  return {
    command: getNodeExecPath(),
    args: [entrypoint],
    commandLabel: `${binaryName} (${entrypoint})`,
  };
}

/** Terminate discovery subprocesses with a bounded grace period and no leaked listeners. */
export async function terminateCatalogProcess(child: ChildProcess): Promise<void> {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const onExit = () => resolveExit();
  child.once('exit', onExit);
  child.once('close', onExit);
  try {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 5000);
        timeout.unref?.();
      }),
    ]);
    if (!(exited || hasExited())) {
      child.kill('SIGKILL');
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    child.removeListener('exit', onExit);
    child.removeListener('close', onExit);
  }
}
