import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * ServerManager handles the lifecycle of the backend server process
 * for the Electron application.
 */
export class ServerManager {
  private backendProcess: ChildProcess | null = null;

  /**
   * Start the backend server.
   * - In dev mode with Vite, returns Vite dev server URL
   * - In production, spawns backend process and manages its lifecycle
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

    // Production mode: spawn our own backend
    // Database path - use Electron's userData directory
    const userDataPath = app.getPath('userData');
    const databasePath = join(userDataPath, 'data.db');

    // Ensure data directory exists
    this.ensureDataDir(databasePath);

    // Find available port starting from 3001
    const port = await this.findAvailablePort(3001);

    // Get paths for production build
    // Child processes can't read from asar, so all paths must use unpacked resources
    const unpackedPath = this.getUnpackedResourcesPath();
    const frontendDist = join(unpackedPath, 'dist', 'client');
    const backendDist = join(unpackedPath, 'dist', 'src', 'backend', 'index.js');

    // Run database migrations
    await this.runMigrations(databasePath, unpackedPath);

    // Spawn backend process
    this.backendProcess = spawn('node', [backendDist], {
      cwd: unpackedPath,
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        FRONTEND_STATIC_PATH: frontendDist,
        BACKEND_PORT: port.toString(),
        NODE_ENV: 'production',
      },
      stdio: 'pipe',
    });

    // Handle process output
    this.backendProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[backend] ${data.toString().trim()}`);
    });

    this.backendProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[backend] ${data.toString().trim()}`);
    });

    this.backendProcess.on('error', (error) => {
      console.error(`[backend] Process error: ${error.message}`);
    });

    this.backendProcess.on('exit', (code) => {
      console.log(`[backend] Process exited with code ${code}`);
      this.backendProcess = null;
    });

    // Wait for health endpoint
    await this.waitForHealth(port);

    return `http://localhost:${port}`;
  }

  /**
   * Stop the backend server gracefully.
   */
  stop(): Promise<void> {
    const proc = this.backendProcess;
    if (!proc) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      // Force kill after 5 seconds if still running
      const forceKillTimeout = setTimeout(() => {
        if (this.backendProcess && !this.backendProcess.killed) {
          console.log('[backend] Force killing process');
          this.backendProcess.kill('SIGKILL');
        }
      }, 5000);

      // Set up exit handler
      proc.once('exit', () => {
        clearTimeout(forceKillTimeout);
        this.backendProcess = null;
        resolve();
      });

      // Send SIGTERM for graceful shutdown
      proc.kill('SIGTERM');
    });
  }

  /**
   * Get the resources path for files that need to be executed by child processes.
   * Child processes can't read from asar archives, so we unpack certain files.
   * In production, this points to app.asar.unpacked.
   * In development, this is the project root.
   */
  private getUnpackedResourcesPath(): string {
    if (app.isPackaged) {
      // Unpacked files are in app.asar.unpacked directory
      return join(process.resourcesPath, 'app.asar.unpacked');
    }
    // In development, use the project root
    // Compiled file is at electron/dist/electron/main/index.js
    return join(__dirname, '..', '..', '..', '..');
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
   * Check if a port is available.
   */
  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => {
        resolve(false);
      });
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, 'localhost');
    });
  }

  /**
   * Find an available port starting from the given port.
   */
  private async findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error(`Could not find an available port starting from ${startPort}`);
  }

  /**
   * Run database migrations using a separate script.
   * Spawns the migration script as a child process to use unpacked node_modules.
   */
  private runMigrations(databasePath: string, unpackedPath: string): Promise<void> {
    console.log('[migrate] Running database migrations...');

    return new Promise((resolve, reject) => {
      // Migrations are in extraResources
      const migrationsPath = app.isPackaged
        ? join(process.resourcesPath, 'prisma', 'migrations')
        : join(unpackedPath, 'prisma', 'migrations');

      const migrateScript = join(unpackedPath, 'dist', 'src', 'backend', 'migrate.js');

      const migrate = spawn('node', [migrateScript], {
        cwd: unpackedPath,
        env: {
          ...process.env,
          DATABASE_PATH: databasePath,
          MIGRATIONS_PATH: migrationsPath,
        },
        stdio: 'pipe',
      });

      migrate.stdout?.on('data', (data: Buffer) => {
        console.log(`[migrate] ${data.toString().trim()}`);
      });

      migrate.stderr?.on('data', (data: Buffer) => {
        console.error(`[migrate] ${data.toString().trim()}`);
      });

      migrate.on('exit', (code) => {
        if (code === 0) {
          console.log('[migrate] Migrations complete');
          resolve();
        } else {
          reject(new Error(`Migration failed with exit code ${code}`));
        }
      });

      migrate.on('error', reject);
    });
  }

  /**
   * Wait for the backend health endpoint to respond.
   */
  private async waitForHealth(port: number, timeout = 30_000, interval = 500): Promise<void> {
    const startTime = Date.now();
    const healthUrl = `http://localhost:${port}/health`;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(healthUrl);
        if (response.ok) {
          console.log(`[backend] Health check passed on port ${port}`);
          return;
        }
      } catch {
        // Server not ready yet, continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`Backend health check timed out after ${timeout}ms`);
  }
}
