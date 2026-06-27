import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortAllocationService } from './port-allocation.service';

describe('PortAllocationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
  });
});
