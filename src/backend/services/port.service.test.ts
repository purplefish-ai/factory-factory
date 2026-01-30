import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the service
const mockServer = {
  once: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
};

const mockCreateNetServer = vi.fn(() => mockServer);
const mockExec = vi.fn();

vi.mock('node:net', () => ({
  createServer: () => mockCreateNetServer(),
}));

vi.mock('node:child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
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
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    mockServer.once.mockReset();
    mockServer.listen.mockReset();
    mockServer.close.mockReset();
    mockExec.mockReset();
  });

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  });

  describe('isPortAvailable', () => {
    it('should return true when port is available (lsof on Unix)', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      // Mock lsof returning no output (port free)
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await isPortAvailable(3000);

      expect(result).toBe(true);
      expect(mockExec).toHaveBeenCalledWith('lsof -i :3000 -sTCP:LISTEN -t', {
        timeout: 2000,
      });
    });

    it('should return false when port is in use (lsof on Unix)', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      // Mock lsof returning PID (port in use)
      mockExec.mockResolvedValue({ stdout: '12345\n', stderr: '' });

      const result = await isPortAvailable(3000);

      expect(result).toBe(false);
    });

    it('should fall back to bind test when lsof fails', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      // Mock lsof throwing error (not installed)
      mockExec.mockRejectedValue(new Error('lsof: command not found'));

      // Simulate successful server listening (port available)
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        if (event === 'listening') {
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });
      mockServer.close.mockImplementation((callback: () => void) => {
        callback();
      });

      const result = await isPortAvailable(3000);

      expect(result).toBe(true);
      expect(mockServer.listen).toHaveBeenCalledWith(3000);
    });

    it('should use bind test on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      // Simulate successful server listening
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        if (event === 'listening') {
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });
      mockServer.close.mockImplementation((callback: () => void) => {
        callback();
      });

      const result = await isPortAvailable(3000);

      expect(result).toBe(true);
      expect(mockExec).not.toHaveBeenCalled(); // Should not try lsof on Windows
      expect(mockServer.listen).toHaveBeenCalledWith(3000);
    });

    it('should return false when bind test fails', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      // Simulate error (port in use)
      mockServer.once.mockImplementation((event: string, callback: () => void) => {
        if (event === 'error') {
          setTimeout(() => callback(), 0);
        }
        return mockServer;
      });

      const result = await isPortAvailable(3000);

      expect(result).toBe(false);
      expect(mockServer.listen).toHaveBeenCalledWith(3000);
    });
  });

  describe('findAvailablePort', () => {
    it('should return the start port if it is available', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      // Mock lsof returning no output (port free)
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await findAvailablePort(3000);

      expect(result).toBe(3000);
    });

    it('should skip unavailable ports and return first available', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      let callCount = 0;

      // Simulate: ports 3000, 3001, 3002 are in use; 3003 is available
      mockExec.mockImplementation(() => {
        const currentPort = 3000 + callCount;
        callCount++;

        if (currentPort < 3003) {
          // Ports 3000-3002 are in use
          return Promise.resolve({ stdout: '12345\n', stderr: '' });
        }
        // Port 3003 is available
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const result = await findAvailablePort(3000);

      expect(result).toBe(3003);
    });

    it('should throw error after maxAttempts exhausted', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      // Simulate all ports in use
      mockExec.mockResolvedValue({ stdout: '12345\n', stderr: '' });

      await expect(findAvailablePort(3000, 5)).rejects.toThrow(
        'Could not find an available port starting from 3000'
      );
    });

    it('should respect custom maxAttempts parameter', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      let attemptCount = 0;

      // Simulate all ports in use
      mockExec.mockImplementation(() => {
        attemptCount++;
        return Promise.resolve({ stdout: '12345\n', stderr: '' });
      });

      await expect(findAvailablePort(3000, 3)).rejects.toThrow();

      expect(attemptCount).toBe(3);
    });
  });
});
