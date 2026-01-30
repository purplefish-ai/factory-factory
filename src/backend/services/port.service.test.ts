import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the service
const mockServer = {
  once: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
};

const mockCreateNetServer = vi.fn(() => mockServer);

vi.mock('node:net', () => ({
  createServer: () => mockCreateNetServer(),
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks are set up
import { findAvailablePort, isPortAvailable } from './port.service';

describe('port.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    mockServer.once.mockReset();
    mockServer.listen.mockReset();
    mockServer.close.mockReset();
  });

  describe('isPortAvailable', () => {
    it('should return true when port is available', async () => {
      // Simulate successful server listening
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        if (event === 'listening') {
          // Trigger listening event asynchronously
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });
      mockServer.close.mockImplementation((callback: () => void) => {
        callback();
      });

      const result = await isPortAvailable(3000);

      expect(result).toBe(true);
      expect(mockServer.listen).toHaveBeenCalledWith(3000, 'localhost');
      expect(mockServer.close).toHaveBeenCalled();
    });

    it('should return false when port is in use', async () => {
      // Simulate error (port in use)
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        if (event === 'error') {
          // Trigger error event asynchronously
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });

      const result = await isPortAvailable(3000);

      expect(result).toBe(false);
      expect(mockServer.listen).toHaveBeenCalledWith(3000, 'localhost');
    });
  });

  describe('findAvailablePort', () => {
    it('should return the start port if it is available', async () => {
      // Simulate port available
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        if (event === 'listening') {
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });
      mockServer.close.mockImplementation((callback: () => void) => {
        callback();
      });

      const result = await findAvailablePort(3000);

      expect(result).toBe(3000);
    });

    it('should skip unavailable ports and return first available', async () => {
      let callCount = 0;

      // Simulate: ports 3000, 3001, 3002 are in use; 3003 is available
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        const currentCall = callCount;
        if (currentCall < 3) {
          // First 3 ports are in use
          if (event === 'error') {
            setTimeout(() => callback(), 0);
          }
        } else if (event === 'listening') {
          // Port 3003 is available
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });
      mockServer.listen.mockImplementation(() => {
        callCount++;
      });
      mockServer.close.mockImplementation((callback: () => void) => {
        callback();
      });

      const result = await findAvailablePort(3000);

      expect(result).toBe(3003);
    });

    it('should throw error after maxAttempts exhausted', async () => {
      // Simulate all ports in use
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        if (event === 'error') {
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });

      await expect(findAvailablePort(3000, 5)).rejects.toThrow(
        'Could not find an available port starting from 3000'
      );
    });

    it('should respect custom maxAttempts parameter', async () => {
      let attemptCount = 0;

      // Simulate all ports in use
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        if (event === 'error') {
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });
      mockServer.listen.mockImplementation(() => {
        attemptCount++;
      });

      await expect(findAvailablePort(3000, 3)).rejects.toThrow();

      expect(attemptCount).toBe(3);
    });
  });
});
