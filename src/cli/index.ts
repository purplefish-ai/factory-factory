#!/usr/bin/env node

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command } from 'commander';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Find an available port starting from the given port
async function findAvailablePort(
  startPort: number,
  host: string,
  maxAttempts = 10
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
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
  .option('-p, --port <port>', 'Frontend port', '3000')
  .option('--backend-port <port>', 'Backend port', '3001')
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
      backendPort = await findAvailablePort(requestedBackendPort, options.host);
      if (backendPort !== requestedBackendPort) {
        console.log(
          chalk.yellow(`  ⚠ Backend port ${requestedBackendPort} in use, using ${backendPort}`)
        );
      }

      frontendPort = await findAvailablePort(requestedFrontendPort, options.host);
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
      NEXT_PUBLIC_BACKEND_PORT: backendPort.toString(),
      NODE_ENV: options.dev ? 'development' : 'production',
    };

    const processes: ChildProcess[] = [];
    const shutdownState = { shuttingDown: false };

    // Handle shutdown
    const shutdown = (signal: string) => {
      if (shutdownState.shuttingDown) {
        return;
      }
      shutdownState.shuttingDown = true;

      console.log(chalk.yellow(`\n  🛑 ${signal} received, shutting down...`));
      for (const proc of processes) {
        proc.kill('SIGTERM');
      }

      // Force kill after timeout
      setTimeout(() => {
        console.log(chalk.red('  Force killing remaining processes...'));
        for (const proc of processes) {
          proc.kill('SIGKILL');
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
  processes: ChildProcess[],
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
  processes.push(backend);

  // Log stderr even in non-verbose mode
  if (!options.verbose && backend.stderr) {
    backend.stderr.on('data', (data: Buffer) => {
      console.error(chalk.red(`  [backend] ${data.toString().trim()}`));
    });
  }

  // Wait for backend to be ready
  try {
    await waitForPort(backendPort, options.host);
    console.log(chalk.green(`  ✓ Backend ready on port ${backendPort}`));
  } catch {
    console.error(chalk.red(`\n  ✗ Backend failed to start on port ${backendPort}`));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
    process.exit(1);
  }

  console.log(chalk.blue('  🎨 Starting frontend (development mode)...'));

  const frontend = spawn('npx', ['next', 'dev', '-p', frontendPort.toString()], {
    cwd: PROJECT_ROOT,
    env,
    stdio: options.verbose ? 'inherit' : 'pipe',
  });
  processes.push(frontend);

  // Log stderr even in non-verbose mode
  if (!options.verbose && frontend.stderr) {
    frontend.stderr.on('data', (data: Buffer) => {
      console.error(chalk.red(`  [frontend] ${data.toString().trim()}`));
    });
  }

  // Wait for frontend to be ready
  try {
    await waitForPort(frontendPort, options.host);
    console.log(chalk.green(`  ✓ Frontend ready on port ${frontendPort}`));
  } catch {
    console.error(chalk.red(`\n  ✗ Frontend failed to start on port ${frontendPort}`));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
    process.exit(1);
  }

  // Call onReady callback (opens browser, shows final status)
  await onReady();

  // Wait for either process to exit
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      backend.on('exit', (code) => {
        // Resolve cleanly during shutdown, reject on unexpected exit
        if (shutdownState.shuttingDown) {
          resolve();
        } else if (code !== 0) {
          reject(new Error(`Backend exited with code ${code}`));
        }
      });
    }),
    new Promise<void>((resolve, reject) => {
      frontend.on('exit', (code) => {
        // Resolve cleanly during shutdown, reject on unexpected exit
        if (shutdownState.shuttingDown) {
          resolve();
        } else if (code !== 0) {
          reject(new Error(`Frontend exited with code ${code}`));
        }
      });
    }),
  ]).catch((error) => {
    console.error(chalk.red(`\n  ✗ ${error.message}`));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
    process.exit(1);
  });
}

async function startProductionMode(
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
  processes: ChildProcess[],
  backendPort: number,
  frontendPort: number,
  onReady: () => Promise<void>,
  shutdownState: { shuttingDown: boolean }
): Promise<void> {
  // Check if built
  const nextStandalone = join(PROJECT_ROOT, '.next', 'standalone');
  const backendDist = join(PROJECT_ROOT, 'dist', 'backend', 'index.js');

  if (!existsSync(nextStandalone)) {
    console.error(
      chalk.red('\n  ✗ Frontend not built. Run `ff build` or `pnpm build:frontend` first.')
    );
    console.error(chalk.gray('    Or use --dev flag for development mode.'));
    process.exit(1);
  }

  if (!existsSync(backendDist)) {
    console.error(
      chalk.red('\n  ✗ Backend not built. Run `ff build` or `pnpm build:backend` first.')
    );
    console.error(chalk.gray('    Or use --dev flag for development mode.'));
    process.exit(1);
  }

  console.log(chalk.blue('  🔧 Starting backend (production mode)...'));

  const backend = spawn('node', [backendDist], {
    cwd: PROJECT_ROOT,
    env,
    stdio: options.verbose ? 'inherit' : 'pipe',
  });
  processes.push(backend);

  // Log stderr even in non-verbose mode
  if (!options.verbose && backend.stderr) {
    backend.stderr.on('data', (data: Buffer) => {
      console.error(chalk.red(`  [backend] ${data.toString().trim()}`));
    });
  }

  // Wait for backend to be ready
  try {
    await waitForPort(backendPort, options.host);
    console.log(chalk.green(`  ✓ Backend ready on port ${backendPort}`));
  } catch {
    console.error(chalk.red(`\n  ✗ Backend failed to start on port ${backendPort}`));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
    process.exit(1);
  }

  console.log(chalk.blue('  🎨 Starting frontend (production mode)...'));

  // Next.js standalone server
  const standaloneServer = join(nextStandalone, 'server.js');
  const frontend = spawn('node', [standaloneServer], {
    cwd: PROJECT_ROOT,
    env: {
      ...env,
      PORT: frontendPort.toString(),
      HOSTNAME: options.host,
    },
    stdio: options.verbose ? 'inherit' : 'pipe',
  });
  processes.push(frontend);

  // Log stderr even in non-verbose mode
  if (!options.verbose && frontend.stderr) {
    frontend.stderr.on('data', (data: Buffer) => {
      console.error(chalk.red(`  [frontend] ${data.toString().trim()}`));
    });
  }

  // Wait for frontend to be ready
  try {
    await waitForPort(frontendPort, options.host);
    console.log(chalk.green(`  ✓ Frontend ready on port ${frontendPort}`));
  } catch {
    console.error(chalk.red(`\n  ✗ Frontend failed to start on port ${frontendPort}`));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
    process.exit(1);
  }

  // Call onReady callback (opens browser, shows final status)
  await onReady();

  // Wait for either process to exit with error handling
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      backend.on('exit', (code) => {
        // Resolve cleanly during shutdown, reject on unexpected exit
        if (shutdownState.shuttingDown) {
          resolve();
        } else if (code !== 0) {
          reject(new Error(`Backend exited with code ${code}`));
        }
      });
    }),
    new Promise<void>((resolve, reject) => {
      frontend.on('exit', (code) => {
        // Resolve cleanly during shutdown, reject on unexpected exit
        if (shutdownState.shuttingDown) {
          resolve();
        } else if (code !== 0) {
          reject(new Error(`Frontend exited with code ${code}`));
        }
      });
    }),
  ]).catch((error) => {
    console.error(chalk.red(`\n  ✗ ${error.message}`));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
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

    // Run tsc-alias to resolve path aliases
    const tscAlias = spawn('npx', ['tsc-alias', '-p', 'tsconfig.backend.json'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });

    exitCode = await new Promise<number>((resolve) => {
      tscAlias.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      console.error(chalk.red('Backend path alias resolution failed'));
      process.exit(exitCode);
    }

    console.log(chalk.green('  ✓ Backend built'));
    console.log(chalk.blue('Building frontend...'));

    // Build Next.js frontend
    const nextBuild = spawn('npx', ['next', 'build'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });

    exitCode = await new Promise<number>((resolve) => {
      nextBuild.on('exit', (code) => resolve(code ?? 1));
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
