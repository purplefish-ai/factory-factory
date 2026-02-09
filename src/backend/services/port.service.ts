/**
 * Port Service
 *
 * Provides utilities for checking port availability and finding available ports.
 */

import { exec } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { promisify } from 'node:util';
import { SERVICE_TIMEOUT_MS } from './constants';
import { createLogger } from './logger.service';

const logger = createLogger('port-service');
const execAsync = promisify(exec);

/**
 * Check if a port is in use by checking actual listening processes.
 * Uses lsof on Unix systems for more reliable detection.
 * Falls back to bind attempt if lsof is unavailable.
 */
async function isPortInUse(port: number): Promise<boolean> {
  // Try lsof first (more reliable, checks actual listening processes)
  if (process.platform !== 'win32') {
    try {
      // lsof -i :PORT -sTCP:LISTEN checks for processes listening on the port
      // -t returns just PIDs (suppresses errors if no process found)
      const { stdout } = await execAsync(`lsof -i :${port} -sTCP:LISTEN -t`, {
        timeout: SERVICE_TIMEOUT_MS.portLsof,
      });
      // If we get output, port is in use
      return stdout.trim().length > 0;
    } catch (error) {
      // lsof exits with code 1 if no process found (port is free)
      // Also catches if lsof is not installed
      if ((error as { code?: number }).code === 1) {
        return false;
      }
      // lsof not available or error - fall back to bind attempt
      logger.debug('lsof check failed, falling back to bind attempt', { error });
    }
  }

  // Fallback: try to bind to the port
  return new Promise((resolve) => {
    const testServer = createNetServer();
    testServer.once('error', () => {
      resolve(true); // Error means port is in use
    });
    testServer.once('listening', () => {
      testServer.close(() => resolve(false)); // Successfully bound means port is free
    });
    testServer.listen(port);
  });
}

/**
 * Check if a port is available (inverse of isPortInUse for API compatibility).
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return !(await isPortInUse(port));
}

/**
 * Find an available port starting from the given port.
 */
export async function findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      if (i > 0) {
        logger.info('Found available port', { startPort, foundPort: port, attempts: i + 1 });
      }
      return port;
    }
  }
  throw new Error(`Could not find an available port starting from ${startPort}`);
}
