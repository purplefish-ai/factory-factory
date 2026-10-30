import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { stopChild } from './child-lifecycle';
import { waitForPort } from './runtime-utils';

const LOCAL_HOST = '127.0.0.1';

export async function startFactoryFactoryServer(params: {
  projectRoot: string;
  databasePath: string;
  requestedPort: number;
  trustedProxyOrigin?: string;
  signal?: AbortSignal;
}): Promise<{ process: ChildProcess; port: number }> {
  const frontendDist = join(params.projectRoot, 'dist', 'client');
  const backendDist = join(params.projectRoot, 'dist', 'src', 'backend', 'index.js');

  if (!(existsSync(frontendDist) && existsSync(backendDist))) {
    throw new Error('Frontend or backend not built. Run `ff build` or `pnpm build` first.');
  }

  const backend = spawn('node', [backendDist], {
    cwd: params.projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_PATH: params.databasePath,
      BACKEND_PORT: params.requestedPort.toString(),
      BACKEND_HOST: LOCAL_HOST,
      // Public tunnel traffic must never inherit a trusted reverse-proxy opt-in.
      TRUST_PROXY_HEADERS: params.trustedProxyOrigin ? 'true' : 'false',
      ...(params.trustedProxyOrigin
        ? { CORS_ALLOWED_ORIGINS: params.trustedProxyOrigin, DISABLE_CORS_CHECKS: 'false' }
        : {}),
      DOTENV_CONFIG_OVERRIDE: 'false',
      DOTENV_OVERRIDE: 'false',
      FF_RUN_SCRIPT_PROXY_ENABLED: '1',
      FRONTEND_STATIC_PATH: frontendDist,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: params.signal,
  });

  backend.stderr?.on('data', (chunk: Buffer) => {
    const message = chunk.toString().trim();
    if (!message) {
      return;
    }
    process.stderr.write(chalk.red(`  [server] ${message}\n`));
  });

  let startupBuffer = '';
  let actualPort: number;
  let cleanupStartup: (() => void) | undefined;
  try {
    actualPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for server startup signal'));
      }, 30_000);
      timeout.unref?.();

      const cleanup = () => {
        clearTimeout(timeout);
        backend.stdout?.off('data', onStdoutData);
        backend.off('exit', onExit);
        backend.off('error', onError);
      };

      cleanupStartup = cleanup;

      const onStdoutData = (chunk: Buffer) => {
        startupBuffer += chunk.toString();
        const match = startupBuffer.match(/BACKEND_PORT:(\d+)\r?\n/);
        if (match?.[1]) {
          const parsed = Number.parseInt(match[1], 10);
          if (Number.isNaN(parsed)) {
            cleanup();
            reject(new Error('Received invalid backend port from server startup'));
            return;
          }
          clearTimeout(timeout);
          backend.stdout?.off('data', onStdoutData);
          resolve(parsed);
          return;
        }

        if (startupBuffer.length > 4096) {
          startupBuffer = startupBuffer.slice(-2048);
        }
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `Server exited before startup completed (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`
          )
        );
      };

      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Failed to start backend server: ${error.message}`));
      };

      backend.stdout?.on('data', onStdoutData);
      backend.once('exit', onExit);
      backend.once('error', onError);
    });

    await waitForPort(actualPort, LOCAL_HOST, 30_000, 500, params.signal);
  } catch (error) {
    await stopChild(backend);
    throw error;
  } finally {
    cleanupStartup?.();
  }

  return { process: backend, port: actualPort };
}
