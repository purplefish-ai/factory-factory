#!/usr/bin/env node

import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command } from 'commander';
import { config } from 'dotenv';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file before anything else
config();

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

// Setup stdout/stderr forwarding for a child process in non-verbose mode
function setupProcessOutput(proc: ChildProcess, name: string): void {
  if (proc.stdout) {
    proc.stdout.on('data', (data: Buffer) => {
      process.stdout.write(data);
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (data: Buffer) => {
      console.error(chalk.red(`  [${name}] ${data.toString().trim()}`));
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
    killAllProcesses(processes);
    process.exit(1);
  }
}

// Kill all tracked processes
function killAllProcesses(processes: { name: string; proc: ChildProcess }[]): void {
  for (const { proc } of processes) {
    proc.kill('SIGTERM');
  }
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

// Check if a port is available
function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
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

// Run database migrations
function runMigrations(databasePath: string, verbose: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const migrate = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: `file:${databasePath}`,
      },
      stdio: verbose ? 'inherit' : 'pipe',
    });

    migrate.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Migration failed with exit code ${code}`));
      }
    });

    migrate.on('error', reject);
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

const program = new Command();

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

    // Database path - defaults to ~/factory-factory/data.db
    const defaultDbPath = join(homedir(), 'factory-factory', 'data.db');
    const databasePath = options.databasePath || process.env.DATABASE_PATH || defaultDbPath;

    // Show startup banner
    console.log(chalk.cyan(`\n  🔲 FACTORY ${chalk.bold('FACTORY')}\n`));

    // Ensure data directory exists
    if (verbose) {
      console.log(chalk.gray('  Ensuring data directory exists...'));
    }
    ensureDataDir(databasePath);

    // Find available ports
    const requestedFrontendPort = Number.parseInt(options.port, 10);
    const requestedBackendPort = Number.parseInt(options.backendPort, 10);

    let frontendPort: number;
    let backendPort: number;

    try {
      if (verbose) {
        console.log(chalk.gray('  Checking port availability...'));
      }

      // Find backend port first
      backendPort = await findAvailablePort(requestedBackendPort, options.host);
      if (backendPort !== requestedBackendPort) {
        console.log(
          chalk.yellow(`  ⚠ Backend port ${requestedBackendPort} in use, using ${backendPort}`)
        );
      }

      // Find frontend port, excluding the backend port to avoid conflicts
      frontendPort = await findAvailablePort(requestedFrontendPort, options.host, 10, [
        backendPort,
      ]);
      if (frontendPort !== requestedFrontendPort) {
        console.log(
          chalk.yellow(`  ⚠ Frontend port ${requestedFrontendPort} in use, using ${frontendPort}`)
        );
      }
    } catch (error) {
      console.error(chalk.red(`\n  ✗ ${(error as Error).message}`));
      process.exit(1);
    }

    // Run database migrations
    console.log(chalk.blue('  📦 Running database migrations...'));
    try {
      await runMigrations(databasePath, verbose);
      console.log(chalk.green('  ✓ Migrations completed'));
    } catch (error) {
      console.error(chalk.red(`\n  ✗ Migration failed: ${(error as Error).message}`));
      process.exit(1);
    }

    // Set environment variables
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_PATH: databasePath,
      FRONTEND_PORT: frontendPort.toString(),
      BACKEND_PORT: backendPort.toString(),
      BACKEND_URL: `http://${options.host}:${backendPort}`,
      NODE_ENV: options.dev ? 'development' : 'production',
    };

    const processes: { name: string; proc: ChildProcess }[] = [];
    const shutdownState = { shuttingDown: false };

    // Handle shutdown
    const shutdown = (signal: string) => {
      if (shutdownState.shuttingDown) {
        return;
      }
      shutdownState.shuttingDown = true;

      console.log(chalk.yellow(`\n  🛑 ${signal} received, shutting down...`));
      for (const { proc } of processes) {
        proc.kill('SIGTERM');
      }

      // Force kill after timeout
      setTimeout(() => {
        const alive = processes.filter(({ proc }) => !proc.killed && proc.exitCode === null);
        if (alive.length > 0) {
          console.log(
            chalk.red(`  Force killing remaining processes: ${alive.map((p) => p.name).join(', ')}`)
          );
          for (const { proc } of alive) {
            proc.kill('SIGKILL');
          }
        }
        process.exit(1);
      }, 5000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    const url = `http://${options.host}:${frontendPort}`;

    const onReady = async () => {
      console.log(chalk.gray('\n  ─────────────────────────────────────'));
      console.log(chalk.gray(`  Frontend:  http://${options.host}:${frontendPort}`));
      console.log(chalk.gray(`  Backend:   http://${options.host}:${backendPort}`));
      console.log(chalk.gray(`  Database:  ${databasePath}`));
      console.log(chalk.gray(`  Mode:      ${options.dev ? 'development' : 'production'}`));
      console.log(chalk.gray('  ─────────────────────────────────────'));
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
        backendPort,
        frontendPort,
        onReady,
        shutdownState
      );
    } else {
      // Production mode - use compiled backend and next start
      await startProductionMode(
        options,
        env,
        processes,
        backendPort,
        frontendPort,
        onReady,
        shutdownState
      );
    }
  });

async function startDevelopmentMode(
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
  processes: { name: string; proc: ChildProcess }[],
  backendPort: number,
  frontendPort: number,
  onReady: () => Promise<void>,
  shutdownState: { shuttingDown: boolean }
): Promise<void> {
  console.log(chalk.blue('  🔧 Starting backend (development mode)...'));

  const backend = spawn('npx', ['tsx', 'watch', 'src/backend/index.ts'], {
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

  const frontend = spawn('npx', ['vite', '--port', frontendPort.toString()], {
    cwd: PROJECT_ROOT,
    env,
    stdio: options.verbose ? 'inherit' : 'pipe',
  });
  processes.push({ name: 'frontend', proc: frontend });

  if (!options.verbose) {
    setupProcessOutput(frontend, 'frontend');
  }

  await waitForService(frontendPort, options.host, 'Frontend', processes);

  await onReady();

  await Promise.race([
    createExitPromise(backend, 'Backend', shutdownState),
    createExitPromise(frontend, 'Frontend', shutdownState),
  ]).catch((error) => {
    console.error(chalk.red(`\n  ✗ ${error.message}`));
    killAllProcesses(processes);
    process.exit(1);
  });
}

async function startProductionMode(
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
  processes: { name: string; proc: ChildProcess }[],
  _backendPort: number, // Unused in production - backend serves both API and frontend on frontendPort
  frontendPort: number,
  onReady: () => Promise<void>,
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
      // In production, frontend and backend run on the same port
      BACKEND_PORT: frontendPort.toString(),
    },
    stdio: options.verbose ? 'inherit' : 'pipe',
  });
  processes.push({ name: 'server', proc: backend });

  if (!options.verbose) {
    setupProcessOutput(backend, 'server');
  }

  await waitForService(frontendPort, options.host, 'Server', processes);

  await onReady();

  await createExitPromise(backend, 'Server', shutdownState).catch((error) => {
    console.error(chalk.red(`\n  ✗ ${error.message}`));
    killAllProcesses(processes);
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
  .action(async (options: MigrateOptions) => {
    // Database path is optional - defaults to ~/factory-factory/data.db
    const databasePath = options.databasePath || process.env.DATABASE_PATH;
    const defaultPath = join(homedir(), 'factory-factory', 'data.db');
    const effectivePath = databasePath || defaultPath;

    console.log(chalk.blue(`Running database migrations on ${effectivePath}...`));

    const migrate = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: `file:${effectivePath}`,
      },
      stdio: 'inherit',
    });

    const exitCode = await new Promise<number>((resolve) => {
      migrate.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode === 0) {
      console.log(chalk.green('Migrations completed successfully'));
    } else {
      console.error(chalk.red('Migration failed'));
      process.exit(exitCode);
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
// Parse and run
// ============================================================================

program.parse();
