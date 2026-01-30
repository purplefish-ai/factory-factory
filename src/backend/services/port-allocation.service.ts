import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Service for finding and allocating free network ports
 */
export class PortAllocationService {
  private static readonly DEFAULT_START_PORT = 3000;
  private static readonly DEFAULT_END_PORT = 9999;
  private static readonly MAX_ATTEMPTS = 100;

  /**
   * Check if a port is in use using lsof
   * @param port - Port number to check
   * @returns true if port is in use, false if available
   */
  static async isPortInUse(port: number): Promise<boolean> {
    try {
      // lsof -i :PORT returns exit code 0 if something is listening
      await execAsync(`lsof -i :${port}`);
      return true;
    } catch {
      // lsof returns non-zero exit code if nothing is listening
      return false;
    }
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
