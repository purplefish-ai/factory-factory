import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.service';

// Mock write stream that we can access in tests
const mockWriteStream = {
  write: vi.fn(),
  on: vi.fn(),
};

// Mock node:fs to prevent real file I/O during tests
vi.mock('node:fs', () => {
  return {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => mockWriteStream),
  };
});

// Helper type for testing circular references - allows dynamic property assignment
type CircularTestObject = Record<string, unknown>;

function lastLogEntry() {
  const calls = mockWriteStream.write.mock.calls;
  const lastCall = calls[calls.length - 1] as [string];
  return JSON.parse(lastCall[0].toString().trim());
}

describe('LoggerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('circular reference handling', () => {
    it('should not crash when logging a simple circular reference', () => {
      const logger = createLogger('test');
      const circular: CircularTestObject = { foo: 'bar' };
      circular.self = circular;

      expect(() => {
        logger.info('Test circular', circular);
      }).not.toThrow();
    });

    it('should not crash when logging nested circular references', () => {
      const logger = createLogger('test');
      const obj: CircularTestObject = { a: { b: { c: {} } } };
      (((obj.a as CircularTestObject).b as CircularTestObject).c as CircularTestObject).circular =
        obj;

      expect(() => {
        logger.warn('Test nested circular', obj);
      }).not.toThrow();
    });

    it('should not crash when logging an error with circular references', () => {
      const logger = createLogger('test');
      const circular: CircularTestObject = { message: 'error context' };
      circular.self = circular;

      expect(() => {
        logger.error('Test error with circular context', circular);
      }).not.toThrow();
    });

    it('should not crash when logging arrays with circular references', () => {
      // Set LOG_LEVEL to debug to ensure debug() actually logs
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'debug';

      try {
        const logger = createLogger('test');
        const arr: unknown[] = [1, 2, 3];
        arr.push(arr);

        expect(() => {
          logger.debug('Test circular array', { items: arr });
        }).not.toThrow();

        // Verify debug was actually called and logged
        expect(mockWriteStream.write).toHaveBeenCalled();
      } finally {
        // Restore original LOG_LEVEL
        if (originalLogLevel === undefined) {
          Reflect.deleteProperty(process.env, 'LOG_LEVEL');
        } else {
          process.env.LOG_LEVEL = originalLogLevel;
        }
      }
    });

    it('should not crash when logging cross-referenced objects', () => {
      const logger = createLogger('test');
      const obj1: CircularTestObject = { name: 'obj1' };
      const obj2: CircularTestObject = { name: 'obj2' };
      obj1.ref = obj2;
      obj2.ref = obj1;

      logger.info('Test cross-reference', { obj1, obj2 });

      // Verify the data is preserved, not silently dropped
      expect(mockWriteStream.write).toHaveBeenCalled();
      const calls = mockWriteStream.write.mock.calls;
      const lastCall = calls[calls.length - 1] as [string];
      const logEntry = JSON.parse(lastCall[0].toString().trim());

      // obj1 should have name and ref to obj2 (which has circular back-ref)
      expect(logEntry.context.obj1.name).toBe('obj1');
      expect(logEntry.context.obj1.ref.name).toBe('obj2');
      expect(logEntry.context.obj1.ref.ref).toBe('[Circular]');

      // obj2 should also have its full data preserved, not stale cache
      expect(logEntry.context.obj2.name).toBe('obj2');
      expect(logEntry.context.obj2.ref.name).toBe('obj1');
      expect(logEntry.context.obj2.ref.ref).toBe('[Circular]');
    });

    it('should still log normal objects correctly', () => {
      const logger = createLogger('test');
      const normalObj = {
        name: 'test',
        value: 42,
        nested: { deep: { data: 'hello' } },
      };

      expect(() => {
        logger.info('Test normal object', normalObj);
      }).not.toThrow();
    });

    it('should handle shared non-circular references correctly', () => {
      const logger = createLogger('test');
      const shared = { id: 1, name: 'shared' };
      const obj = {
        a: shared,
        b: shared, // Same object referenced twice - NOT circular
        c: { nested: shared }, // Same object in nested structure
      };

      logger.info('Test shared references', obj);

      // Verify the shared object appears correctly, not as [Circular]
      expect(mockWriteStream.write).toHaveBeenCalled();
      const calls = mockWriteStream.write.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const lastCall = calls[calls.length - 1] as [string];
      const logEntry = JSON.parse(lastCall[0].toString().trim());

      // All three references should contain the actual data, not [Circular]
      expect(logEntry.context.a).toEqual({ id: 1, name: 'shared' });
      expect(logEntry.context.b).toEqual({ id: 1, name: 'shared' });
      expect(logEntry.context.c.nested).toEqual({ id: 1, name: 'shared' });
    });

    it('should handle undefined and null in context', () => {
      const logger = createLogger('test');

      expect(() => {
        logger.info('Test undefined', { value: undefined });
      }).not.toThrow();

      expect(() => {
        logger.info('Test null', { value: null });
      }).not.toThrow();
    });

    it('should preserve toJSON() methods on objects like Date', () => {
      const logger = createLogger('test');
      const date = new Date('2024-01-01T00:00:00.000Z');
      const obj = {
        timestamp: date,
        nested: { createdAt: date },
      };

      logger.info('Test Date objects', obj);

      expect(mockWriteStream.write).toHaveBeenCalled();
      const calls = mockWriteStream.write.mock.calls;
      const lastCall = calls[calls.length - 1] as [string];
      const logEntry = JSON.parse(lastCall[0].toString().trim());

      // Dates should be serialized as ISO strings, not empty objects
      expect(logEntry.context.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(logEntry.context.nested.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should handle toJSON() that returns a circular structure', () => {
      const logger = createLogger('test');
      const circular: CircularTestObject = { data: 'value' };
      circular.self = circular;

      const obj = {
        custom: {
          toJSON() {
            return circular;
          },
        },
      };

      logger.info('Test toJSON circular', obj);

      expect(mockWriteStream.write).toHaveBeenCalled();
      const calls = mockWriteStream.write.mock.calls;
      const lastCall = calls[calls.length - 1] as [string];
      const logEntry = JSON.parse(lastCall[0].toString().trim());

      // toJSON result should be traversed and circular ref replaced
      expect(logEntry.context.custom.data).toBe('value');
      expect(logEntry.context.custom.self).toBe('[Circular]');
    });

    it('should handle toJSON() returning this without stack overflow', () => {
      const logger = createLogger('test');
      const obj = {
        name: 'self-returning',
        toJSON() {
          return this;
        },
      };

      logger.info('Test self-returning toJSON', { custom: obj });

      expect(mockWriteStream.write).toHaveBeenCalled();
      const calls = mockWriteStream.write.mock.calls;
      const lastCall = calls[calls.length - 1] as [string];
      const logEntry = JSON.parse(lastCall[0].toString().trim());

      // toJSON returns this -> detected as circular, replaced with placeholder
      expect(logEntry.context.custom).toBe('[Circular]');
    });

    it('should fall back to property traversal when toJSON() throws', () => {
      const logger = createLogger('test');
      const obj = {
        name: 'bad-toJSON',
        toJSON() {
          throw new Error('toJSON failed');
        },
      };

      logger.info('Test throwing toJSON', { custom: obj });

      expect(mockWriteStream.write).toHaveBeenCalled();
      const calls = mockWriteStream.write.mock.calls;
      const lastCall = calls[calls.length - 1] as [string];
      const logEntry = JSON.parse(lastCall[0].toString().trim());

      // Should fall back to property traversal, preserving the name field
      expect(logEntry.context.custom.name).toBe('bad-toJSON');
    });

    it('should emit valid JSON even when serialization fails unexpectedly', () => {
      const logger = createLogger('test');
      // A nested throwing getter aborts serialization of the whole context
      const obj = {
        nested: {
          get value(): never {
            throw new Error('getter failed');
          },
        },
      };

      logger.info('Test serialization error', obj);

      expect(mockWriteStream.write).toHaveBeenCalled();
      const calls = mockWriteStream.write.mock.calls;
      const lastCall = calls[calls.length - 1] as [string];
      const raw = lastCall[0].toString().trim();

      // Fallback should still be valid JSON, not [object Object]
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('should serialize BigInt values as strings', () => {
      const logger = createLogger('test');

      logger.info('Test BigInt', { value: BigInt(123), nested: { size: 2n ** 64n } });

      const logEntry = lastLogEntry();
      expect(logEntry.context.value).toBe('123');
      expect(logEntry.context.nested.size).toBe('18446744073709551616');
    });
  });

  describe('error serialization', () => {
    it('should preserve the message and stack of an Error in the context', () => {
      const logger = createLogger('test');
      const error = new Error('EPIPE: broken pipe');

      logger.info('Something failed', { error });

      const logEntry = lastLogEntry();
      expect(logEntry.context.error).toEqual({
        name: 'Error',
        message: 'EPIPE: broken pipe',
        stack: error.stack,
      });
    });

    it('should include own enumerable properties and the cause chain', () => {
      const logger = createLogger('test');
      const cause = Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' });
      const error = new Error('request failed', { cause });

      logger.info('Request failed', { error });

      const logEntry = lastLogEntry();
      expect(logEntry.context.error.message).toBe('request failed');
      expect(logEntry.context.error.cause).toMatchObject({
        name: 'TypeError',
        message: 'socket closed',
        code: 'ECONNRESET',
      });
    });

    it('should replace a self-referencing cause with a circular marker', () => {
      const logger = createLogger('test');
      const error = new Error('loop');
      error.cause = error;

      logger.info('Circular cause', { error });

      expect(lastLogEntry().context.error.cause).toBe('[Circular]');
    });
  });
});
