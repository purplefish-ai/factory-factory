import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@/backend/services/logger.service';
import { normalizeUnknownError } from './acp-stream-normalizer';

const logger = createLogger('acp-runtime-manager');
const MAX_FACTORY_ROOT_SEARCH_DEPTH = 20;

export type SpawnCommand = {
  command: string;
  args: string[];
  commandLabel: string;
};

export function hasUsableWorkingDir(workingDir: string | null | undefined): boolean {
  return typeof workingDir === 'string' && workingDir.trim().length > 0;
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
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packageDir = dirname(packageJsonPath);
    const pkg = require(packageJsonPath) as {
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

function findFactoryRoot(startDir: string): string | null {
  let currentDir = startDir;
  for (let depth = 0; depth < MAX_FACTORY_ROOT_SEARCH_DEPTH; depth += 1) {
    const hasPackageJson = existsSync(join(currentDir, 'package.json'));
    const hasCliDistEntrypoint = existsSync(join(currentDir, 'dist', 'src', 'cli', 'index.js'));
    const hasCliSourceEntrypoint = existsSync(join(currentDir, 'src', 'cli', 'index.ts'));
    if (hasPackageJson && (hasCliDistEntrypoint || hasCliSourceEntrypoint)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
  return null;
}

function resolveFactoryRootForInternalCodexAdapter(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidateStarts = [process.cwd(), moduleDir];

  for (const candidate of candidateStarts) {
    const root = findFactoryRoot(candidate);
    if (root) {
      return root;
    }
  }

  throw new Error('Cannot resolve Factory Factory root for CODEX ACP adapter spawn');
}

export function resolveInternalCodexAcpSpawnCommand(preferSourceEntrypoint: boolean): SpawnCommand {
  const projectRoot = resolveFactoryRootForInternalCodexAdapter();
  const cliSourceEntrypoint = join(projectRoot, 'src', 'cli', 'index.ts');
  const cliDistEntrypoint = join(projectRoot, 'dist', 'src', 'cli', 'index.js');
  const tsconfigPath = join(projectRoot, 'tsconfig.json');
  const tsxBin = join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  );
  const hasTypeScriptRuntime =
    process.execArgv.some((arg) => arg.includes('tsx')) ||
    process.execArgv.some((arg) => arg.includes('ts-node'));

  const buildNodeSpawnCommand = (entrypoint: string): SpawnCommand => {
    const args = [entrypoint, 'internal', 'codex-app-server-acp'];
    return {
      command: process.execPath,
      args,
      commandLabel: `${process.execPath} ${args.join(' ')}`.trim(),
    };
  };

  const resolveSourceSpawnCommand = (): SpawnCommand | null => {
    if (!existsSync(cliSourceEntrypoint)) {
      return null;
    }
    if (existsSync(tsxBin)) {
      const args = [
        ...(existsSync(tsconfigPath) ? ['--tsconfig', tsconfigPath] : []),
        cliSourceEntrypoint,
        'internal',
        'codex-app-server-acp',
      ];
      return {
        command: tsxBin,
        args,
        commandLabel: `${tsxBin} ${args.join(' ')}`.trim(),
      };
    }
    if (hasTypeScriptRuntime) {
      const args = [...process.execArgv, cliSourceEntrypoint, 'internal', 'codex-app-server-acp'];
      return {
        command: process.execPath,
        args,
        commandLabel: `${process.execPath} ${args.join(' ')}`.trim(),
      };
    }
    return null;
  };

  if (preferSourceEntrypoint) {
    const sourceCommand = resolveSourceSpawnCommand();
    if (sourceCommand) {
      return sourceCommand;
    }

    if (existsSync(cliDistEntrypoint)) {
      return buildNodeSpawnCommand(cliDistEntrypoint);
    }
  } else {
    if (existsSync(cliDistEntrypoint)) {
      return buildNodeSpawnCommand(cliDistEntrypoint);
    }

    const sourceCommand = resolveSourceSpawnCommand();
    if (sourceCommand) {
      return sourceCommand;
    }
  }

  throw new Error('Cannot resolve CLI entrypoint for CODEX ACP adapter spawn');
}
