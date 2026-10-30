import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortAllocationService } from './port-allocation.service';

function listen(host: string, port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('unexpected address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe('PortAllocationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isPortInUse', () => {
    const servers: Server[] = [];

    afterEach(async () => {
      await Promise.all(servers.splice(0).map(closeServer));
    });

    it('probes the wildcard address and both loopback addresses', async () => {
      const canBind = vi.spyOn(PortAllocationService, 'canBind').mockResolvedValue(true);

      await expect(PortAllocationService.isPortInUse(4321)).resolves.toBe(false);
      expect(canBind.mock.calls).toEqual([
        [4321, undefined],
        [4321, '127.0.0.1'],
        [4321, '::1'],
      ]);
    });

    it('reports a port as in use when only a loopback bind fails', async () => {
      // On macOS a wildcard bind succeeds even while another process listens
      // on 127.0.0.1, so a loopback conflict alone must mark the port in use.
      vi.spyOn(PortAllocationService, 'canBind').mockImplementation(
        async (_port, host) => host !== '127.0.0.1'
      );

      await expect(PortAllocationService.isPortInUse(4321)).resolves.toBe(true);
    });

    it('reports a port as in use while another listener is bound to 127.0.0.1', async () => {
      const { server, port } = await listen('127.0.0.1');
      servers.push(server);

      await expect(PortAllocationService.isPortInUse(port)).resolves.toBe(true);
    });

    it('reports a port as in use while another listener is bound to ::1', async (context) => {
      const listener = await listen('::1').catch(() => null);
      if (!listener) {
        context.skip('IPv6 loopback is unavailable');
        return;
      }
      servers.push(listener.server);

      await expect(PortAllocationService.isPortInUse(listener.port)).resolves.toBe(true);
    });

    it('reports a released port as free', async () => {
      const { server, port } = await listen('127.0.0.1');
      await closeServer(server);

      await expect(PortAllocationService.isPortInUse(port)).resolves.toBe(false);
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
