import { exec } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import treeKill from 'tree-kill';

const execPromise = promisify(exec);

export function ensureDataDir(databasePath: string): void {
  const dir = dirname(databasePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function treeKillAsync(pid: number, signal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, signal, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function waitForPort(
  port: number,
  host = 'localhost',
  timeoutMs = 30_000,
  intervalMs = 500
): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ port, host }, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', () => {
          socket.destroy();
          reject(new Error('not ready'));
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(`Timed out waiting for port ${port} after ${timeoutMs}ms`);
}

async function isPortInUse(port: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execPromise(`lsof -i :${port} -sTCP:LISTEN -t`, {
        timeout: 2000,
      });
      return stdout.trim().length > 0;
    } catch (error) {
      if ((error as { code?: number }).code === 1) {
        return false;
      }
    }
  }

  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(true);
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port);
  });
}

export interface FindAvailablePortOptions {
  excludePorts?: number[];
  maxAttempts?: number;
}

export async function findAvailablePort(
  startPort: number,
  options: FindAvailablePortOptions = {}
): Promise<number> {
  const { maxAttempts = 10, excludePorts = [] } = options;
  for (let i = 0; i < maxAttempts; i += 1) {
    const port = startPort + i;
    if (excludePorts.includes(port)) {
      continue;
    }
    if (!(await isPortInUse(port))) {
      return port;
    }
  }

  throw new Error(`Could not find an available port starting from ${startPort}`);
}
