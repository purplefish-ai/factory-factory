#!/usr/bin/env node

import { type ChildProcess, exec, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { Command } from 'commander';
import { config } from 'dotenv';
import open from 'open';
import treeKill from 'tree-kill';
import { runCodexAppServerAcpAdapter } from '@/backend/domains/session';
import { runMigrations as runDbMigrations } from '@/backend/migrate';
import { getLogFilePath } from '@/backend/services/logger.service';
import { runProxyCommand } from './proxy';

const execPromise = promisify(exec);

function treeKillAsync(pid: number, signal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, signal, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file before anything else
config({ quiet: true });

// Find project root (where package.json is)
function findProjectRoot(): string {
  let dir = __dirname;
  // Cross-platform: check if we've reached the filesystem root
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  // Fall back to cwd
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();

function resolveLocalBin(command: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return join(PROJECT_ROOT, 'node_modules', '.bin', `${command}${suffix}`);
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

// Wait for a service to start on a port, killing all processes and exiting on failure
async function waitForService(
  port: number,
  host: string,
  serviceName: string,
  processes: { name: string; proc: ChildProcess }[]
): Promise<void> {
  try {
    await waitForPort(port, host);
    console.log(chalk.green(`  ✓ ${serviceName} ready on port ${port}`));
  } catch {
    console.error(chalk.red(`\n  ✗ ${serviceName} failed to start on port ${port}`));
    await killAllProcesses(processes);
    process.exit(1);
  }
}

// Kill all tracked processes and their child process trees
async function killAllProcesses(processes: { name: string; proc: ChildProcess }[]): Promise<void> {
  await Promise.allSettled(
    processes
      .filter(({ proc }) => proc.pid)
      .map(async ({ name, proc }) => {
        try {
          await treeKillAsync(proc.pid as number, 'SIGTERM');
        } catch (err) {
          console.error(
            chalk.yellow(`  Failed to kill ${name} (${proc.pid}): ${(err as Error).message}`)
          );
        }
      })
  );
}

// Create an exit promise for a process that resolves during shutdown, rejects on unexpected exit
function createExitPromise(
  proc: ChildProcess,
  name: string,
  shutdownState: { shuttingDown: boolean }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    proc.on('exit', (code) => {
      if (shutdownState.shuttingDown) {
        resolve();
      } else if (code !== 0) {
        reject(new Error(`${name} exited with code ${code}`));
      }
    });
  });
}

// Read version from package.json
function getVersion(): string {
  try {
    const pkgPath = join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Wait for a port to be available
async function waitForPort(
  port: number,
  host = 'localhost',
  timeout = 30_000,
  interval = 500
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ port, host }, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', () => {
          socket.destroy();
          reject();
        });
      });
      return; // Port is available
    } catch {
      // Port not ready, wait and retry
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  throw new Error(`Timed out waiting for port ${port} after ${timeout}ms`);
}

/**
 * Check if a port is in use by checking actual listening processes.
 * Uses lsof on Unix systems for more reliable detection that avoids TOCTOU race conditions.
 * Falls back to bind attempt if lsof is unavailable.
 */
async function isPortInUse(port: number): Promise<boolean> {
  // Try lsof first (more reliable, checks actual listening processes)
  if (process.platform !== 'win32') {
    try {
      // lsof -i :PORT -sTCP:LISTEN checks for processes listening on the port
      // -t returns just PIDs (suppresses errors if no process found)
      const { stdout } = await execPromise(`lsof -i :${port} -sTCP:LISTEN -t`, {
        timeout: 2000,
      });
      // If we get output, port is in use
      return stdout.trim().length > 0;
    } catch (error) {
      // lsof exits with code 1 if no process found (port is free)
      if ((error as { code?: number }).code === 1) {
        return false;
      }
      // lsof not available or other error - fall back to bind attempt
    }
  }

  // Fallback: try to bind to the port
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(true); // Error means port is in use
    });
    server.once('listening', () => {
      server.close(() => resolve(false)); // Successfully bound means port is free
    });
    server.listen(port);
  });
}

/**
 * Check if a port is available (inverse of isPortInUse).
 */
function isPortAvailable(port: number, _host: string): Promise<boolean> {
  return isPortInUse(port).then((inUse) => !inUse);
}

// Find an available port starting from the given port, excluding specific ports
async function findAvailablePort(
  startPort: number,
  host: string,
  maxAttempts = 10,
  excludePorts: number[] = []
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (excludePorts.includes(port)) {
      continue;
    }
    if (await isPortAvailable(port, host)) {
      return port;
    }
  }
  throw new Error(`Could not find an available port starting from ${startPort}`);
}

// Ensure data directory exists
function ensureDataDir(databasePath: string): void {
  const dir = dirname(databasePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Run database migrations using better-sqlite3 directly (no Prisma CLI needed)
function runMigrations(databasePath: string, verbose: boolean): Promise<void> {
  const migrationsPath = join(PROJECT_ROOT, 'prisma', 'migrations');
  const log = verbose
    ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
    : () => {
        /* no-op for non-verbose mode */
      };

  return Promise.resolve().then(() => {
    runDbMigrations({ databasePath, migrationsPath, log });
  });
}

interface ServeOptions {
  port: string;
  backendPort: string;
  databasePath?: string;
  host: string;
  dev?: boolean;
  open?: boolean;
  verbose?: boolean;
}

interface MigrateOptions {
  databasePath?: string;
}

interface ProxyOptions {
  private?: boolean;
}

const program = new Command();

function resolveDatabasePath(options: ServeOptions): string {
  const defaultDbPath = join(homedir(), 'factory-factory', 'data.db');
  return options.databasePath || process.env.DATABASE_PATH || defaultDbPath;
}

async function resolvePortsOrExit(
  options: ServeOptions,
  verbose: boolean
): Promise<{ frontendPort: number; backendPort: number }> {
  const requestedFrontendPort = Number.parseInt(options.port, 10);
  const requestedBackendPort = Number.parseInt(options.backendPort, 10);

  try {
    if (verbose) {
      console.log(chalk.gray('  Checking port availability...'));
    }

    if (options.dev) {
      const backendPort = await findAvailablePort(requestedBackendPort, options.host);
      const frontendPort = await findAvailablePort(requestedFrontendPort, options.host, 20, [
        backendPort,
      ]);

      if (frontendPort !== requestedFrontendPort || backendPort !== requestedBackendPort) {
        console.log(
          chalk.yellow(
            `  ⚠ Requested ports in use, using Frontend: ${frontendPort}, Backend: ${backendPort}`
          )
        );
      }

      return { frontendPort, backendPort };
    }

    const frontendPort = await findAvailablePort(requestedFrontendPort, options.host);
    const backendPort = frontendPort;

    if (frontendPort !== requestedFrontendPort) {
      console.log(chalk.yellow(`  ⚠ Port ${requestedFrontendPort} in use, using ${frontendPort}`));
    }

    return { frontendPort, backendPort };
  } catch (error) {
    console.error(chalk.red(`\n  ✗ ${(error as Error).message}`));
    process.exit(1);
  }
}

async function runMigrationsOrExit(databasePath: string, verbose: boolean): Promise<void> {
  console.log(chalk.blue('  📦 Running database migrations...'));
  try {
    await runMigrations(databasePath, verbose);
    console.log(chalk.green('  ✓ Migrations completed'));
  } catch (error) {
    console.error(chalk.red(`\n  ✗ Migration failed: ${(error as Error).message}`));
    process.exit(1);
  }
}

function createShutdownHandler(
  processes: { name: string; proc: ChildProcess }[],
  shutdownState: { shuttingDown: boolean }
) {
  return (signal: string) => {
    if (shutdownState.shuttingDown) {
      return;
    }
    shutdownState.shuttingDown = true;

    console.log(chalk.yellow(`\n  🛑 ${signal} received, shutting down...`));

    // Send SIGTERM to all process trees
    const termPromises = processes
      .filter(({ proc }) => proc.pid)
      .map(async ({ name, proc }) => {
        try {
          await treeKillAsync(proc.pid as number, 'SIGTERM');
        } catch (err) {
          console.error(
            chalk.yellow(`  Failed to kill ${name} (${proc.pid}): ${(err as Error).message}`)
          );
        }
      });

    // Wait for graceful shutdown, then force kill remaining
    setTimeout(async () => {
      try {
        await Promise.allSettled(termPromises);

        // A child that exits from a signal has `exitCode === null` and `signalCode !== null`.
        // Treat those as already exited to avoid false "force killing" logs.
        const alive = processes.filter(
          ({ proc }) => proc.exitCode === null && proc.signalCode === null
        );

        if (alive.length > 0) {
          console.log(
            chalk.red(`  Force killing remaining processes: ${alive.map((p) => p.name).join(', ')}`)
          );
          const killResults = await Promise.allSettled(
            alive
              .filter(({ proc }) => proc.pid)
              .map(async ({ name, proc }) => {
                try {
                  await treeKillAsync(proc.pid as number, 'SIGKILL');
                } catch (err) {
                  console.error(
                    chalk.yellow(
                      `  Failed to force kill ${name} (${proc.pid}): ${(err as Error).message}`
                    )
                  );
                  throw err;
                }
              })
          );
          const killFailed = killResults.some((r) => r.status === 'rejected');
          if (killFailed) {
            process.exitCode = 1;
          }
        }
      } catch (err) {
        // Handle any unexpected errors in shutdown handler to avoid unhandled rejection
        console.error(chalk.red(`  Shutdown error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    }, 5000);
  };
}

function registerShutdownHandlers(shutdown: (signal: string) => void): void {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printReadyBanner(opts: {
  isDev: boolean;
  host: string;
  frontendPort: number;
  backendPort: number;
  databasePath: string;
}): void {
  console.log(chalk.gray('\n  ─────────────────────────────────────'));
  if (opts.isDev) {
    console.log(chalk.gray(`  Frontend:  http://${opts.host}:${opts.frontendPort}`));
    console.log(chalk.gray(`  Backend:   http://${opts.host}:${opts.backendPort}`));
  } else {
    console.log(chalk.gray(`  Server:    http://${opts.host}:${opts.backendPort}`));
  }
  console.log(chalk.gray(`  Database:  ${opts.databasePath}`));
  console.log(chalk.gray(`  Mode:      ${opts.isDev ? 'development' : 'production'}`));
  console.log(chalk.gray(`  Logs:      ${getLogFilePath()}`));
  console.log(chalk.gray('  ─────────────────────────────────────'));
}

function buildServeEnv(
  options: ServeOptions,
  databasePath: string,
  frontendPort: number,
  backendPort: number
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_PATH: databasePath,
    FRONTEND_PORT: frontendPort.toString(),
    BACKEND_PORT: backendPort.toString(),
    NODE_ENV: options.dev ? 'development' : 'production',
  };
}

program
  .name('ff')
  .description('FACTORY FACTORY - Workspace-based coding environment')
  .version(getVersion());

// ============================================================================
// serve command
// ============================================================================

program
  .command('serve')
  .description('Start the FACTORY FACTORY server')
  .option('-p, --port <port>', 'Frontend port', process.env.FRONTEND_PORT || '3000')
  .option('--backend-port <port>', 'Backend port', process.env.BACKEND_PORT || '3001')
  .option('-d, --database-path <path>', 'SQLite database file path (or set DATABASE_PATH env)')
  .option('--host <host>', 'Host to bind to', 'localhost')
  .option('--dev', 'Run in development mode with hot reloading')
  .option('--no-open', 'Do not open browser automatically')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options: ServeOptions) => {
    const verbose = options.verbose ?? false;
    const shouldOpen = options.open !== false;

    const databasePath = resolveDatabasePath(options);

    // Show startup banner
    console.log(chalk.cyan(`\n  🏭🏭 FACTORY ${chalk.bold('FACTORY')}\n`));

    // Ensure data directory exists
    if (verbose) {
      console.log(chalk.gray('  Ensuring data directory exists...'));
    }
    ensureDataDir(databasePath);

    const { frontendPort, backendPort } = await resolvePortsOrExit(options, verbose);
    await runMigrationsOrExit(databasePath, verbose);

    const env = buildServeEnv(options, databasePath, frontendPort, backendPort);

    const processes: { name: string; proc: ChildProcess }[] = [];
    const shutdownState = { shuttingDown: false };

    const shutdown = createShutdownHandler(processes, shutdownState);
    registerShutdownHandlers(shutdown);

    const createOnReady = (actualBackendPort: number) => async () => {
      const url = options.dev
        ? `http://${options.host}:${frontendPort}`
        : `http://${options.host}:${actualBackendPort}`;

      printReadyBanner({
        isDev: !!options.dev,
        host: options.host,
        frontendPort,
        backendPort: actualBackendPort,
        databasePath,
      });
      console.log(chalk.bold.green(`\n  ✅ Ready at ${chalk.cyan(url)}\n`));
      console.log(chalk.dim('  Press Ctrl+C to stop\n'));

      if (shouldOpen) {
        try {
          await open(url);
        } catch (error) {
          console.log(chalk.yellow(`  ⚠ Could not open browser: ${(error as Error).message}`));
        }
      }
    };

    if (options.dev) {
      // Development mode - use tsx watch for backend, next dev for frontend
      await startDevelopmentMode(
        options,
        env,
        processes,
        frontendPort,
        backendPort,
        createOnReady,
        shutdownState
      );
    } else {
      // Production mode - use compiled backend and next start
      await startProductionMode(
        options,
        env,
        processes,
        frontendPort,
        backendPort,
        createOnReady,
        shutdownState
      );
    }
  });

async function startDevelopmentMode(
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
  processes: { name: string; proc: ChildProcess }[],
  frontendPort: number,
  backendPort: number,
  createOnReady: (actualBackendPort: number) => () => Promise<void>,
  shutdownState: { shuttingDown: boolean }
): Promise<void> {
  console.log(chalk.blue('  🔧 Starting backend (development mode)...'));

  const backend = spawn(resolveLocalBin('tsx'), ['watch', 'src/backend/index.ts'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: options.verbose ? 'inherit' : 'pipe',
  });
  processes.push({ name: 'backend', proc: backend });

  if (!options.verbose) {
    setupProcessOutput(backend, 'backend');
  }

  await waitForService(backendPort, options.host, 'Backend', processes);

  console.log(chalk.blue('  🎨 Starting frontend (development mode)...'));

  // Update env with backend port for Vite proxy configuration
  const frontendEnv = {
    ...env,
    BACKEND_URL: `http://${options.host}:${backendPort}`,
  };

  const frontend = spawn(
    resolveLocalBin('vite'),
    ['--port', frontendPort.toString(), '--strictPort'],
    {
      cwd: PROJECT_ROOT,
      env: frontendEnv,
      stdio: options.verbose ? 'inherit' : 'pipe',
    }
  );
  processes.push({ name: 'frontend', proc: frontend });

  if (!options.verbose) {
    setupProcessOutput(frontend, 'frontend');
  }

  await waitForService(frontendPort, options.host, 'Frontend', processes);

  const onReady = createOnReady(backendPort);
  await onReady();

  await Promise.race([
    createExitPromise(backend, 'Backend', shutdownState),
    createExitPromise(frontend, 'Frontend', shutdownState),
  ]).catch(async (error) => {
    console.error(chalk.red(`\n  ✗ ${error.message}`));
    await killAllProcesses(processes);
    process.exit(1);
  });
}

async function startProductionMode(
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
  processes: { name: string; proc: ChildProcess }[],
  _frontendPort: number,
  backendPort: number,
  createOnReady: (actualBackendPort: number) => () => Promise<void>,
  shutdownState: { shuttingDown: boolean }
): Promise<void> {
  const frontendDist = join(PROJECT_ROOT, 'dist', 'client');
  const backendDist = join(PROJECT_ROOT, 'dist', 'src', 'backend', 'index.js');

  if (!existsSync(frontendDist)) {
    console.error(chalk.red('\n  ✗ Frontend not built. Run `ff build` or `pnpm build` first.'));
    console.error(chalk.gray('    Or use --dev flag for development mode.'));
    process.exit(1);
  }

  if (!existsSync(backendDist)) {
    console.error(chalk.red('\n  ✗ Backend not built. Run `ff build` or `pnpm build` first.'));
    console.error(chalk.gray('    Or use --dev flag for development mode.'));
    process.exit(1);
  }

  // In production, the backend serves both API and static files on a single port
  // Set FRONTEND_STATIC_PATH so backend knows where to serve static files from
  console.log(chalk.blue('  🔧 Starting server (production mode)...'));

  const backend = spawn('node', [backendDist], {
    cwd: PROJECT_ROOT,
    env: {
      ...env,
      FRONTEND_STATIC_PATH: frontendDist,
    },
    stdio: options.verbose ? 'inherit' : 'pipe',
  });
  processes.push({ name: 'server', proc: backend });

  if (!options.verbose) {
    setupProcessOutput(backend, 'server');
  }

  await waitForService(backendPort, options.host, 'Server', processes);

  const onReady = createOnReady(backendPort);
  await onReady();

  await createExitPromise(backend, 'Server', shutdownState).catch(async (error) => {
    console.error(chalk.red(`\n  ✗ ${error.message}`));
    await killAllProcesses(processes);
    process.exit(1);
  });
}

// ============================================================================
// db:migrate command
// ============================================================================

program
  .command('db:migrate')
  .description('Run database migrations')
  .option('-d, --database-path <path>', 'SQLite database file path (or set DATABASE_PATH env)')
  .action((options: MigrateOptions) => {
    // Database path is optional - defaults to ~/factory-factory/data.db
    const databasePath = options.databasePath || process.env.DATABASE_PATH;
    const defaultPath = join(homedir(), 'factory-factory', 'data.db');
    const effectivePath = databasePath || defaultPath;

    console.log(chalk.blue(`Running database migrations on ${effectivePath}...`));

    try {
      const migrationsPath = join(PROJECT_ROOT, 'prisma', 'migrations');
      runDbMigrations({
        databasePath: effectivePath,
        migrationsPath,
        log: (msg) => console.log(chalk.gray(msg)),
      });
      console.log(chalk.green('Migrations completed successfully'));
    } catch (error) {
      console.error(chalk.red('Migration failed:'), error);
      process.exit(1);
    }
  });

// ============================================================================
// db:studio command
// ============================================================================

program
  .command('db:studio')
  .description('Open Prisma Studio for database management')
  .option('-d, --database-path <path>', 'SQLite database file path (or set DATABASE_PATH env)')
  .action(async (options: MigrateOptions) => {
    // Database path is optional - defaults to ~/factory-factory/data.db
    const databasePath = options.databasePath || process.env.DATABASE_PATH;
    const defaultPath = join(homedir(), 'factory-factory', 'data.db');
    const effectivePath = databasePath || defaultPath;

    console.log(chalk.blue(`Opening Prisma Studio for ${effectivePath}...`));

    const studio = spawn('npx', ['prisma', 'studio'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: `file:${effectivePath}`,
      },
      stdio: 'inherit',
    });

    await new Promise<void>((resolve) => {
      studio.on('exit', () => resolve());
    });
  });

// ============================================================================
// build command
// ============================================================================

program
  .command('build')
  .description('Build for production')
  .action(async () => {
    console.log(chalk.blue('Building backend...'));

    // Compile TypeScript backend
    const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.backend.json'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });

    let exitCode = await new Promise<number>((resolve) => {
      tsc.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      console.error(chalk.red('Backend TypeScript compilation failed'));
      process.exit(exitCode);
    }

    // Run tsc-alias to resolve path aliases and add .js extensions for ESM
    const tscAlias = spawn(
      'npx',
      ['tsc-alias', '-p', 'tsconfig.backend.json', '--resolve-full-paths'],
      {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      }
    );

    exitCode = await new Promise<number>((resolve) => {
      tscAlias.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      console.error(chalk.red('Backend path alias resolution failed'));
      process.exit(exitCode);
    }

    // Copy prompts directory to dist (markdown files referenced at runtime)
    const promptsSrc = join(PROJECT_ROOT, 'prompts');
    const promptsDest = join(PROJECT_ROOT, 'dist', 'prompts');
    if (existsSync(promptsSrc)) {
      cpSync(promptsSrc, promptsDest, { recursive: true });
    }

    console.log(chalk.green('  ✓ Backend built'));
    console.log(chalk.blue('Building frontend...'));

    // Build Vite/React Router frontend
    const viteBuild = spawn('npx', ['vite', 'build'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });

    exitCode = await new Promise<number>((resolve) => {
      viteBuild.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      console.error(chalk.red('Frontend build failed'));
      process.exit(exitCode);
    }

    console.log(chalk.green('\n✅ Build completed successfully!'));
    console.log(chalk.gray('Run `ff serve` to start the production server'));
  });

// ============================================================================
// proxy command
// ============================================================================

program
  .command('proxy')
  .description('Start a public tunnel to your local Factory Factory server')
  .option('--private', 'Enable password authentication')
  .action(async (options: ProxyOptions) => {
    await runProxyCommand({ options, projectRoot: PROJECT_ROOT });
  });

// ============================================================================
// internal commands (hidden)
// ============================================================================

const internalProgram = program.command('internal', { hidden: true });
internalProgram.command('codex-app-server-acp').action(() => {
  runCodexAppServerAcpAdapter();
});

// ============================================================================
// Parse and run
// ============================================================================

program.parse();
