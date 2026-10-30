import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortAllocationService } from './port-allocation.service';

function listenOnLoopback(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('unexpected address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

describe('PortAllocationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isPortInUse', () => {
    const servers: Server[] = [];

    afterEach(async () => {
      await Promise.all(
        servers
          .splice(0)
          .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      );
    });

    it('reports a port as in use while another listener is bound to 127.0.0.1', async () => {
      // Dev servers commonly bind loopback only. On macOS a wildcard bind probe
      // still succeeds in that case, so the probe must not rely on it alone.
      const { server, port } = await listenOnLoopback();
      servers.push(server);

      await expect(PortAllocationService.isPortInUse(port)).resolves.toBe(true);
    });
  });

  describe('findFreePort', () => {
    it('scans the full range from a randomized starting offset', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const isPortInUse = vi
        .spyOn(PortAllocationService, 'isPortInUse')
        .mockImplementation(async (port) => port !== 4001);

      await expect(PortAllocationService.findFreePort(4000, 4003)).resolves.toBe(4001);
      expect(isPortInUse.mock.calls.map(([port]) => port)).toEqual([4002, 4003, 4000, 4001]);
    });

    it('does not give up before checking every candidate port', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const isPortInUse = vi
        .spyOn(PortAllocationService, 'isPortInUse')
        .mockImplementation(async (port) => port !== 3002);

      await expect(PortAllocationService.findFreePort(3000, 3002)).resolves.toBe(3002);
      expect(isPortInUse.mock.calls.map(([port]) => port)).toEqual([3000, 3001, 3002]);
    });

    it('throws only after exhausting the full range', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.8);
      const isPortInUse = vi.spyOn(PortAllocationService, 'isPortInUse').mockResolvedValue(true);

      await expect(PortAllocationService.findFreePort(5000, 5002)).rejects.toThrow(
        'Could not find free port in range 5000-5002'
      );
      expect(isPortInUse.mock.calls.map(([port]) => port)).toEqual([5002, 5000, 5001]);
    });

    it('rejects invalid ranges before probing ports', async () => {
      const isPortInUse = vi.spyOn(PortAllocationService, 'isPortInUse');

      await expect(PortAllocationService.findFreePort(6001, 6000)).rejects.toThrow(
        'Invalid port range 6001-6000'
      );
      expect(isPortInUse).not.toHaveBeenCalled();
    });

    it('rejects ports outside the valid TCP range before probing ports', async () => {
      const isPortInUse = vi.spyOn(PortAllocationService, 'isPortInUse');

      await expect(PortAllocationService.findFreePort(0, 1)).rejects.toThrow(
        'Invalid port range 0-1'
      );
      await expect(PortAllocationService.findFreePort(65_535, 65_536)).rejects.toThrow(
        'Invalid port range 65535-65536'
      );
      expect(isPortInUse).not.toHaveBeenCalled();
    });
  });
});
