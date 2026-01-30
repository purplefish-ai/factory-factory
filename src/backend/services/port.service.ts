/**
 * Port Service
 *
 * Provides utilities for checking port availability and finding available ports.
 */

import { createServer as createNetServer } from 'node:net';
import { createLogger } from './logger.service';

const logger = createLogger('port-service');

/**
 * Check if a port is available by attempting to create a server on it.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createNetServer();
    testServer.once('error', () => {
      resolve(false);
    });
    testServer.once('listening', () => {
      testServer.close(() => resolve(true));
    });
    testServer.listen(port, 'localhost');
  });
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
