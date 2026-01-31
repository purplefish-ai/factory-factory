import { createServer } from 'node:net';

/**
 * Service for finding and allocating free network ports
 */
export class PortAllocationService {
  private static readonly DEFAULT_START_PORT = 3000;
  private static readonly DEFAULT_END_PORT = 9999;
  private static readonly MAX_ATTEMPTS = 100;

  /**
   * Check if a port is in use by attempting to bind to it
   * Cross-platform compatible (works on Windows, macOS, Linux)
   * @param port - Port number to check
   * @returns true if port is in use, false if available
   */
  static isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true);
        } else {
          // For other errors (like EACCES), treat as unavailable
          resolve(true);
        }
      });

      server.once('listening', () => {
        server.close();
        resolve(false);
      });

      server.listen(port);
    });
  }

  /**
   * Find an available port in the specified range
   * @param startPort - Start of port range (default: 3000)
   * @param endPort - End of port range (default: 9999)
   * @returns Available port number
   * @throws Error if no free port found after MAX_ATTEMPTS attempts
   */
  static async findFreePort(
    startPort = PortAllocationService.DEFAULT_START_PORT,
    endPort = PortAllocationService.DEFAULT_END_PORT
  ): Promise<number> {
    const range = endPort - startPort + 1;

    for (let attempt = 0; attempt < PortAllocationService.MAX_ATTEMPTS; attempt++) {
      // Pick a random port in range to reduce collisions
      const port = startPort + Math.floor(Math.random() * range);

      const inUse = await PortAllocationService.isPortInUse(port);
      if (!inUse) {
        return port;
      }
    }

    throw new Error(
      `Could not find free port after ${PortAllocationService.MAX_ATTEMPTS} attempts in range ${startPort}-${endPort}`
    );
  }
}
