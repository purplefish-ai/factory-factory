#!/usr/bin/env node

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command } from 'commander';

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

interface ServeOptions {
  port: string;
  backendPort: string;
  databaseUrl?: string;
  host: string;
  dev?: boolean;
}

interface MigrateOptions {
  databaseUrl?: string;
}

const program = new Command();

program
  .name('ff')
  .description('FactoryFactory - Workspace-based coding environment')
  .version(getVersion());

// ============================================================================
// serve command
// ============================================================================

program
  .command('serve')
  .description('Start the FactoryFactory server')
  .option('-p, --port <port>', 'Frontend port', '3000')
  .option('--backend-port <port>', 'Backend port', '3001')
  .option('-d, --database-url <url>', 'PostgreSQL connection URL (or set DATABASE_URL env)')
  .option('--host <host>', 'Host to bind to', 'localhost')
  .option('--dev', 'Run in development mode with hot reloading')
  .action(async (options: ServeOptions) => {
    const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;

    if (!databaseUrl) {
      console.error(chalk.red('Error: Database URL is required'));
      console.error(
        chalk.yellow('Provide it via --database-url or DATABASE_URL environment variable')
      );
      console.error(chalk.gray('\nExample:'));
      console.error(
        chalk.gray('  ff serve --database-url postgresql://user:pass@localhost:5432/factoryfactory')
      );
      console.error(chalk.gray('  DATABASE_URL=postgresql://... ff serve'));
      process.exit(1);
    }

    console.log(chalk.cyan('\n  FactoryFactory'));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log(chalk.gray(`  Frontend:  http://${options.host}:${options.port}`));
    console.log(chalk.gray(`  Backend:   http://${options.host}:${options.backendPort}`));
    console.log(chalk.gray(`  Mode:      ${options.dev ? 'development' : 'production'}`));
    console.log(chalk.gray('  ─────────────────────────────────────\n'));

    // Set environment variables
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      FRONTEND_PORT: options.port,
      BACKEND_PORT: options.backendPort,
      NEXT_PUBLIC_BACKEND_PORT: options.backendPort,
      NODE_ENV: options.dev ? 'development' : 'production',
    };

    const processes: ChildProcess[] = [];

    // Handle shutdown
    const shutdown = (signal: string) => {
      console.log(chalk.yellow(`\n${signal} received, shutting down...`));
      for (const proc of processes) {
        proc.kill('SIGTERM');
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    if (options.dev) {
      // Development mode - use tsx watch for backend, next dev for frontend
      await startDevelopmentMode(options, env, processes);
    } else {
      // Production mode - use compiled backend and next start
      await startProductionMode(options, env, processes);
    }
  });

async function startDevelopmentMode(
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
  processes: ChildProcess[]
): Promise<void> {
  // Note: This does not start Inngest. For full development with Inngest,
  // use `pnpm dev:all` instead, or start Inngest separately with `pnpm inngest:dev`.
  console.log(chalk.blue('Starting backend (development mode)...'));

  const backend = spawn('npx', ['tsx', 'watch', 'src/backend/index.ts'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });
  processes.push(backend);

  // Wait for backend to be ready
  const backendPort = Number.parseInt(options.backendPort, 10);
  try {
    await waitForPort(backendPort, options.host);
  } catch {
    console.error(chalk.red(`Backend failed to start on port ${backendPort}`));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
    process.exit(1);
  }

  console.log(chalk.blue('Starting frontend (development mode)...'));

  const frontend = spawn('npx', ['next', 'dev', '-p', options.port], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });
  processes.push(frontend);

  // Wait for either process to exit
  await Promise.race([
    new Promise<void>((_, reject) => {
      backend.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Backend exited with code ${code}`));
        }
      });
    }),
    new Promise<void>((_, reject) => {
      frontend.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Frontend exited with code ${code}`));
        }
      });
    }),
  ]).catch((error) => {
    console.error(chalk.red(error.message));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
    process.exit(1);
  });
}

async function startProductionMode(
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
  processes: ChildProcess[]
): Promise<void> {
  // Check if built
  const nextStandalone = join(PROJECT_ROOT, '.next', 'standalone');
  const backendDist = join(PROJECT_ROOT, 'dist', 'backend', 'index.js');

  if (!existsSync(nextStandalone)) {
    console.error(chalk.red('Error: Frontend not built. Run `pnpm build:frontend` first.'));
    console.error(chalk.gray('Or use --dev flag for development mode.'));
    process.exit(1);
  }

  if (!existsSync(backendDist)) {
    console.error(chalk.red('Error: Backend not built. Run `pnpm build:backend` first.'));
    console.error(chalk.gray('Or use --dev flag for development mode.'));
    process.exit(1);
  }

  console.log(chalk.blue('Starting backend (production mode)...'));

  const backend = spawn('node', [backendDist], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });
  processes.push(backend);

  // Wait for backend to be ready
  const backendPort = Number.parseInt(options.backendPort, 10);
  try {
    await waitForPort(backendPort, options.host);
  } catch {
    console.error(chalk.red(`Backend failed to start on port ${backendPort}`));
    for (const proc of processes) {
      proc.kill('SIGTERM');
    }
    process.exit(1);
  }

  console.log(chalk.blue('Starting frontend (production mode)...'));

  // Next.js standalone server
  const standaloneServer = join(nextStandalone, 'server.js');
  const frontend = spawn('node', [standaloneServer], {
    cwd: PROJECT_ROOT,
    env: {
      ...env,
      PORT: options.port,
      HOSTNAME: options.host,
    },
    stdio: 'inherit',
  });
  processes.push(frontend);

  // Wait for either process to exit with error handling
  await Promise.race([
    new Promise<void>((_, reject) => {
      backend.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Backend exited with code ${code}`));
        }
      });
    }),
    new Promise<void>((_, reject) => {
      frontend.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Frontend exited with code ${code}`));
        }
      });
    }),
  ]).catch((error) => {
    console.error(chalk.red(error.message));
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
  .option('-d, --database-url <url>', 'PostgreSQL connection URL (or set DATABASE_URL env)')
  .action(async (options: MigrateOptions) => {
    const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;

    if (!databaseUrl) {
      console.error(chalk.red('Error: Database URL is required'));
      console.error(
        chalk.yellow('Provide it via --database-url or DATABASE_URL environment variable')
      );
      process.exit(1);
    }

    console.log(chalk.blue('Running database migrations...'));

    const migrate = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
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
  .option('-d, --database-url <url>', 'PostgreSQL connection URL (or set DATABASE_URL env)')
  .action(async (options: MigrateOptions) => {
    const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;

    if (!databaseUrl) {
      console.error(chalk.red('Error: Database URL is required'));
      process.exit(1);
    }

    console.log(chalk.blue('Opening Prisma Studio...'));

    const studio = spawn('npx', ['prisma', 'studio'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
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

    const buildBackend = spawn('npx', ['pnpm', 'build:backend'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });

    let exitCode = await new Promise<number>((resolve) => {
      buildBackend.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      console.error(chalk.red('Backend build failed'));
      process.exit(exitCode);
    }

    console.log(chalk.blue('Building frontend...'));

    const buildFrontend = spawn('npx', ['pnpm', 'build:frontend'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });

    exitCode = await new Promise<number>((resolve) => {
      buildFrontend.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      console.error(chalk.red('Frontend build failed'));
      process.exit(exitCode);
    }

    console.log(chalk.green('\nBuild completed successfully!'));
    console.log(chalk.gray('Run `ff serve` to start the production server'));
  });

// ============================================================================
// Parse and run
// ============================================================================

program.parse();
