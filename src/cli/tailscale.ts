import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { runMigrations } from '@/backend/migrate';
import { stopChild, watchChild } from './child-lifecycle';
import { resolveDatabasePath } from './database-path';
import { forwardDiagnosticOutput } from './diagnostic-output';
import { ensureDataDir, findAvailablePort } from './runtime-utils';
import { startFactoryFactoryServer } from './server-startup';
import { discoverTailscale, parsePort } from './tailscale-client';
import { supportsTerminalQrRendering, tryRenderTerminalQrCode } from './terminal-qr';

interface TailscaleOptions {
  backendPort: number;
  httpsPort: number;
  databasePath?: string;
}

export async function runTailscaleSession(params: {
  projectRoot: string;
  options: TailscaleOptions;
  signal: AbortSignal;
}): Promise<void> {
  const { projectRoot, options, signal } = params;
  const children: ChildProcess[] = [];
  const watchers: ReturnType<typeof watchChild>[] = [];
  const outputDisposers: (() => void)[] = [];
  let onAbort = () => {
    /* No abort listener exists before children start. */
  };
  try {
    signal.throwIfAborted();
    const origin = await discoverTailscale(options.httpsPort, signal);
    signal.throwIfAborted();
    const databasePath = resolveDatabasePath({ databasePath: options.databasePath });
    ensureDataDir(databasePath);
    runMigrations({
      databasePath,
      migrationsPath: join(projectRoot, 'prisma', 'migrations'),
      log: console.log,
    });
    const requestedPort = await findAvailablePort(options.backendPort, { maxAttempts: 50, signal });
    signal.throwIfAborted();
    const backend = await startFactoryFactoryServer({
      projectRoot,
      databasePath,
      requestedPort,
      trustedProxyOrigin: origin,
      signal,
    });
    children.push(backend.process);
    signal.throwIfAborted();
    watchers.push(watchChild(backend.process, 'Factory Factory'));

    console.log(chalk.cyan(`\nFactory Factory URL: ${origin}`));
    console.log('Access follows your tailnet access rules. Press Ctrl+C to stop.');
    console.log('If Tailscale prints a setup link, open it to enable HTTPS/Serve.\n');
    const serve = spawn(
      'tailscale',
      ['serve', `--https=${options.httpsPort}`, `http://127.0.0.1:${backend.port}`],
      {
        stdio: ['inherit', 'pipe', 'pipe'],
      }
    );
    children.push(serve);
    watchers.push(watchChild(serve, 'Tailscale Serve'));
    outputDisposers.push(
      forwardDiagnosticOutput(serve.stdout, process.stdout),
      forwardDiagnosticOutput(serve.stderr, process.stderr)
    );

    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
    // QR rendering is optional; it must not delay cleanup if a child exits.
    if (supportsTerminalQrRendering()) {
      void tryRenderTerminalQrCode(origin)
        .then((qr) => {
          if (qr && !signal.aborted && serve.exitCode === null && serve.signalCode === null) {
            console.log(qr);
          }
        })
        .catch(() => {
          /* The printed URL remains available if QR rendering fails. */
        });
    }
    const failure = await Promise.race([aborted, ...watchers.map((watcher) => watcher.exited)]);
    if (failure) {
      throw failure;
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await Promise.all(children.map(stopChild));
    for (const dispose of outputDisposers) {
      dispose();
    }
    for (const watcher of watchers) {
      watcher.dispose();
    }
  }
}

export function registerTailscaleCommand(program: Command, projectRoot: string): void {
  program
    .command('tailscale')
    .description('Start Factory Factory with private HTTPS access through Tailscale')
    .option('--backend-port <port>', 'First local backend port to try', parsePort, 3001)
    .option('--https-port <port>', 'Tailscale HTTPS port (must be unused)', parsePort, 443)
    .option('-d, --database-path <path>', 'SQLite database file path (or set DATABASE_PATH env)')
    .action(async (options: TailscaleOptions) => {
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      try {
        await runTailscaleSession({ projectRoot, options, signal: controller.signal });
      } catch (error) {
        console.error(chalk.red(`Tailscale session failed: ${String(error)}`));
        process.exitCode = 1;
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    });
}
