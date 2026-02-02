import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist the mock functions so they're available before the mock is evaluated
const mockGetWsLogsPath = vi.hoisted(() => vi.fn());
const mockIsDevelopment = vi.hoisted(() => vi.fn());
const mockCreateWriteStream = vi.hoisted(() => vi.fn());

// Mock config service before importing the service
vi.mock('./config.service', () => ({
  configService: {
    getWsLogsPath: mockGetWsLogsPath,
    isDevelopment: mockIsDevelopment,
  },
}));

// Mock logger before importing the service
vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  createWriteStream: mockCreateWriteStream,
}));

// Import after mocks are set up
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { SessionFileLogger } from './session-file-logger.service';

// Helper to create a mock WriteStream
function createMockStream() {
  const writtenData: string[] = [];
  const mockStream = {
    write: vi.fn((data: string) => {
      writtenData.push(data);
      return true; // Always return true to indicate buffer not full
    }),
    end: vi.fn((callback?: () => void) => {
      if (callback) {
        // Call callback asynchronously to match real behavior
        setImmediate(callback);
      }
    }),
    once: vi.fn(),
    writtenData,
  } as unknown as WriteStream & { writtenData: string[] };
  return mockStream;
}

describe('SessionFileLogger', () => {
  const defaultWsLogsPath = join(process.cwd(), '.context', 'ws-logs');
  let mockStream: ReturnType<typeof createMockStream>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default config mock - enable in tests (dev mode)
    mockIsDevelopment.mockReturnValue(true);
    mockGetWsLogsPath.mockReturnValue(defaultWsLogsPath);

    // Create fresh mock stream
    mockStream = createMockStream();
    mockCreateWriteStream.mockReturnValue(mockStream);

    // Default fs mocks
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(statSync).mockReturnValue({ mtimeMs: Date.now() } as ReturnType<typeof statSync>);
    vi.mocked(unlinkSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create log directory if it does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      new SessionFileLogger();

      expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('ws-logs'), {
        recursive: true,
      });
    });

    it('should not create log directory if it already exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);

      new SessionFileLogger();

      expect(mkdirSync).not.toHaveBeenCalled();
    });

    it('should use custom path from config when set', () => {
      mockGetWsLogsPath.mockReturnValue('/custom/path/ws-logs');
      vi.mocked(existsSync).mockReturnValue(false);

      new SessionFileLogger();

      expect(mkdirSync).toHaveBeenCalledWith('/custom/path/ws-logs', { recursive: true });
    });

    it('should use default path from config when not customized', () => {
      mockGetWsLogsPath.mockReturnValue(defaultWsLogsPath);
      vi.mocked(existsSync).mockReturnValue(false);

      new SessionFileLogger();

      expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.context/ws-logs'), {
        recursive: true,
      });
    });

    it('should not create directory when disabled (non-dev mode)', () => {
      mockIsDevelopment.mockReturnValue(false);
      vi.mocked(existsSync).mockReturnValue(false);

      new SessionFileLogger();

      expect(mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('initSession', () => {
    it('should create log file with proper header', () => {
      const logger = new SessionFileLogger();

      logger.initSession('test-session-123');

      expect(mockCreateWriteStream).toHaveBeenCalledTimes(1);
      const [filePath] = mockCreateWriteStream.mock.calls[0];

      expect(filePath).toMatch(/test-session-123_.*\.log$/);
      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const headerContent = mockStream.writtenData[0];
      expect(headerContent).toContain('WebSocket Session Log');
      expect(headerContent).toContain('Session ID: test-session-123');
      expect(headerContent).toContain('Started:');
    });

    it('should be idempotent - calling twice does not create duplicate files', () => {
      const logger = new SessionFileLogger();

      logger.initSession('test-session-123');
      logger.initSession('test-session-123');

      expect(mockCreateWriteStream).toHaveBeenCalledTimes(1);
    });

    it('should sanitize session ID in filename', () => {
      const logger = new SessionFileLogger();

      logger.initSession('session/with:special*chars');

      const [filePath] = mockCreateWriteStream.mock.calls[0];
      expect(filePath).not.toContain('/with:');
      expect(filePath).not.toContain('*');
      expect(filePath).toMatch(/session_with_special_chars_.*\.log$/);
    });

    it('should allow multiple different sessions', () => {
      const logger = new SessionFileLogger();

      logger.initSession('session-1');
      logger.initSession('session-2');

      expect(mockCreateWriteStream).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when disabled', () => {
      mockIsDevelopment.mockReturnValue(false);
      const logger = new SessionFileLogger();

      logger.initSession('test-session');

      expect(mockCreateWriteStream).not.toHaveBeenCalled();
    });
  });

  describe('log', () => {
    it('should write formatted log entry to file', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'OUT_TO_CLIENT', { type: 'test', data: 'hello' });

      // Run pending setImmediate callbacks
      await vi.runAllTimersAsync();

      // Header + log entry
      expect(mockStream.write).toHaveBeenCalledTimes(2);
      const logContent = mockStream.writtenData[1];
      expect(logContent).toContain('>>> OUT->CLIENT');
      expect(logContent).toContain('type=test');
      expect(logContent).toContain('"data": "hello"');
    });

    it('should handle OUT_TO_CLIENT direction', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'OUT_TO_CLIENT', { type: 'message' });

      await vi.runAllTimersAsync();

      const logContent = mockStream.writtenData[1];
      expect(logContent).toContain('>>> OUT->CLIENT');
    });

    it('should handle IN_FROM_CLIENT direction', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'IN_FROM_CLIENT', { type: 'message' });

      await vi.runAllTimersAsync();

      const logContent = mockStream.writtenData[1];
      expect(logContent).toContain('<<< IN<-CLIENT');
    });

    it('should handle FROM_CLAUDE_CLI direction', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'FROM_CLAUDE_CLI', { type: 'message' });

      await vi.runAllTimersAsync();

      const logContent = mockStream.writtenData[1];
      expect(logContent).toContain('### FROM_CLI');
    });

    it('should handle INFO direction', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'INFO', { type: 'message' });

      await vi.runAllTimersAsync();

      const logContent = mockStream.writtenData[1];
      expect(logContent).toContain('*** INFO');
    });

    it('should do nothing if session is not initialized', async () => {
      const logger = new SessionFileLogger();

      logger.log('non-existent-session', 'OUT_TO_CLIENT', { type: 'test' });

      await vi.runAllTimersAsync();

      // No writes should have happened
      expect(mockStream.write).not.toHaveBeenCalled();
    });

    it('should extract summary info for claude_message type', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'OUT_TO_CLIENT', {
        type: 'claude_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool_use',
              name: 'read_file',
            },
          },
        },
      });

      await vi.runAllTimersAsync();

      const logContent = mockStream.writtenData[1];
      expect(logContent).toContain('type=claude_message');
      expect(logContent).toContain('inner_type=stream_event');
      expect(logContent).toContain('event_type=content_block_start');
      expect(logContent).toContain('block_type=tool_use');
      expect(logContent).toContain('tool=read_file');
    });

    it('should do nothing when disabled', async () => {
      mockIsDevelopment.mockReturnValue(false);
      const logger = new SessionFileLogger();

      logger.log('test-session', 'OUT_TO_CLIENT', { type: 'test' });

      await vi.runAllTimersAsync();

      expect(mockStream.write).not.toHaveBeenCalled();
    });
  });

  describe('closeSession', () => {
    it('should write footer to log file', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.closeSession('test-session');

      await vi.runAllTimersAsync();

      // Header + footer
      expect(mockStream.write).toHaveBeenCalledTimes(2);
      const footerContent = mockStream.writtenData[1];
      expect(footerContent).toContain('Session ended:');
      expect(footerContent).toContain('='.repeat(80));
    });

    it('should mark session as closed to prevent further logging', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.closeSession('test-session');

      // Try to log after closing - should do nothing (session marked as closed)
      logger.log('test-session', 'OUT_TO_CLIENT', { type: 'test' });

      await vi.runAllTimersAsync();

      // Only header + footer should be written
      expect(mockStream.write).toHaveBeenCalledTimes(2);
    });

    it('should do nothing if session does not exist', async () => {
      const logger = new SessionFileLogger();

      logger.closeSession('non-existent-session');

      await vi.runAllTimersAsync();

      // No writes should have happened
      expect(mockStream.write).not.toHaveBeenCalled();
    });

    it('should call stream.end() after flushing', async () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.closeSession('test-session');

      await vi.runAllTimersAsync();

      expect(mockStream.end).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should close all active sessions', async () => {
      // Create a fresh mock stream for each session
      const mockStreams: ReturnType<typeof createMockStream>[] = [];
      mockCreateWriteStream.mockImplementation(() => {
        const stream = createMockStream();
        mockStreams.push(stream);
        return stream;
      });

      const logger = new SessionFileLogger();
      logger.initSession('session-1');
      logger.initSession('session-2');
      logger.initSession('session-3');

      logger.cleanup();

      await vi.runAllTimersAsync();

      // All three sessions should have end called
      expect(mockStreams).toHaveLength(3);
      for (const stream of mockStreams) {
        expect(stream.end).toHaveBeenCalled();
      }
    });

    it('should handle empty session list', () => {
      const logger = new SessionFileLogger();

      // Should not throw
      expect(() => {
        logger.cleanup();
      }).not.toThrow();
    });
  });

  describe('cleanupOldLogs', () => {
    it('should delete files older than maxAgeDays', () => {
      const logger = new SessionFileLogger();
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

      vi.mocked(readdirSync).mockReturnValue(['old-session.log', 'recent-session.log'] as never[]);
      vi.mocked(statSync)
        .mockReturnValueOnce({ mtimeMs: eightDaysAgo } as ReturnType<typeof statSync>)
        .mockReturnValueOnce({ mtimeMs: now } as ReturnType<typeof statSync>);

      logger.cleanupOldLogs(7);

      expect(unlinkSync).toHaveBeenCalledTimes(1);
      expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining('old-session.log'));
    });

    it('should keep recent files', () => {
      const logger = new SessionFileLogger();
      const now = Date.now();
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

      vi.mocked(readdirSync).mockReturnValue(['recent-session.log'] as never[]);
      vi.mocked(statSync).mockReturnValue({ mtimeMs: twoDaysAgo } as ReturnType<typeof statSync>);

      logger.cleanupOldLogs(7);

      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('should use default maxAgeDays of 7', () => {
      const logger = new SessionFileLogger();
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
      const sixDaysAgo = now - 6 * 24 * 60 * 60 * 1000;

      vi.mocked(readdirSync).mockReturnValue(['old-session.log', 'recent-session.log'] as never[]);
      vi.mocked(statSync)
        .mockReturnValueOnce({ mtimeMs: eightDaysAgo } as ReturnType<typeof statSync>)
        .mockReturnValueOnce({ mtimeMs: sixDaysAgo } as ReturnType<typeof statSync>);

      logger.cleanupOldLogs();

      expect(unlinkSync).toHaveBeenCalledTimes(1);
    });

    it('should do nothing if log directory does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const logger = new SessionFileLogger();

      // Reset mocks after constructor
      vi.mocked(existsSync).mockReturnValue(false);

      logger.cleanupOldLogs(7);

      expect(readdirSync).not.toHaveBeenCalled();
      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('should handle individual file stat errors gracefully', () => {
      const logger = new SessionFileLogger();
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

      vi.mocked(readdirSync).mockReturnValue(['error-file.log', 'old-session.log'] as never[]);
      vi.mocked(statSync)
        .mockImplementationOnce(() => {
          throw new Error('Permission denied');
        })
        .mockReturnValueOnce({ mtimeMs: eightDaysAgo } as ReturnType<typeof statSync>);

      // Should not throw
      expect(() => {
        logger.cleanupOldLogs(7);
      }).not.toThrow();

      // Should still delete the second file
      expect(unlinkSync).toHaveBeenCalledTimes(1);
    });

    it('should handle readdirSync errors gracefully', () => {
      const logger = new SessionFileLogger();

      vi.mocked(readdirSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw
      expect(() => {
        logger.cleanupOldLogs(7);
      }).not.toThrow();
    });

    it('should handle unlinkSync errors gracefully', () => {
      const logger = new SessionFileLogger();
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

      vi.mocked(readdirSync).mockReturnValue(['old-session.log'] as never[]);
      vi.mocked(statSync).mockReturnValue({ mtimeMs: eightDaysAgo } as ReturnType<typeof statSync>);
      vi.mocked(unlinkSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw
      expect(() => {
        logger.cleanupOldLogs(7);
      }).not.toThrow();
    });

    it('should do nothing when disabled', () => {
      mockIsDevelopment.mockReturnValue(false);
      const logger = new SessionFileLogger();

      vi.mocked(readdirSync).mockReturnValue(['old-session.log'] as never[]);

      logger.cleanupOldLogs(7);

      expect(readdirSync).not.toHaveBeenCalled();
    });
  });
});
