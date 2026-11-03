import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { getBuildRecoveryGuidance } from './build-command';
import { stopChild, watchChild } from './child-lifecycle';
import { waitForPort } from './runtime-utils';
import { buildHttpOrigin } from './serve-env';

interface ServeSessionOptions {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  host: string;
  frontendPort: number;
  backendPort: number;
  dev?: boolean;
  verbose?: boolean;
  signal: AbortSignal;
  onReady: () => Promise<void>;
}

// Setup stdout/stderr forwarding for a child process in non-verbose mode
function setupProcessOutput(proc: ChildProcess, name: string): void {
  if (proc.stdout) {
    proc.stdout.on('data', (data: Buffer) => {
      process.stdout.write(data);
    });
    proc.stdout.on('error', (error) => {
      // Log but don't crash - this is non-critical output
      console.error(chalk.yellow(`  [${name}] stdout stream error: ${error.message}`));
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (data: Buffer) => {
      console.error(chalk.red(`  [${name}] ${data.toString().trim()}`));
    });
    proc.stderr.on('error', (error) => {
      // Log but don't crash - this is non-critical output
      console.error(chalk.yellow(`  [${name}] stderr stream error: ${error.message}`));
    });
  }
}

// Observe children before any readiness or browser work. Exit promises resolve
// with errors so a failure during startup can never become an unhandled rejection.
export async function runServeSession(options: ServeSessionOptions): Promise<void> {
  const children: ChildProcess[] = [];
  const watchers: ReturnType<typeof watchChild>[] = [];
  const startup = new AbortController();
  let failed = (_error: Error) => {
    /* Replaced synchronously by the failure promise resolver. */
  };
  const failure = new Promise<Error>((resolve) => {
    failed = resolve;
  });
  let onAbort = () => {
    /* Replaced synchronously when cancellation observation is installed. */
  };
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => {
      startup.abort();
      resolve(undefined);
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
    }
  });
  const track = (child: ChildProcess, name: string) => {
    children.push(child);
    const watcher = watchChild(child, name);
    watchers.push(watcher);
    void watcher.exited.then((error) => {
      failed(error);
      startup.abort();
    });
    if (!options.verbose) {
      setupProcessOutput(child, name);
    }
  };
  const ready = async (port: number, name: string) => {
    await waitForPort(port, options.host, undefined, undefined, startup.signal);
    startup.signal.throwIfAborted();
    console.log(chalk.green(`  ✓ ${name} ready on port ${port}`));
  };
  const start = async () => {
    startup.signal.throwIfAborted();
    const { projectRoot, env, backendPort, frontendPort } = options;
    const stdio = options.verbose ? 'inherit' : 'pipe';
    if (options.dev) {
      const suffix = process.platform === 'win32' ? '.cmd' : '';
      console.log(chalk.blue('  🔧 Starting backend (development mode)...'));
      track(
        spawn(
          join(projectRoot, 'node_modules', '.bin', `tsx${suffix}`),
          ['watch', 'src/backend/index.ts'],
          { cwd: projectRoot, env, stdio }
        ),
        'Backend'
      );
      await ready(backendPort, 'Backend');
      startup.signal.throwIfAborted();
      console.log(chalk.blue('  🎨 Starting frontend (development mode)...'));
      track(
        spawn(
          join(projectRoot, 'node_modules', '.bin', `vite${suffix}`),
          ['--port', frontendPort.toString(), '--strictPort'],
          {
            cwd: projectRoot,
            env: { ...env, BACKEND_URL: buildHttpOrigin(options.host, backendPort) },
            stdio,
          }
        ),
        'Frontend'
      );
      await ready(frontendPort, 'Frontend');
    } else {
      const frontendDist = join(projectRoot, 'dist', 'client');
      const backendDist = join(projectRoot, 'dist', 'src', 'backend', 'index.js');
      if (!existsSync(frontendDist)) {
        throw new Error(
          `Frontend not built. ${getBuildRecoveryGuidance(projectRoot, { supportsDevMode: true })}`
        );
      }
      if (!existsSync(backendDist)) {
        throw new Error(
          `Backend not built. ${getBuildRecoveryGuidance(projectRoot, { supportsDevMode: true })}`
        );
      }
      console.log(chalk.blue('  🔧 Starting server (production mode)...'));
      track(
        spawn('node', [backendDist], {
          cwd: projectRoot,
          env: { ...env, FRONTEND_STATIC_PATH: frontendDist },
          stdio,
        }),
        'Server'
      );
      await ready(backendPort, 'Server');
    }
    startup.signal.throwIfAborted();
    await options.onReady();
    // Readiness is not session completion: keep waiting for exit or cancellation.
    return failure;
  };
  try {
    const error = await Promise.race([failure, aborted, start()]);
    if (error) {
      throw error;
    }
  } catch (error) {
    if (!options.signal.aborted) {
      throw error;
    }
  } finally {
    startup.abort();
    options.signal.removeEventListener('abort', onAbort);
    await Promise.all(children.map(stopChild));
    for (const watcher of watchers) {
      watcher.dispose();
    }
  }
}
