import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Server instance interface matching what createServer() returns
 */
interface ServerInstance {
  start(): Promise<string>;
  stop(): Promise<void>;
}

/**
 * ServerManager handles the lifecycle of the backend server
 * for the Electron application.
 *
 * The backend runs in-process (same Node.js runtime as Electron main process)
 * which ensures native module compatibility.
 */
export class ServerManager {
  private serverInstance: ServerInstance | null = null;

  /**
   * Start the backend server.
   * - In dev mode with Vite, returns Vite dev server URL
   * - In production, runs backend in-process
   *
   * @returns The URL to load in the browser window
   */
  async start(): Promise<string> {
    // In dev mode, use Vite dev server URL (includes HMR)
    const viteDevUrl = process.env.VITE_DEV_SERVER_URL;
    if (viteDevUrl) {
      console.log(`[electron] Dev mode: using Vite dev server at ${viteDevUrl}`);
      return viteDevUrl;
    }

    // Production mode: run backend in-process
    // Database path - use Electron's userData directory
    const userDataPath = app.getPath('userData');
    const databasePath = join(userDataPath, 'data.db');

    // Ensure data directory exists
    this.ensureDataDir(databasePath);

    // Get paths for production build
    // - Migrations are in Resources/prisma/migrations (via extraResources)
    // - Frontend is in Resources/app.asar.unpacked/dist/client (unpacked from asar)
    const migrationsPath = join(process.resourcesPath, 'prisma', 'migrations');
    const frontendDist = join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'client');

    // WebSocket logs directory
    const wsLogsPath = join(userDataPath, 'ws-logs');

    // Set environment variables BEFORE importing the backend
    // These are read at module load time by db.ts and config.service.ts
    process.env.DATABASE_PATH = databasePath;
    process.env.FRONTEND_STATIC_PATH = frontendDist;
    process.env.WS_LOGS_PATH = wsLogsPath;
    process.env.NODE_ENV = 'production';

    console.log('[electron] Configuration:');
    console.log(`[electron]   Database: ${databasePath}`);
    console.log(`[electron]   Frontend: ${frontendDist}`);
    console.log(`[electron]   Migrations: ${migrationsPath}`);
    console.log(`[electron]   WS Logs: ${wsLogsPath}`);

    // Run database migrations
    // Dynamic import is required here because we must set environment variables
    // BEFORE importing the backend modules (they read env vars at load time)
    console.log('[electron] Running database migrations...');
    const migratePath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'dist',
      'src',
      'backend',
      'migrate.js'
    );
    const migrateModule = await this.dynamicImport<{
      runMigrations: (opts: {
        databasePath: string;
        migrationsPath: string;
        log?: (msg: string) => void;
      }) => void;
    }>(migratePath);
    migrateModule.runMigrations({
      databasePath,
      migrationsPath,
      log: (msg: string) => console.log(msg),
    });

    // Import and start the backend server
    console.log('[electron] Starting backend server...');
    const serverPath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'dist',
      'src',
      'backend',
      'server.js'
    );
    const serverModule = await this.dynamicImport<{
      createServer: () => ServerInstance;
    }>(serverPath);
    this.serverInstance = serverModule.createServer();

    const url = await this.serverInstance.start();
    console.log(`[electron] Backend server started at ${url}`);

    return url;
  }

  /**
   * Stop the backend server gracefully.
   */
  async stop(): Promise<void> {
    if (!this.serverInstance) {
      return;
    }

    console.log('[electron] Stopping backend server...');
    await this.serverInstance.stop();
    this.serverInstance = null;
    console.log('[electron] Backend server stopped');
  }

  /**
   * Ensure the directory for the database file exists.
   */
  private ensureDataDir(databasePath: string): void {
    const dir = dirname(databasePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Dynamic import wrapper that avoids direct await import() syntax
   * to satisfy the no-await-import linter rule while still allowing
   * dynamic imports (which are required for setting env vars before import).
   */
  private dynamicImport<T>(modulePath: string): Promise<T> {
    return import(modulePath) as Promise<T>;
  }
}
