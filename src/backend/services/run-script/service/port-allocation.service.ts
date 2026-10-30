import { isPortAvailable } from '@/backend/services/port.service';

/**
 * Service for finding and allocating free network ports
 */
export class PortAllocationService {
  private static readonly MIN_PORT = 1;
  private static readonly MAX_PORT = 65_535;
  private static readonly DEFAULT_START_PORT = 3000;
  private static readonly DEFAULT_END_PORT = 9999;

  /**
   * Check if a port is in use. Delegates to the backend port probe, which
   * checks listening sockets with lsof before falling back to a bind attempt;
   * a wildcard bind alone succeeds on macOS even while another process listens
   * on 127.0.0.1.
   * @param port - Port number to check
   * @returns true if port is in use, false if available
   */
  static async isPortInUse(port: number): Promise<boolean> {
    return !(await isPortAvailable(port));
  }

  /**
   * Find an available port in the specified range
   * @param startPort - Start of port range (default: 3000)
   * @param endPort - End of port range (default: 9999)
   * @returns Available port number
   * @throws Error if no free port exists in the range
   */
  static async findFreePort(
    startPort = PortAllocationService.DEFAULT_START_PORT,
    endPort = PortAllocationService.DEFAULT_END_PORT
  ): Promise<number> {
    const range = endPort - startPort + 1;
    if (
      !(Number.isInteger(startPort) && Number.isInteger(endPort)) ||
      startPort < PortAllocationService.MIN_PORT ||
      endPort > PortAllocationService.MAX_PORT ||
      range <= 0
    ) {
      throw new Error(`Invalid port range ${startPort}-${endPort}`);
    }

    // Randomize the starting point to reduce collisions, then scan without replacement.
    const startOffset = Math.floor(Math.random() * range);

    for (let offset = 0; offset < range; offset++) {
      const port = startPort + ((startOffset + offset) % range);

      const inUse = await PortAllocationService.isPortInUse(port);
      if (!inUse) {
        return port;
      }
    }

    throw new Error(`Could not find free port in range ${startPort}-${endPort}`);
  }
}
