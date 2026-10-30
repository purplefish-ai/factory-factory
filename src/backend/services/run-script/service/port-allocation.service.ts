import { createServer } from 'node:net';

/**
 * Service for finding and allocating free network ports
 */
export class PortAllocationService {
  private static readonly MIN_PORT = 1;
  private static readonly MAX_PORT = 65_535;
  private static readonly DEFAULT_START_PORT = 3000;
  private static readonly DEFAULT_END_PORT = 9999;

  /**
   * Bind targets probed for each port: the wildcard address, then IPv4 and
   * IPv6 loopback. On macOS a wildcard bind succeeds even while another
   * process listens on a loopback address, which is where dev servers usually
   * bind, so loopback must be probed explicitly.
   */
  private static readonly PROBE_HOSTS: readonly (string | undefined)[] = [
    undefined,
    '127.0.0.1',
    '::1',
  ];

  /**
   * Check whether a port can be bound on one address.
   * @param port - Port number to check
   * @param host - Address to bind, or undefined for the wildcard address
   * @returns true if the bind succeeds or the address family is unavailable
   */
  static canBind(port: number, host?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();

      server.once('error', (err: NodeJS.ErrnoException) => {
        // An address this host lacks (e.g. ::1 without IPv6) cannot hold a
        // conflicting listener. Other errors (EADDRINUSE, EACCES) mean unusable.
        resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT');
      });

      server.once('listening', () => {
        server.close(() => resolve(true));
      });

      server.listen({ port, host });
    });
  }

  /**
   * Check if a port is in use by attempting to bind it on every probe address.
   * Binding in-process keeps each probe cheap and also sees listeners owned by
   * other users.
   * @param port - Port number to check
   * @returns true if port is in use, false if available
   */
  static async isPortInUse(port: number): Promise<boolean> {
    for (const host of PortAllocationService.PROBE_HOSTS) {
      if (!(await PortAllocationService.canBind(port, host))) {
        return true;
      }
    }
    return false;
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
