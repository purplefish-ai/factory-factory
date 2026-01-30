import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks are set up
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { SessionFileLogger } from './session-file-logger.service';

describe('SessionFileLogger', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env
    process.env = { ...originalEnv };
    process.env.WS_LOGS_PATH = undefined;

    // Default mocks
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(writeFileSync).mockReturnValue(undefined);
    vi.mocked(appendFileSync).mockReturnValue(undefined);
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(statSync).mockReturnValue({ mtimeMs: Date.now() } as ReturnType<typeof statSync>);
    vi.mocked(unlinkSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
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

    it('should use WS_LOGS_PATH env var when set', () => {
      process.env.WS_LOGS_PATH = '/custom/path/ws-logs';
      vi.mocked(existsSync).mockReturnValue(false);

      new SessionFileLogger();

      expect(mkdirSync).toHaveBeenCalledWith('/custom/path/ws-logs', { recursive: true });
    });

    it('should use default path when WS_LOGS_PATH is not set', () => {
      process.env.WS_LOGS_PATH = undefined;
      vi.mocked(existsSync).mockReturnValue(false);

      new SessionFileLogger();

      expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.context/ws-logs'), {
        recursive: true,
      });
    });
  });

  describe('initSession', () => {
    it('should create log file with proper header', () => {
      const logger = new SessionFileLogger();

      logger.initSession('test-session-123');

      expect(writeFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content] = vi.mocked(writeFileSync).mock.calls[0];

      expect(filePath).toMatch(/test-session-123_.*\.log$/);
      expect(content).toContain('WebSocket Session Log');
      expect(content).toContain('Session ID: test-session-123');
      expect(content).toContain('Started:');
    });

    it('should be idempotent - calling twice does not create duplicate files', () => {
      const logger = new SessionFileLogger();

      logger.initSession('test-session-123');
      logger.initSession('test-session-123');

      expect(writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('should sanitize session ID in filename', () => {
      const logger = new SessionFileLogger();

      logger.initSession('session/with:special*chars');

      const [filePath] = vi.mocked(writeFileSync).mock.calls[0];
      expect(filePath).not.toContain('/with:');
      expect(filePath).not.toContain('*');
      expect(filePath).toMatch(/session_with_special_chars_.*\.log$/);
    });

    it('should allow multiple different sessions', () => {
      const logger = new SessionFileLogger();

      logger.initSession('session-1');
      logger.initSession('session-2');

      expect(writeFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('log', () => {
    it('should write formatted log entry to file', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'OUT_TO_CLIENT', { type: 'test', data: 'hello' });

      expect(appendFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content] = vi.mocked(appendFileSync).mock.calls[0];

      expect(filePath).toMatch(/test-session.*\.log$/);
      expect(content).toContain('>>> OUT->CLIENT');
      expect(content).toContain('type=test');
      expect(content).toContain('"data": "hello"');
    });

    it('should handle OUT_TO_CLIENT direction', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'OUT_TO_CLIENT', { type: 'message' });

      const [, content] = vi.mocked(appendFileSync).mock.calls[0];
      expect(content).toContain('>>> OUT->CLIENT');
    });

    it('should handle IN_FROM_CLIENT direction', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'IN_FROM_CLIENT', { type: 'message' });

      const [, content] = vi.mocked(appendFileSync).mock.calls[0];
      expect(content).toContain('<<< IN<-CLIENT');
    });

    it('should handle FROM_CLAUDE_CLI direction', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'FROM_CLAUDE_CLI', { type: 'message' });

      const [, content] = vi.mocked(appendFileSync).mock.calls[0];
      expect(content).toContain('### FROM_CLI');
    });

    it('should handle INFO direction', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.log('test-session', 'INFO', { type: 'message' });

      const [, content] = vi.mocked(appendFileSync).mock.calls[0];
      expect(content).toContain('*** INFO');
    });

    it('should do nothing if session is not initialized', () => {
      const logger = new SessionFileLogger();

      logger.log('non-existent-session', 'OUT_TO_CLIENT', { type: 'test' });

      expect(appendFileSync).not.toHaveBeenCalled();
    });

    it('should extract summary info for claude_message type', () => {
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

      const [, content] = vi.mocked(appendFileSync).mock.calls[0];
      expect(content).toContain('type=claude_message');
      expect(content).toContain('inner_type=stream_event');
      expect(content).toContain('event_type=content_block_start');
      expect(content).toContain('block_type=tool_use');
      expect(content).toContain('tool=read_file');
    });

    it('should handle appendFileSync errors gracefully', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      vi.mocked(appendFileSync).mockImplementation(() => {
        throw new Error('Disk full');
      });

      // Should not throw
      expect(() => {
        logger.log('test-session', 'OUT_TO_CLIENT', { type: 'test' });
      }).not.toThrow();
    });
  });

  describe('closeSession', () => {
    it('should write footer to log file', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.closeSession('test-session');

      expect(appendFileSync).toHaveBeenCalledTimes(1);
      const [, content] = vi.mocked(appendFileSync).mock.calls[0];
      expect(content).toContain('Session ended:');
      expect(content).toContain('='.repeat(80));
    });

    it('should remove session from tracking', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      logger.closeSession('test-session');

      // Try to log after closing - should do nothing
      logger.log('test-session', 'OUT_TO_CLIENT', { type: 'test' });

      // Only the footer append should have happened, not the log
      expect(appendFileSync).toHaveBeenCalledTimes(1);
    });

    it('should do nothing if session does not exist', () => {
      const logger = new SessionFileLogger();

      logger.closeSession('non-existent-session');

      expect(appendFileSync).not.toHaveBeenCalled();
    });

    it('should handle appendFileSync errors gracefully on close', () => {
      const logger = new SessionFileLogger();
      logger.initSession('test-session');

      vi.mocked(appendFileSync).mockImplementation(() => {
        throw new Error('Disk full');
      });

      // Should not throw
      expect(() => {
        logger.closeSession('test-session');
      }).not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should close all active sessions', () => {
      const logger = new SessionFileLogger();
      logger.initSession('session-1');
      logger.initSession('session-2');
      logger.initSession('session-3');

      logger.cleanup();

      // All three sessions should have footers written
      expect(appendFileSync).toHaveBeenCalledTimes(3);
    });

    it('should handle empty session list', () => {
      const logger = new SessionFileLogger();

      // Should not throw
      expect(() => {
        logger.cleanup();
      }).not.toThrow();

      expect(appendFileSync).not.toHaveBeenCalled();
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
  });
});
