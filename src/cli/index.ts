#!/usr/bin/env node

import './serve-node-check';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command } from 'commander';
import { config } from 'dotenv';
import open from 'open';
import { runMigrations as runDbMigrations } from '@/backend/migrate';
import { getCurrentProcessEnv, getLogFilePath } from '@/backend/services/logger.service';
import { registerApplicationServerMarker } from './application-server-marker';
import { ApplicationUpdateInstaller } from './application-update-installer';
import { recoverInterruptedApplicationUpdate } from './application-update-recovery';
import { registerBuildCommand } from './build-command';
import { registerClaudeCommand } from './claude';
import { registerCodexCommand } from './codex';
import { resolveDatabasePath } from './database-path';
import { runProxyCommand } from './proxy';
import { ensureDataDir, findAvailablePort } from './runtime-utils';
import { buildHttpOrigin, buildServeEnv } from './serve-env';
import { checkServePrerequisites } from './serve-prerequisites';
import { registerServeShutdownHandlers, removeServePortFile } from './serve-shutdown';
import { ensureServeTools } from './setup-prerequisites.mjs';
import { registerStudioCommand } from './studio';
import { runSupervisedServeSession } from './supervised-serve-session';
import { registerTailscaleCommand } from './tailscale';

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
      const backendPort = await findAvailablePort(requestedBackendPort);
      const frontendPort = await findAvailablePort(requestedFrontendPort, {
        maxAttempts: 20,
        excludePorts: [backendPort],
      });

      if (frontendPort !== requestedFrontendPort || backendPort !== requestedBackendPort) {
        console.log(
          chalk.yellow(
            `  ⚠ Requested ports in use, using Frontend: ${frontendPort}, Backend: ${backendPort}`
          )
        );
      }

      return { frontendPort, backendPort };
    }

    const frontendPort = await findAvailablePort(requestedFrontendPort);
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

function printReadyBanner(opts: {
  isDev: boolean;
  host: string;
  frontendPort: number;
  backendPort: number;
  databasePath: string;
}): void {
  console.log(chalk.gray('\n  ─────────────────────────────────────'));
  if (opts.isDev) {
    console.log(chalk.gray(`  Frontend:  ${buildHttpOrigin(opts.host, opts.frontendPort)}`));
    console.log(chalk.gray(`  Backend:   ${buildHttpOrigin(opts.host, opts.backendPort)}`));
  } else {
    console.log(chalk.gray(`  Server:    ${buildHttpOrigin(opts.host, opts.backendPort)}`));
  }
  console.log(chalk.gray(`  Database:  ${opts.databasePath}`));
  console.log(chalk.gray(`  Mode:      ${opts.isDev ? 'development' : 'production'}`));
  console.log(chalk.gray(`  Logs:      ${getLogFilePath()}`));
  console.log(chalk.gray('  ─────────────────────────────────────'));
}

function requireServePrerequisites(dev: boolean): boolean {
  const issues = checkServePrerequisites(PROJECT_ROOT, dev);
  if (issues.length === 0) {
    return true;
  }
  console.error(chalk.red('  Cannot start Factory Factory. Fix the following prerequisites:\n'));
  for (const issue of issues) {
    console.error(`  • ${issue}\n`);
  }
  process.exitCode = 1;
  return false;
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

    const databasePath = resolveDatabasePath({ databasePath: options.databasePath });

    // Show startup banner
    console.log(chalk.cyan(`\n  🏭🏭 FACTORY ${chalk.bold('FACTORY')}\n`));

    if (!(await ensureServeTools())) {
      process.exitCode = 1;
      return;
    }
    if (!requireServePrerequisites(!!options.dev)) {
      return;
    }

    // Ensure data directory exists
    if (verbose) {
      console.log(chalk.gray('  Ensuring data directory exists...'));
    }
    ensureDataDir(databasePath);

    const { frontendPort, backendPort } = await resolvePortsOrExit(options, verbose);
    let releaseRunningMarker: (() => void) | undefined;
    if (
      !options.dev &&
      (await new ApplicationUpdateInstaller({
        packageRoot: PROJECT_ROOT,
        env: getCurrentProcessEnv(),
      }).isSupported())
    ) {
      releaseRunningMarker = registerApplicationServerMarker(
        join(dirname(PROJECT_ROOT), `.factory-factory-running-${process.pid}`)
      );
    }
    try {
      if (!options.dev && (await recoverInterruptedApplicationUpdate(PROJECT_ROOT, databasePath))) {
        releaseRunningMarker?.();
        const restarted = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit' });
        process.exit(restarted.status ?? 1);
      }
      await runMigrationsOrExit(databasePath, verbose);
    } catch (error) {
      releaseRunningMarker?.();
      console.error(chalk.red(`\n  ✗ ${error instanceof Error ? error.message : String(error)}`));
      process.exitCode = 1;
      return;
    }

    const env = buildServeEnv(options, databasePath, frontendPort, backendPort);

    const controller = new AbortController();
    const portFilePath = join(process.cwd(), '.factory-factory-port');

    const unregisterShutdownHandlers = registerServeShutdownHandlers(controller, portFilePath);

    const createOnReady = (actualBackendPort: number) => async () => {
      const url = buildHttpOrigin(options.host, options.dev ? frontendPort : actualBackendPort);

      printReadyBanner({
        isDev: !!options.dev,
        host: options.host,
        frontendPort,
        backendPort: actualBackendPort,
        databasePath,
      });
      console.log(chalk.bold.green(`\n  ✅ Ready at ${chalk.cyan(url)}\n`));
      console.log(chalk.dim('  Press Ctrl+C to stop\n'));

      // Write port file so postRun scripts can discover the frontend port
      writeFileSync(portFilePath, frontendPort.toString(), 'utf-8');

      if (shouldOpen) {
        try {
          await open(url);
        } catch (error) {
          console.log(chalk.yellow(`  ⚠ Could not open browser: ${(error as Error).message}`));
        }
      }
    };

    try {
      await runSupervisedServeSession({
        databasePath,
        projectRoot: PROJECT_ROOT,
        env,
        host: options.host,
        frontendPort,
        backendPort,
        dev: options.dev,
        verbose,
        signal: controller.signal,
        onReady: createOnReady(backendPort),
      });
    } catch (error) {
      console.error(chalk.red(`\n  ✗ ${(error as Error).message}`));
      process.exitCode = 1;
    } finally {
      unregisterShutdownHandlers();
      removeServePortFile(portFilePath);
      releaseRunningMarker?.();
    }
  });

// ============================================================================
// db:migrate command
// ============================================================================

program
  .command('db:migrate')
  .description('Run database migrations')
  .option('-d, --database-path <path>', 'SQLite database file path (or set DATABASE_PATH env)')
  .action((options: MigrateOptions) => {
    const effectivePath = resolveDatabasePath({ databasePath: options.databasePath });

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

registerStudioCommand(program, PROJECT_ROOT);

// ============================================================================
// build command
// ============================================================================

registerBuildCommand(program, PROJECT_ROOT);

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

// Run native CLI commands using the same provider runtimes bundled with ACP.
registerClaudeCommand(program);
registerCodexCommand(program);
registerTailscaleCommand(program, PROJECT_ROOT);

// ============================================================================
// Parse and run
// ============================================================================

program.parse();
